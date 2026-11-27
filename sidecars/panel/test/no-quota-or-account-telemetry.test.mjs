import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendHarness } from './backend-harness.mjs';

test('zero-quota & zero-account telemetry: no RetrieveUserQuotaSummary calls, no user PII leakage, consumption.account preserved', async () => {
  const nowMs = Date.now();
  const createdAt = new Date(nowMs - 8_000).toISOString();
  const completedAt = new Date(nowMs - 2_000).toISOString();

  const h = backendHarness({
    clock: () => nowMs,
    userStatus: {
      email: 'secret-user@example.com',
      name: 'Secret Tester',
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
      planStatus: {
        planInfo: { planName: 'Pro Plan' },
        availablePromptCredits: 999,
      },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M999' },
            modelId: 'gemini-4-preview',
            label: 'Gemini 4 Preview (High)',
            quotaInfo: {
              remainingFraction: 0.42,
              resetTime: '2099-01-01T00:00:00Z',
            },
          },
        ],
      },
    },
    trajectories: {
      'conv-1': {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                sourceTrajectoryStepInfo: { stepIndex: 1 },
                createdAt,
                completedAt,
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M999',
                  inputTokens: '12000',
                  cacheReadTokens: '4000',
                  outputTokens: '600',
                },
              },
              plannerResponse: { response: 'hello local telemetry' },
            },
          ],
          generatorMetadata: [],
        },
      },
    },
    summaries: {
      'conv-1': {
        stepCount: 1,
        lastModifiedTime: completedAt,
        status: 'CASCADE_RUN_STATUS_IDLE',
      },
    },
  });

  // 1. Force full telemetry build & lightweight conversation switch
  const fullPayload = await h.buildTelemetryPayloadInternal('conv-1', true, { range: 'today' });
  const convRes = await h.executeTelemetryAction({
    conversationId: 'conv-1',
    scope: 'conversation',
    range: 'today',
  });
  const convPayload = JSON.parse(convRes.body);
  const cliSnapshot = h.buildCliStatusSnapshot(fullPayload, nowMs);

  // Never calls RetrieveUserQuotaSummary
  assert.equal(h.state.calls.filter((c) => c.method === 'RetrieveUserQuotaSummary').length, 0);

  // Zero top-level account/quotas objects in telemetry or CLI snapshot
  assert.equal(fullPayload.account, undefined);
  assert.equal(fullPayload.quotas, undefined);
  assert.equal(convPayload.account, undefined);
  assert.equal(convPayload.quotas, undefined);
  assert.equal(cliSnapshot.quotas, undefined);

  // Zero mock user PII / quotaInfo leakage anywhere in serialized output
  const leakedTokens = [
    'secret-user@example.com',
    'Secret Tester',
    'g1-pro-tier',
    'Google AI Pro',
    'Pro Plan',
    'remainingFraction',
    '2099-01-01T00:00:00Z',
  ];
  const fullJson = JSON.stringify(fullPayload);
  const cliJson = JSON.stringify(cliSnapshot);
  for (const secret of leakedTokens) {
    assert.equal(fullJson.includes(secret), false, `Telemetry payload must not leak "${secret}"`);
    assert.equal(cliJson.includes(secret), false, `CLI snapshot must not leak "${secret}"`);
  }

  // Model placeholder resolution still works without retaining quotaInfo
  const dynMap = h.buildDynamicModelMap([
    {
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M999' },
      modelId: 'gemini-4-preview',
      label: 'Gemini 4 Preview (High)',
      quotaInfo: { remainingFraction: 0.42, resetTime: '2099-01-01T00:00:00Z' },
    },
  ]);
  assert.deepEqual(
    { ...dynMap.get('MODEL_PLACEHOLDER_M999') },
    {
      modelId: 'gemini-4-preview',
      label: 'Gemini 4 Preview (High)',
    }
  );
  assert.equal(fullPayload.activeConversation.activeModelUpstream, 'gemini-4-preview');

  // Local consumption.account aggregate bucket remains intact
  assert.equal(fullPayload.consumption.account.calls, 1);
  assert.equal(fullPayload.consumption.account.totalTokens, 16_600);
});

test('static runtime audit: zero quota RPC, credential store, or account UI tokens and 100% i18n parity', async () => {
  const panelRoot = fileURLToPath(new URL('..', import.meta.url));
  const targetFiles = [
    join(panelRoot, 'main.mjs'),
    join(panelRoot, 'standalone.mjs'),
    join(panelRoot, 'bridge-daemon.mjs'),
    join(panelRoot, 'cli-statusline.mjs'),
  ];
  const walkJs = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walkJs(p);
      else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs')) targetFiles.push(p);
    }
  };
  walkJs(join(panelRoot, 'backend'));
  walkJs(join(panelRoot, 'shared'));
  walkJs(join(panelRoot, 'src'));

  const bannedRuntimeTokens = [
    'RetrieveUserQuotaSummary',
    'getOfficialQuotaSummary',
    'quota-pools.mjs',
    'buildOfficialQuotaPools',
    'state.vscdb',
    'DPAPI',
    'settings.account.',
  ];
  for (const filePath of targetFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const token of bannedRuntimeTokens) {
      assert.equal(
        content.includes(token),
        false,
        `Runtime file ${filePath} must not contain "${token}"`
      );
    }
  }

  const { I18N_MESSAGES_ZH_CN } = await import('../src/i18n/zh-CN.js');
  const { I18N_MESSAGES_EN_US } = await import('../src/i18n/en-US.js');
  const zhKeys = new Set(Object.keys(I18N_MESSAGES_ZH_CN));
  const enKeys = new Set(Object.keys(I18N_MESSAGES_EN_US));
  assert.deepEqual([...zhKeys].filter((k) => !enKeys.has(k)), []);
  assert.deepEqual([...enKeys].filter((k) => !zhKeys.has(k)), []);

  const srcFiles = [];
  const walkSrc = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walkSrc(p);
      else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs')) srcFiles.push(p);
    }
  };
  walkSrc(join(panelRoot, 'src'));
  for (const filePath of srcFiles) {
    const text = fs.readFileSync(filePath, 'utf8');
    const re = /(?<![.\w])t\(\s*(['"])([^'"]+)\1/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      assert.ok(zhKeys.has(m[2]), `Missing zh-CN i18n key "${m[2]}" in ${filePath}`);
      assert.ok(enKeys.has(m[2]), `Missing en-US i18n key "${m[2]}" in ${filePath}`);
    }
  }
});
