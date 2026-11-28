import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReleaseRuntimeFiles, DEFAULT_REPO_ROOT } from '../scripts/pack-release-zip.mjs';
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

  // Legacy cached step.accountName PII from older schema-v1 SQLite/JSON caches must never leak into telemetry
  const legacyHarness = backendHarness({
    clock: () => nowMs,
    cache: {
      'conv-legacy': {
        signature: `1:${completedAt}`,
        accountName: 'legacy-pii@example.com',
        title: 'Legacy cached session',
        lastModifiedMs: nowMs - 2_000,
        rawStepCount: 1,
        contextLimitTelemetry: true,
        speedClearedTelemetry: true,
        timingTelemetry: true,
        wakeupTurnTelemetry: true,
        contextGroupsTelemetry: 3,
        anomalyTelemetry: 1,
        imageGenTelemetry: 1,
        steps: [
          {
            stepIndex: 1,
            createdAtMs: nowMs - 8_000,
            isComplete: true,
            modelKey: 'MODEL_PLACEHOLDER_M999',
            inputTokens: 12_000,
            cacheReadTokens: 4_000,
            outputTokens: 600,
            accountName: 'legacy-pii@example.com',
          },
        ],
      },
    },
    summaries: {
      'conv-legacy': {
        stepCount: 1,
        lastModifiedTime: completedAt,
        status: 'CASCADE_RUN_STATUS_IDLE',
      },
    },
  });
  const legacyFull = await legacyHarness.buildTelemetryPayloadInternal('conv-legacy', false, { range: 'today' });
  const legacyConvRes = await legacyHarness.executeTelemetryAction({
    conversationId: 'conv-legacy',
    scope: 'conversation',
    range: 'today',
  });
  assert.equal(JSON.stringify(legacyFull).includes('legacy-pii@example.com'), false);
  assert.equal(legacyConvRes.body.includes('legacy-pii@example.com'), false);
  assert.equal(Object.hasOwn(legacyFull.activeConversation.recentSteps[0], 'accountName'), false);
});

test('static runtime audit excludes removed interception, quota and account features and checks i18n parity', async () => {
  const panelRoot = fileURLToPath(new URL('..', import.meta.url));
  const srcJsFiles = [];
  const srcCssFiles = [];
  const walkSrc = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walkSrc(p);
      else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs')) srcJsFiles.push(p);
      else if (ent.name.endsWith('.css')) srcCssFiles.push(p);
    }
  };
  walkSrc(join(panelRoot, 'src'));
  const runtimeFiles = collectReleaseRuntimeFiles(DEFAULT_REPO_ROOT).map((rel) =>
    join(DEFAULT_REPO_ROOT, rel)
  );

  const bannedRuntimeTokens = [
    'RetrieveUserQuotaSummary',
    'getOfficialQuotaSummary',
    'quota-pools.mjs',
    'buildOfficialQuotaPools',
    'state.vscdb',
    'DPAPI',
    'settings.account.',
    '/api/accounts',
    'cloudcode-proxy.mjs',
    'SetCloudCodeURL',
    'context-windows.mjs',
    '/api/context-window',
    'fetchWithContextWindow',
    'sendWithContextWindow',
    'syncHostContextWindows',
    'modelContextWindows',
    'cloudCodeProxy',
    'GetAvailableModels',
    '__AGUsageMonitorContextWindows',
    'wm-seg-quota',
    'wm-sep-quota',
    '--quota-reserved',
  ];
  for (const filePath of [...runtimeFiles, ...srcJsFiles, ...srcCssFiles]) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const token of bannedRuntimeTokens) {
      assert.equal(
        filePath.includes(token) || content.includes(token),
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

  for (const filePath of srcJsFiles) {
    const text = fs.readFileSync(filePath, 'utf8');
    const re = /(?<![.\w])t\(\s*(['"])([^'"]+)\1/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      assert.ok(zhKeys.has(m[2]), `Missing zh-CN i18n key "${m[2]}" in ${filePath}`);
      assert.ok(enKeys.has(m[2]), `Missing en-US i18n key "${m[2]}" in ${filePath}`);
    }
  }
});
