import test from 'node:test';
import assert from 'node:assert/strict';
import { isEquivalentTelemetry } from '../src/store/telemetryStore.js';
import {
  estimateImageGenStepUsage,
  extractModelSteps,
  normalizeCachedStep,
  MODEL_IDENTITY_VERSION,
} from '../trajectory-metrics.mjs';
import {
  formatLiveActivityLabel,
  formatUsd,
  mergeModelsByDisplayName,
  resolveModelDisplayInfo,
} from '../src/core/formatters.js';
import { buildStepsMarkdownReport } from '../src/core/reportExporter.js';
import { i18nStore, setI18nLanguage } from '../src/i18n/index.js';
import { backendHarness } from './backend-harness.mjs';

const FLASH = 'MODEL_PLACEHOLDER_M318', ARGON = 'MODEL_PLACEHOLDER_M418';
const PROMO_CLOCK_MS = Date.parse('2026-11-17T12:00:20Z');
const createdAtMs = PROMO_CLOCK_MS - 20_000;
function step(index, model, checkpoint = false) {
  return { type: checkpoint ? 'CORTEX_STEP_TYPE_CHECKPOINT' : 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE', metadata: {
      sourceTrajectoryStepInfo: { stepIndex: index },
      createdAt: new Date(createdAtMs).toISOString(), completedAt: new Date(createdAtMs + 10_000).toISOString(),
      modelUsage: { ...(model === undefined ? {} : { model }), apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        inputTokens: '1000', cacheReadTokens: '9000', outputTokens: '1000' },
    } };
}
async function payload(steps, options = {}) {
  return backendHarness({ clock: () => PROMO_CLOCK_MS, summaries: { test: { stepCount: steps.length } },
    trajectories: { test: { trajectory: { steps } } }, ...options }).buildTelemetryPayloadInternal('test');
}

test('missing checkpoint identity infers model and pricing from neighbouring steps', async () => {
  const rows = [step(209, FLASH), step(211, undefined, true), step(212, FLASH)];
  const raw = {
    trajectory: {
      steps: rows,
      generatorMetadata: [
        { stepIndices: [209], chatModel: { model: FLASH, responseModel: 'gemini-3.8-flash-n' } },
        { stepIndices: [212], chatModel: { model: FLASH, responseModel: 'gemini-3.8-flash-n' } },
      ],
    },
  };
  const p = await payload(rows, { trajectories: { test: raw } });
  const cp = p.activeConversation.recentSteps.find(s => s.stepIndex === 211);
  assert.equal(cp.modelKey, FLASH);
  assert.equal(cp.modelSource, 'inferred_compaction');
  assert.equal(cp.modelShort, 'flash-3.8-high·压缩');
  assert.equal(cp.responseModel, 'gemini-3.8-flash-n');
  assert.equal(cp.modelUpstream, 'gemini-3.8-flash-n·压缩');
  assert.equal(cp.costUsd, 0.0052);
  assert.equal(cp.inCostUsd, 0.0008);
  assert.equal(cp.contextTokens, 11000);
  assert.equal(cp.tokPerSec, 100);
  assert.equal(p.activeConversation.speedSummary.sampleCount, 2);
  assert.equal(p.consumption.account.totalTokens, 33000);
  assert.equal(p.consumption.account.unpricedCalls, 0);
  assert.equal(p.modelBreakdown.find(m => m.shortName === 'flash-3.8-high').calls, 3);
  assert(!p.modelBreakdown.some(m => /argon/i.test(m.label)));
});

test('isolated checkpoint without known neighbours stays unknown; its token totals survive', async () => {
  const rows = [step(211, undefined, true)];
  const p = await payload(rows);
  const cp = p.activeConversation.recentSteps.find(s => s.stepIndex === 211);
  assert.equal(cp.modelKey, 'unknown'); assert.equal(cp.modelShort, '模型未知·压缩');
  assert.equal(cp.costUsd, null); assert.equal(cp.inCostUsd, null);
  assert.equal(cp.contextTokens, 11000); assert.equal(cp.tokPerSec, 100);
  assert.equal(p.activeConversation.speedSummary.sampleCount, 0);
  assert.equal(p.consumption.account.totalTokens, 11000);
  assert.equal(p.consumption.account.unpricedCalls, 1);
  assert.equal(p.modelBreakdown.find(m => m.label === '模型未知').unpricedCalls, 1);
  assert.equal(p.consumption.trendSeries.reduce((n,s) => n+(s.unpricedCalls || 0),0), 1);
  assert.equal(p.consumption.sourcesBreakdown[0].unpricedCalls, 1);
  assert.equal(p.consumption.monthlySeries.reduce((n,s) => n+(s.unpricedCalls || 0),0), 1);
});

test('checkpoint can explicitly use a different model; no neighbour-based overwrite', async () => {
  const p = await payload([step(209, FLASH), step(211, ARGON, true), step(212, FLASH)]);
  const cp = p.activeConversation.recentSteps.find(s => s.stepIndex === 211);
  assert.equal(cp.modelShort, 'argon-4·压缩'); assert.equal(cp.modelSource, 'usage.model');
  assert.equal(cp.costUsd, 0.0129); assert.equal(p.consumption.account.unpricedCalls, 0);
});

test('ordinary calls with missing model are unknown too', () => {
  const [s] = extractModelSteps([step(1)]);
  assert.equal(s.modelKey, 'unknown'); assert.equal(s.modelSource, 'unavailable');
  assert.equal(s.totalTokPerSec, 100);
});

test('retry usage preserves its own model and counters', () => {
  const row = step(211, FLASH, true);
  row.metadata.retryInfos = [{ usage: row.metadata.modelUsage }]; delete row.metadata.modelUsage;
  const [s] = extractModelSteps([row]);
  assert.equal(s.modelKey, FLASH); assert.equal(s.inputTokens, 1000);
});

test('matching generator usage supplies model and wins over requested generator model', () => {
  const [s] = extractModelSteps([step(211)], [{stepIndices: [211], chatModel: {
    usage: { model: FLASH }, model: ARGON,
  }}]);
  assert.equal(s.modelKey, FLASH); assert.equal(s.modelSource, 'chat.usage.model');
});

test('unrelated generator metadata never supplies the missing model', () => {
  const [s] = extractModelSteps([step(211)], [{stepIndices: [0], chatModel: {model: FLASH}}]);
  assert.equal(s.modelKey, 'unknown');
});

test('unspecified enum values fall through to actual step model evidence', () => {
  for (const missing of ['', ' ', 'unknown', 'MODEL_UNSPECIFIED', 'MODEL_UNKNOWN', '0', 0, null]) {
    const row = step(211, missing); row.metadata.generatorModel = FLASH;
    const [s] = extractModelSteps([row]); assert.equal(s.modelKey, FLASH);
  }
});

test('response model and display name are preserved when enum model is absent', async () => {
  const row = step(211);
  const raw = {trajectory: { steps: [row], generatorMetadata: [{stepIndices:[211],chatModel:{
    responseModel:'gemini-3.8-flash-high',modelDisplayName:'Gemini 3.8 Flash (High)',
  }}]}};
  const p = await payload([], {trajectories: {test:raw}});
  assert.equal(p.activeConversation.activeModelShort,'flash-3.8-high');
});

test('upstream responseModel is preserved alongside placeholder modelKey for StepsDetailView', async () => {
  const row = step(211, FLASH);
  const raw = {trajectory: { steps: [row], generatorMetadata: [{stepIndices:[211],chatModel:{
    model: FLASH,
    responseModel: 'gemini-3.8-flash-n',
  }}]}};
  const p = await payload([], {trajectories: {test:raw}});
  const st = p.activeConversation.recentSteps[0];
  assert.equal(st.modelKey, FLASH);
  assert.equal(st.modelShort, 'flash-3.8-high');
  assert.equal(st.responseModel, 'gemini-3.8-flash-n');
  assert.equal(st.modelUpstream, 'gemini-3.8-flash-n');
  assert.equal(p.modelBreakdown[0].upstreamName, 'gemini-3.8-flash-n');
});

test('server model catalog overrides static placeholder mapping', () => {
  const {resolveModelInfo} = backendHarness({ clock: () => PROMO_CLOCK_MS });
  const result = resolveModelInfo(ARGON, new Map([[ARGON, {modelId:'gemini-3.8-flash-high', label:'Gemini 3.8 Flash (High)'}]]));
  assert.equal(result.shortName,'flash-3.8-high'); assert.equal(result.pricing.input,0.75);
});

test('uncatalogued model keeps identity and does not borrow another model price', async () => {
  const p = await payload([step(211, 'MODEL_PLACEHOLDER_M999')]);
  assert.equal(p.activeConversation.activeModelShort,'MODEL_PLACEHOLDER_M999');
  assert.equal(p.activeConversation.latestStepCostUsd,null);
  assert.equal(p.consumption.account.unpricedCalls,1);
});

test('old ambiguous Argon cache is persisted as unresolved while retaining modern measurements', async () => {
  const original = extractModelSteps([step(211, ARGON, true)])[0];
  delete original.modelIdentityVersion; delete original.modelSource;
  const old = {signature:'v9-unified-throughput:old',steps:[original]};
  const h = backendHarness({cache:{test:old},trajectories:{test:new Error('offline')}});
  const p = await h.buildTelemetryPayloadInternal('test');
  const s = p.activeConversation.recentSteps[0];
  assert.equal(s.modelKey,'unknown'); assert.equal(s.legacyModelKey,ARGON);
  assert.equal(s.modelSource,'legacy_unverified'); assert.equal(s.totalTokPerSec,100);
  assert.equal(p.consumption.account.totalTokens,11000);
  assert.equal(p.consumption.account.unpricedCalls,1);
  assert.equal(h.state.saves.length,1);
  await h.buildTelemetryPayloadInternal('test');
  assert.equal(h.state.saves.length,1,'do not rewrite identical migrated cache every poll');
  h.state.trajectories.test = {trajectory:{steps:[step(211,FLASH,true)]}};
  const restored = await h.buildTelemetryPayloadInternal('test', true);
  assert.equal(restored.activeConversation.activeModelShort,'flash-3.8-high·压缩');
  assert.equal(restored.consumption.account.unpricedCalls,0);
});

test('explicit historical models and verified real Argon identities survive cache load', () => {
  const known = extractModelSteps([step(211, ARGON)])[0];
  assert.equal(normalizeCachedStep(known).modelKey,ARGON);
  const flash = {...known,modelKey:FLASH}; delete flash.modelIdentityVersion;
  assert.equal(normalizeCachedStep(flash).modelKey,FLASH);
  assert.equal(normalizeCachedStep(flash).modelIdentityVersion, MODEL_IDENTITY_VERSION);
});

test('empty session does not invent an Argon model or expose quota telemetry', async () => {
  const p = await backendHarness().buildTelemetryPayloadInternal('test');
  assert.equal(p.activeConversation.activeModelShort,'模型未知');
  assert.equal(p.quotas,undefined); assert.equal(p.account,undefined);
});

test('unknown single-step cost renders as pending while aggregate subtotals omit pending suffix', (t) => {
  const prevLocale = i18nStore.getState().locale;
  setI18nLanguage('zh-CN');
  t.after(() => setI18nLanguage(prevLocale));
  assert.equal(formatUsd(null),'待定'); assert.equal(formatUsd(0),'$0.00');
  assert.equal(formatUsd(0.1,{unpricedCalls:1}),'$0.10');
});

test('unpriced steps remain tracked in local consumption without quota fields', async () => {
  const p = await payload([step(211)]);
  assert.equal(p.consumption.account.unpricedCalls, 1);
  assert.equal(p.quotas, undefined); assert.equal(p.account, undefined);
});

test('frontend considers a model-only correction a real telemetry update', () => {
  const a={activeConversation:{recentSteps:[{modelKey:'unknown',modelShort:'模型未知',costUsd:null}]}};
  const b=structuredClone(a); b.activeConversation.recentSteps[0].modelShort='new-model';
  assert.equal(isEquivalentTelemetry(a,b),false); assert.equal(isEquivalentTelemetry(a,structuredClone(a)),true);
});

const ORCH_CARBON = 'MODEL_PLACEHOLDER_M667';
const ORCH_ARGON = 'MODEL_PLACEHOLDER_M681';
const ORCH_NEON = 'MODEL_PLACEHOLDER_M537';
const ORCH_EXEC_HYDROGEN = 'MODEL_PLACEHOLDER_M669';

test('Orchestrator (Carbon) direct/planning and inferred compaction steps resolve to orch-carbon and annotate upstream ID', async () => {
  const rows = [step(1, ORCH_CARBON), step(2, undefined, true), step(3, ORCH_CARBON)];
  const raw = {
    trajectory: {
      steps: rows,
      generatorMetadata: [
        {
          stepIndices: [1],
          chatModel: {
            model: ORCH_CARBON,
            responseModel: 'gemini-pro-orchestrator',
            modelDisplayName: 'Orchestrator (Carbon)',
          },
          plannerConfig: {
            planModel: ORCH_CARBON,
            modelName: 'gemini-pro-orchestrator',
            planExecuteConfig: { executionModel: ORCH_EXEC_HYDROGEN },
          },
        },
        {
          stepIndices: [3],
          chatModel: {
            model: ORCH_CARBON,
            responseModel: 'gemini-pro-orchestrator',
            modelDisplayName: 'Orchestrator (Carbon)',
          },
        },
      ],
    },
  };
  const p = await payload(rows, { trajectories: { test: raw } });
  const s1 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 1);
  const cp = p.activeConversation.recentSteps.find((s) => s.stepIndex === 2);

  assert.equal(s1.modelShort, 'orch-carbon');
  assert.equal(s1.modelUpstream, 'gemini-pro-orchestrator (carbon-4)');
  assert.equal(s1.costUsd, 0.0129);
  assert.equal(cp.modelKey, ORCH_CARBON);
  assert.equal(cp.modelSource, 'inferred_compaction');
  assert.equal(cp.modelShort, 'orch-carbon·压缩');
  assert.equal(cp.modelUpstream, 'gemini-pro-orchestrator (carbon-4)·压缩');
  assert.equal(p.activeConversation.activeModelShort, 'orch-carbon');
  assert.equal(p.activeConversation.activeModelUpstream, 'gemini-pro-orchestrator (carbon-4)');
  assert.equal(p.consumption.account.unpricedCalls, 0);
  assert.equal(p.modelBreakdown.length, 1);
  assert.equal(p.modelBreakdown[0].label, 'Orchestrator (Carbon)');
  assert.equal(p.modelBreakdown[0].upstreamName, 'gemini-pro-orchestrator (carbon-4)');
  assert.equal(p.modelBreakdown[0].calls, 3);
});

test('Orchestrator (Argon) resolves to orch-argon, annotates upstream ID, and is not misclassified as Carbon', async () => {
  const h = backendHarness({
    clock: () => PROMO_CLOCK_MS,
    summaries: { test: { stepCount: 1 } },
    trajectories: {
      test: {
        trajectory: {
          steps: [step(1, ORCH_ARGON)],
          generatorMetadata: [
            {
              stepIndices: [1],
              chatModel: {
                model: ORCH_ARGON,
                responseModel: 'gemini-pro-orchestrator-argon',
                modelDisplayName: 'Orchestrator (Argon)',
              },
            },
          ],
        },
      },
    },
  });

  const p = await h.buildTelemetryPayloadInternal('test');
  const s1 = p.activeConversation.recentSteps[0];
  assert.equal(s1.modelShort, 'orch-argon');
  assert.equal(s1.modelUpstream, 'gemini-pro-orchestrator-argon (argon-4)');
  assert.equal(s1.costUsd, 0.0129);
  assert.equal(p.modelBreakdown[0].label, 'Orchestrator (Argon)');
  assert.equal(p.modelBreakdown[0].upstreamName, 'gemini-pro-orchestrator-argon (argon-4)');
  assert.equal(h.isArgonModelIdentifier(ORCH_ARGON, 'gemini-pro-orchestrator-argon', 'Orchestrator (Argon)'), true);
  assert.equal(h.isCarbonModelIdentifier(ORCH_ARGON, 'gemini-pro-orchestrator-argon', 'Orchestrator (Argon)'), false);
});

test('Orchestrator (Neon) resolves to orch-neon, annotates upstream ID, uses Neon pricing, and is not misclassified as Carbon', async () => {
  const rows = [step(1, ORCH_NEON), step(2, ORCH_EXEC_HYDROGEN)];
  const h = backendHarness({
    clock: () => PROMO_CLOCK_MS,
    summaries: { test: { stepCount: 2 } },
    trajectories: {
      test: {
        trajectory: {
          steps: rows,
          generatorMetadata: [
            {
              stepIndices: [1],
              chatModel: {
                model: ORCH_NEON,
                responseModel: 'gemini-pro-orchestrator-neon',
                modelDisplayName: 'Orchestrator (Neon)',
              },
              plannerConfig: {
                planModel: ORCH_NEON,
                modelName: 'gemini-pro-orchestrator-neon',
                planExecuteConfig: { executionModel: ORCH_EXEC_HYDROGEN },
              },
            },
            {
              stepIndices: [2],
              chatModel: {
                model: ORCH_EXEC_HYDROGEN,
                responseModel: 'gemini-flash-worker-agy',
                modelDisplayName: 'Gemini Flash',
              },
            },
          ],
        },
      },
    },
  });

  const p = await h.buildTelemetryPayloadInternal('test');
  const s1 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 1);
  const s2 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 2);
  assert.equal(s1.modelShort, 'orch-neon');
  assert.equal(s1.modelLabel, 'Orchestrator (Neon)');
  assert.equal(s1.modelUpstream, 'gemini-pro-orchestrator-neon (neon-4)');
  // step() fixture: 1000 input ($3/M = 0.003) + 9000 cache ($0.15/M = 0.00135) + 1000 output ($15/M = 0.015) = 0.01935 -> 0.0193 (4-decimal payload rounding)
  assert.equal(s1.costUsd, 0.0193);
  assert.equal(s2.modelShort, 'hydrogen-4');
  assert.equal(s2.modelLabel, 'Orchestrator Worker (Hydrogen)');
  assert.equal(s2.modelUpstream, 'gemini-flash-worker-agy (hydrogen-4)');

  const neonRow = p.modelBreakdown.find((m) => m.label === 'Orchestrator (Neon)');
  assert.ok(neonRow, 'modelBreakdown keeps Orchestrator (Neon) separate');
  assert.equal(neonRow.upstreamName, 'gemini-pro-orchestrator-neon (neon-4)');
  assert.equal(h.isNeonModelIdentifier(ORCH_NEON, 'gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'), true);
  assert.equal(h.isCarbonModelIdentifier(ORCH_NEON, 'gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'), false);
  assert.equal(h.isCarbonModelIdentifier(ORCH_NEON, 'gemini-pro-orchestrator', 'Orchestrator (Neon)'), false);
  assert.equal(h.isArgonModelIdentifier(ORCH_NEON, 'gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'), false);

  // Pure placeholder lookup without modelDisplayName / responseModel
  const neonOrchInfo = h.resolveModelInfo(ORCH_NEON);
  assert.equal(neonOrchInfo.shortName, 'orch-neon');
  assert.equal(neonOrchInfo.label, 'Orchestrator (Neon)');
  assert.equal(neonOrchInfo.pricing.input, 3.0);
  assert.equal(neonOrchInfo.pricing.output, 15.0);

  const neonXhighInfo = h.resolveModelInfo('MODEL_PLACEHOLDER_M535');
  assert.equal(neonXhighInfo.shortName, 'neon-4-xhigh');
  assert.equal(neonXhighInfo.baseLabel, 'Gemini 4 Neon');
  assert.equal(neonXhighInfo.pricing.input, 3.0);
  assert.equal(neonXhighInfo.pricing.output, 15.0);
});

test('future uncatalogued Orchestrator variants never fall back to Carbon identity, pricing, or display', async () => {
  const FUTURE_ORCH_1 = 'MODEL_PLACEHOLDER_M991';
  const FUTURE_ORCH_2 = 'MODEL_PLACEHOLDER_M992';
  const rows = [step(1, FUTURE_ORCH_1), step(2, FUTURE_ORCH_2)];
  const h = backendHarness({
    clock: () => PROMO_CLOCK_MS,
    summaries: { test: { stepCount: 2 } },
    trajectories: {
      test: {
        trajectory: {
          steps: rows,
          generatorMetadata: [
            {
              stepIndices: [1],
              chatModel: {
                model: FUTURE_ORCH_1,
                responseModel: 'gemini-pro-orchestrator-xenon',
                modelDisplayName: 'Orchestrator (Xenon)',
              },
            },
            {
              stepIndices: [2],
              chatModel: {
                model: FUTURE_ORCH_2,
                responseModel: 'gemini-pro-orchestrator',
                modelDisplayName: 'Orchestrator (Helium)',
              },
            },
          ],
        },
      },
    },
  });

  const p = await h.buildTelemetryPayloadInternal('test');
  const s1 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 1);
  const s2 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 2);

  // Neither future variant may be misclassified as Carbon, given Carbon pricing, or stamped (carbon-4)
  assert.equal(h.isCarbonModelIdentifier(FUTURE_ORCH_1, 'gemini-pro-orchestrator-xenon', 'Orchestrator (Xenon)'), false);
  assert.equal(h.isCarbonModelIdentifier(FUTURE_ORCH_2, 'gemini-pro-orchestrator', 'Orchestrator (Helium)'), false);
  assert.equal(s1.costUsd, null);
  assert.equal(s2.costUsd, null);
  assert.equal(s1.modelUpstream, 'gemini-pro-orchestrator-xenon');
  assert.equal(s2.modelUpstream, 'gemini-pro-orchestrator');
  assert.notEqual(s1.modelShort, 'orch-carbon');
  assert.notEqual(s2.modelShort, 'orch-carbon');

  // Frontend dynamically renders orchestrator-<variant> without silently falling back to orchestrator-carbon
  assert.equal(resolveModelDisplayInfo(s1, { orchestratorIdMode: 'compact' }).text, 'orchestrator-xenon');
  assert.equal(resolveModelDisplayInfo(s1, { orchestratorIdMode: 'full' }).text, 'gemini-pro-orchestrator-xenon');
  assert.equal(resolveModelDisplayInfo(s2, { orchestratorIdMode: 'compact' }).text, 'orchestrator-helium');
  assert.equal(resolveModelDisplayInfo(s2, { orchestratorIdMode: 'full' }).text, 'gemini-pro-orchestrator (helium)');

  // Direct non-Orchestrator Carbon/Argon/Neon models format with version-first Gemini short aliases
  assert.equal(
    resolveModelDisplayInfo(
      { modelKey: 'MODEL_PLACEHOLDER_M429', modelShort: 'carbon-4-high', modelLabel: 'Gemini 4 Carbon (High)', modelUpstream: 'gemini-4-carbon-high' },
      { showUpstreamModel: false, orchestratorIdMode: 'compact' }
    ).text,
    '4-carbon-high'
  );
  assert.equal(
    resolveModelDisplayInfo(
      { modelKey: 'MODEL_PLACEHOLDER_M535', modelShort: 'neon-4-xhigh', modelLabel: 'Gemini 4 Neon (XHigh)', modelUpstream: 'gemini-4-neon-xhigh' },
      { showUpstreamModel: false, orchestratorIdMode: 'compact' }
    ).text,
    '4-neon-xhigh'
  );
  assert.equal(
    resolveModelDisplayInfo({ modelShort: 'neon-4-high' }, { showUpstreamModel: false }).text,
    '4-neon-high'
  );
  assert.equal(
    resolveModelDisplayInfo({ modelShort: 'sonnet-4.6' }, { showUpstreamModel: false }).text,
    'sonnet-4.6'
  );
});

test('Orchestrator (Opus 5.5) resolves Claude family, Opus 5.5 pricing, distinct display, and Claude & GPT quota pool across label variants', async () => {
  const OPUS_ORCH_PH = 'MODEL_PLACEHOLDER_M940';
  const OPUS_ORCH_PH_2 = 'MODEL_PLACEHOLDER_M941';
  const OPUS_ORCH_PH_3 = 'MODEL_PLACEHOLDER_M942';
  const rows = [
    step(1, OPUS_ORCH_PH),
    step(2, OPUS_ORCH_PH_2),
    step(3, OPUS_ORCH_PH_3),
    step(4, 'MODEL_PLACEHOLDER_M368'),
  ];
  const h = backendHarness({
    clock: () => PROMO_CLOCK_MS,
    summaries: { test: { stepCount: 4 } },
    trajectories: {
      test: {
        trajectory: {
          steps: rows,
          generatorMetadata: [
            {
              stepIndices: [1],
              chatModel: {
                model: OPUS_ORCH_PH,
                responseModel: 'claude-opus-5-5',
                modelDisplayName: 'Orchestrator (Opus 5.5)',
              },
            },
            {
              stepIndices: [2],
              chatModel: {
                model: OPUS_ORCH_PH_2,
                responseModel: 'claude-opus-5-5-orchestrator',
                modelDisplayName: 'Orchestrator (Claude Opus 5.5)',
              },
            },
            {
              stepIndices: [3],
              chatModel: {
                model: OPUS_ORCH_PH_3,
                responseModel: 'claude-orchestrator',
                modelDisplayName: 'Claude Opus 5.5 (Orchestrator)',
              },
            },
            {
              stepIndices: [4],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M368',
                responseModel: 'claude-opus-5-5',
                modelDisplayName: 'Claude Opus 5.5',
              },
            },
          ],
        },
      },
    },
  });

  const p = await h.buildTelemetryPayloadInternal('test');
  const s1 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 1);
  const s2 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 2);
  const s3 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 3);
  const s4 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 4);

  // step() fixture: 1000 input ($4/M = 0.004) + 9000 cache ($0.20/M = 0.0018) + 1000 output ($20/M = 0.02) = 0.0258
  for (const st of [s1, s2, s3]) {
    assert.equal(st.modelShort, 'orch-opus-5.5');
    assert.equal(st.family, 'Claude');
    assert.equal(st.costUsd, 0.0258);
  }
  assert.equal(s1.modelUpstream, 'claude-opus-5-5');
  assert.equal(s2.modelUpstream, 'claude-opus-5-5-orchestrator (opus-5.5)');
  assert.equal(s3.modelUpstream, 'claude-orchestrator (opus-5.5)');
  assert.equal(s4.modelShort, 'opus-5.5');
  assert.equal(s4.costUsd, 0.0258);
  assert.equal(p.consumption.account.unpricedCalls, 0);

  // Never misclassified as Carbon/Argon/Neon even if paired with an opaque upstream id
  assert.equal(h.isCarbonModelIdentifier(OPUS_ORCH_PH, 'gemini-pro-orchestrator', 'Orchestrator (Opus 5.5)'), false);
  assert.equal(h.isArgonModelIdentifier(OPUS_ORCH_PH, 'claude-opus-5-5-orchestrator', 'Orchestrator (Opus 5.5)'), false);
  assert.equal(h.isNeonModelIdentifier(OPUS_ORCH_PH, 'claude-opus-5-5-orchestrator', 'Orchestrator (Opus 5.5)'), false);

  // GetUserStatus clientModelConfig without apiProvider maps placeholder to label without retaining quotaInfo
  const dynOpusMap = h.buildDynamicModelMap([
    {
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M949' },
      modelId: 'orchestrator-v2',
      label: 'Orchestrator (Opus 5.5)',
      quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-25T00:00:00Z' },
    },
  ]);
  const opusEntry = dynOpusMap.get('MODEL_PLACEHOLDER_M949');
  assert.equal(opusEntry?.label, 'Orchestrator (Opus 5.5)');
  assert.equal(opusEntry?.quotaInfo, undefined);
  assert.equal(h.resolveModelInfo('MODEL_PLACEHOLDER_M949', dynOpusMap).family, 'Claude');

  // Frontend compact/full Orchestrator display works cleanly and stays separate from standalone Opus 5.5
  assert.equal(resolveModelDisplayInfo(s1, { orchestratorIdMode: 'compact' }).text, 'orchestrator-opus-5.5');
  assert.equal(resolveModelDisplayInfo(s1, { orchestratorIdMode: 'full' }).text, 'claude-opus-5-5');
  assert.equal(resolveModelDisplayInfo(s2, { orchestratorIdMode: 'compact' }).text, 'orchestrator-opus-5.5');
  assert.equal(resolveModelDisplayInfo(s2, { orchestratorIdMode: 'full' }).text, 'claude-opus-5-5-orchestrator (opus-5.5)');
  assert.equal(resolveModelDisplayInfo(s3, { orchestratorIdMode: 'compact' }).text, 'orchestrator-opus-5.5');
  assert.equal(resolveModelDisplayInfo(s3, { orchestratorIdMode: 'full' }).text, 'claude-orchestrator (opus-5.5)');
  assert.equal(
    resolveModelDisplayInfo(
      { modelKey: OPUS_ORCH_PH, modelLabel: 'Orchestrator (Opus 5.5)' },
      { orchestratorIdMode: 'full' }
    ).text,
    'orchestrator-opus-5.5',
    'Non-Gemini Orchestrator without upstream never fabricates gemini-pro-orchestrator-*'
  );
  const mergedCompact = mergeModelsByDisplayName(
    p.modelBreakdown,
    { modelDisplayMode: 'short', orchestratorIdMode: 'compact' },
    { preferLabelInShort: true }
  );
  assert.ok(mergedCompact.some((m) => m.displayText === 'orchestrator-opus-5.5'));
  assert.ok(mergedCompact.some((m) => m.displayText === 'Claude Opus 5.5'));
});

test('Orchestrator executionModel supports Neon and Claude workers without hijacking them into Hydrogen', async () => {
  const OPUS_ORCH_PH = 'MODEL_PLACEHOLDER_M940';
  const NEON_WORKER_PH = 'MODEL_PLACEHOLDER_M945';
  const SONNET_WORKER_PH = 'MODEL_PLACEHOLDER_M946';
  const UNKNOWN_WORKER_PH = 'MODEL_PLACEHOLDER_M947';
  const rows = [
    step(1, OPUS_ORCH_PH),
    step(2, NEON_WORKER_PH),
    step(3, 'MODEL_PLACEHOLDER_M535'),
    step(4, SONNET_WORKER_PH),
    step(5, UNKNOWN_WORKER_PH),
  ];
  const h = backendHarness({
    clock: () => PROMO_CLOCK_MS,
    summaries: { test: { stepCount: 5 } },
    trajectories: {
      test: {
        trajectory: {
          steps: rows,
          generatorMetadata: [
            {
              stepIndices: [1],
              chatModel: {
                model: OPUS_ORCH_PH,
                responseModel: 'claude-opus-5-5',
                modelDisplayName: 'Orchestrator (Opus 5.5)',
              },
              plannerConfig: {
                planModel: OPUS_ORCH_PH,
                modelName: 'claude-opus-5-5',
                planExecuteConfig: { executionModel: 'MODEL_PLACEHOLDER_M535' },
              },
            },
            {
              stepIndices: [2],
              chatModel: {
                model: NEON_WORKER_PH,
                responseModel: 'gemini-neon-worker-agy',
                modelDisplayName: 'Gemini Pro',
              },
              plannerConfig: {
                planModel: OPUS_ORCH_PH,
                modelName: 'claude-opus-5-5-orchestrator',
                planExecuteConfig: { executionModel: NEON_WORKER_PH },
              },
            },
            {
              stepIndices: [3],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M535',
                responseModel: 'gemini-4-neon',
                modelDisplayName: 'Orchestrator (Opus 5.5)',
              },
            },
            {
              stepIndices: [4],
              chatModel: {
                model: SONNET_WORKER_PH,
                responseModel: 'claude-sonnet-5-5',
                modelDisplayName: 'Orchestrator Worker (Sonnet 5.5)',
              },
              plannerConfig: {
                planModel: OPUS_ORCH_PH,
                modelName: 'claude-opus-5-5-orchestrator',
                planExecuteConfig: { executionModel: SONNET_WORKER_PH },
              },
            },
            {
              stepIndices: [5],
              chatModel: {
                model: UNKNOWN_WORKER_PH,
                responseModel: 'mystery-worker-agy',
                modelDisplayName: 'Orchestrator Worker (Krypton)',
              },
            },
          ],
        },
      },
    },
  });

  const p = await h.buildTelemetryPayloadInternal('test');
  const s2 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 2);
  const s3 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 3);
  const s4 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 4);
  const s5 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 5);

  // Dedicated Neon worker (gemini-neon-worker-agy) resolves to Neon Worker with Neon pricing ($3/$0.15/$15 -> 0.0193)
  assert.equal(s2.modelLabel, 'Orchestrator Worker (Neon)');
  assert.equal(s2.modelShort, 'neon-4');
  assert.equal(s2.modelUpstream, 'gemini-neon-worker-agy (neon-4)');
  assert.equal(s2.family, 'Gemini');
  assert.equal(s2.costUsd, 0.0193);
  assert.equal(resolveModelDisplayInfo(s2, { orchestratorIdMode: 'compact' }).text, 'worker-agy-neon');
  assert.equal(resolveModelDisplayInfo(s2, { orchestratorIdMode: 'full' }).text, 'gemini-neon-worker-agy (neon-4)');

  // Direct M535 Neon execution step with leaked planner name clears leaked label and resolves as Gemini 4 Neon (XHigh)
  assert.equal(s3.modelLabel, 'Gemini 4 Neon (XHigh)');
  assert.equal(s3.modelShort, 'neon-4-xhigh');
  assert.equal(s3.family, 'Gemini');
  assert.equal(s3.costUsd, 0.0193);

  // Claude Sonnet 5.5 worker keeps Claude family & Sonnet 5.5 pricing ($2/$0.10/$10 -> 0.0129), never Hydrogen
  assert.equal(s4.modelLabel, 'Orchestrator Worker (Sonnet 5.5)');
  assert.equal(s4.family, 'Claude');
  assert.equal(s4.costUsd, 0.0129);
  assert.equal(resolveModelDisplayInfo(s4, { orchestratorIdMode: 'compact' }).text, 'worker-agy-sonnet-5.5');
  assert.equal(resolveModelDisplayInfo(s4, { orchestratorIdMode: 'full' }).text, 'claude-sonnet-5-5');

  // Unknown future worker remains unpriced and renders worker-agy-krypton instead of worker-agy-hydrogen
  assert.equal(s5.modelLabel, 'Orchestrator Worker (Krypton)');
  assert.equal(s5.costUsd, null);
  assert.equal(resolveModelDisplayInfo(s5, { orchestratorIdMode: 'compact' }).text, 'worker-agy-krypton');
  assert.equal(resolveModelDisplayInfo(s5, { orchestratorIdMode: 'full' }).text, 'mystery-worker-agy (krypton)');
});

test('real-world M669 worker steps (responseModel gemini-flash-worker-agy, displayName Gemini Flash) and uncatalogued executionModel resolve to Hydrogen', async () => {
  const FUTURE_EXEC_PH = 'MODEL_PLACEHOLDER_M799';
  const rows = [step(1, ORCH_CARBON), step(2, ORCH_EXEC_HYDROGEN), step(3, FUTURE_EXEC_PH)];
  const raw = {
    trajectory: {
      steps: rows,
      generatorMetadata: [
        {
          stepIndices: [1],
          chatModel: {
            model: ORCH_CARBON,
            responseModel: 'gemini-pro-orchestrator',
            modelDisplayName: 'Orchestrator (Carbon)',
          },
          plannerConfig: {
            planModel: ORCH_CARBON,
            modelName: 'gemini-pro-orchestrator',
            planExecuteConfig: { executionModel: FUTURE_EXEC_PH },
          },
        },
        {
          stepIndices: [2],
          chatModel: {
            model: ORCH_EXEC_HYDROGEN,
            responseModel: 'gemini-flash-worker-agy',
            modelDisplayName: 'Gemini Flash',
          },
        },
        {
          stepIndices: [3],
          chatModel: {
            model: FUTURE_EXEC_PH,
            responseModel: 'gemini-flash-worker-agy',
            modelDisplayName: 'Gemini Flash',
          },
        },
      ],
    },
  };

  const p = await payload(rows, { trajectories: { test: raw } });
  const s1 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 1);
  const s2 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 2);
  const s3 = p.activeConversation.recentSteps.find((s) => s.stepIndex === 3);

  assert.equal(s1.modelShort, 'orch-carbon');
  assert.equal(s1.modelUpstream, 'gemini-pro-orchestrator (carbon-4)');
  assert.equal(s1.costUsd, 0.0129);

  assert.equal(s2.modelShort, 'hydrogen-4');
  assert.equal(s2.modelLabel, 'Orchestrator Worker (Hydrogen)');
  assert.equal(s2.modelUpstream, 'gemini-flash-worker-agy (hydrogen-4)');
  assert.equal(s2.costUsd, 0.0097);

  assert.equal(s3.modelShort, 'hydrogen-4');
  assert.equal(s3.modelLabel, 'Orchestrator Worker (Hydrogen)');
  assert.equal(s3.modelUpstream, 'gemini-flash-worker-agy (hydrogen-4)');
  assert.equal(s3.costUsd, 0.0097);

  assert.equal(p.consumption.account.unpricedCalls, 0);
  const orchRow = p.modelBreakdown.find((m) => m.label === 'Orchestrator (Carbon)');
  const hydroRow = p.modelBreakdown.find((m) => m.label === 'Orchestrator Worker (Hydrogen)');
  assert.ok(orchRow && hydroRow, 'modelBreakdown keeps orchestrator planning separate from Hydrogen worker');
  assert.equal(p.modelBreakdown.some((m) => m.label === 'Gemini Flash'), false);
  assert.equal(orchRow.calls, 1);
  assert.equal(hydroRow.calls, 2);
  assert.equal(hydroRow.upstreamName, 'gemini-flash-worker-agy (hydrogen-4)');

  // Also verify already-cached M669 worker steps carrying vague "Gemini Flash" or transitional "Gemini 4 Hydrogen" resolve cleanly
  const cachedStep = {
    ...extractModelSteps([step(10, ORCH_EXEC_HYDROGEN)])[0],
    responseModel: 'gemini-flash-worker-agy',
    modelDisplayName: 'Gemini Flash',
  };
  const cachedTransitionalDirect = {
    ...extractModelSteps([step(11, 'MODEL_PLACEHOLDER_M528')])[0],
    modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
  };
  const hCached = backendHarness({
    cache: { test: { signature: 'v13-clean:2:', steps: [cachedStep, cachedTransitionalDirect] } },
    trajectories: { test: new Error('offline') },
  });
  const pCached = await hCached.buildTelemetryPayloadInternal('test');
  assert.equal(pCached.activeConversation.activeModelShort, 'hydrogen-4-xhigh');
  assert.equal(
    pCached.modelBreakdown.find((m) => m.label === 'Orchestrator Worker (Hydrogen)')?.upstreamName,
    'gemini-flash-worker-agy (hydrogen-4)'
  );
  assert.ok(
    pCached.modelBreakdown.find((m) => m.label === 'Gemini 4 Hydrogen'),
    'direct Gemini 4 Hydrogen remains in its own breakdown bucket separate from worker-agy'
  );
});

test('new Carbon (M427/M437/M438) and Hydrogen XHigh/High/Medium/Low (M525-M528) placeholders resolve and group cleanly', () => {
  const { resolveModelInfo, getBaseModelLabel } = backendHarness();

  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M427').shortName, 'carbon-4-high');
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M437').shortName, 'carbon-4');
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M438').shortName, 'carbon-4-low');

  const xhigh = resolveModelInfo('MODEL_PLACEHOLDER_M528');
  assert.equal(xhigh.shortName, 'hydrogen-4-xhigh');
  assert.equal(xhigh.baseLabel, 'Gemini 4 Hydrogen');
  assert.equal(xhigh.pricing.input, 1.5);
  assert.equal(xhigh.pricing.cache, 0.075);
  assert.equal(xhigh.pricing.output, 7.5);
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M525').shortName, 'hydrogen-4-high');
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M526').shortName, 'hydrogen-4');
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M527').shortName, 'hydrogen-4-low');
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M527').pricing.input, 1.5);
  assert.equal(resolveModelInfo('MODEL_PLACEHOLDER_M527').pricing.output, 7.5);

  assert.equal(getBaseModelLabel('Orchestrator (Carbon)'), 'Orchestrator (Carbon)');
  assert.equal(getBaseModelLabel('Orchestrator (Argon)'), 'Orchestrator (Argon)');
  assert.equal(getBaseModelLabel('Orchestrator Worker (Hydrogen)'), 'Orchestrator Worker (Hydrogen)');
});

test('orchestratorIdMode defaults to compact, persists via settings action, and controls Orchestrator series independently of showUpstreamModel', (t) => {
  const prevLocale = i18nStore.getState().locale;
  setI18nLanguage('zh-CN');
  t.after(() => setI18nLanguage(prevLocale));
  const h = backendHarness();
  assert.equal(h.loadSettings().orchestratorIdMode, 'compact');

  const resFull = h.executeSettingsAction({ orchestratorIdMode: 'full' });
  assert.equal(resFull.ok, true);
  assert.equal(resFull.updated.orchestratorIdMode, 'full');

  const resInvalid = h.executeSettingsAction({ orchestratorIdMode: 'unexpected' });
  assert.equal(resInvalid.updated.orchestratorIdMode, 'compact');

  const orchCarbon = {
    modelKey: ORCH_CARBON,
    modelShort: 'orch-carbon',
    modelLabel: 'Orchestrator (Carbon)',
    modelUpstream: 'gemini-pro-orchestrator (carbon-4)',
    responseModel: 'gemini-pro-orchestrator',
  };
  const orchArgon = {
    modelKey: ORCH_ARGON,
    modelShort: 'orch-argon',
    modelLabel: 'Orchestrator (Argon)',
    modelUpstream: 'gemini-pro-orchestrator-argon (argon-4)',
    responseModel: 'gemini-pro-orchestrator-argon',
  };
  const orchNeon = {
    modelKey: ORCH_NEON,
    modelShort: 'orch-neon',
    modelLabel: 'Orchestrator (Neon)',
    modelUpstream: 'gemini-pro-orchestrator-neon (neon-4)',
    responseModel: 'gemini-pro-orchestrator-neon',
  };
  const orchNeonCompaction = {
    modelKey: ORCH_NEON,
    modelShort: 'orch-neon·压缩',
    modelLabel: 'Orchestrator (Neon) [自动压缩]',
    modelUpstream: 'gemini-pro-orchestrator-neon (neon-4)·压缩',
    responseModel: 'gemini-pro-orchestrator-neon',
    isCompactionStep: true,
  };
  const orchWorkerCompaction = {
    modelKey: ORCH_EXEC_HYDROGEN,
    modelShort: 'hydrogen-4·压缩',
    modelLabel: 'Orchestrator Worker (Hydrogen) [自动压缩]',
    modelUpstream: 'gemini-flash-worker-agy (hydrogen-4)·压缩',
    responseModel: 'gemini-flash-worker-agy',
    isCompactionStep: true,
  };
  const directHydrogen = {
    modelKey: 'MODEL_PLACEHOLDER_M528',
    modelShort: 'hydrogen-4-xhigh',
    modelLabel: 'Gemini 4 Hydrogen (XHigh)',
    modelUpstream: 'gemini-4-hydrogen-xhigh',
  };

  for (const showUpstreamModel of [false, true]) {
    assert.equal(
      resolveModelDisplayInfo(orchCarbon, { showUpstreamModel, orchestratorIdMode: 'compact' }).text,
      'orchestrator-carbon'
    );
    assert.equal(
      resolveModelDisplayInfo(orchArgon, { showUpstreamModel, orchestratorIdMode: 'compact' }).text,
      'orchestrator-argon'
    );
    assert.equal(
      resolveModelDisplayInfo(orchNeon, { showUpstreamModel, orchestratorIdMode: 'compact' }).text,
      'orchestrator-neon'
    );
    assert.equal(
      resolveModelDisplayInfo(orchNeonCompaction, { showUpstreamModel, orchestratorIdMode: 'compact' }).text,
      'orchestrator-neon·压缩'
    );
    assert.equal(
      resolveModelDisplayInfo(orchWorkerCompaction, { showUpstreamModel, orchestratorIdMode: 'compact' }).text,
      'worker-agy-hydrogen·压缩'
    );
    assert.equal(
      resolveModelDisplayInfo(orchCarbon, { showUpstreamModel, orchestratorIdMode: 'full' }).text,
      'gemini-pro-orchestrator (carbon-4)'
    );
    assert.equal(
      resolveModelDisplayInfo(orchArgon, { showUpstreamModel, orchestratorIdMode: 'full' }).text,
      'gemini-pro-orchestrator-argon (argon-4)'
    );
    assert.equal(
      resolveModelDisplayInfo(orchNeon, { showUpstreamModel, orchestratorIdMode: 'full' }).text,
      'gemini-pro-orchestrator-neon (neon-4)'
    );
    assert.equal(
      resolveModelDisplayInfo(orchNeonCompaction, { showUpstreamModel, orchestratorIdMode: 'full' }).text,
      'gemini-pro-orchestrator-neon (neon-4)·压缩'
    );
    assert.equal(
      resolveModelDisplayInfo(orchWorkerCompaction, { showUpstreamModel, orchestratorIdMode: 'full' }).text,
      'gemini-flash-worker-agy (hydrogen-4)·压缩'
    );
  }

  // Non-Orchestrator direct Hydrogen formats version-first in short mode and follows showUpstreamModel regardless of orchestratorIdMode
  assert.equal(
    resolveModelDisplayInfo(directHydrogen, { showUpstreamModel: false, orchestratorIdMode: 'compact' }).text,
    '4-hydrogen-xhigh'
  );
  assert.equal(
    resolveModelDisplayInfo(directHydrogen, { showUpstreamModel: true, orchestratorIdMode: 'compact' }).text,
    'gemini-4-hydrogen-xhigh'
  );
  assert.equal(
    resolveModelDisplayInfo(directHydrogen, { showUpstreamModel: false, orchestratorIdMode: 'full' }, { preferLabelInShort: true }).text,
    'Gemini 4 Hydrogen (XHigh)'
  );
});

test('historical placeholders (M15/M16/M47/M84/M132/M133/M264/M330) and verified internal routing slugs resolve and price accurately without wildcarding unknown slugs', () => {
  const { resolveModelInfo } = backendHarness({ clock: () => PROMO_CLOCK_MS });

  const expectedPlaceholders = [
    ['MODEL_PLACEHOLDER_M84', 'flash-3.5-high', 1.5, 9.0],
    ['MODEL_PLACEHOLDER_M15', 'flash-3.5-high', 1.5, 9.0],
    ['MODEL_PLACEHOLDER_M132', 'flash-3.5-high', 1.5, 9.0],
    ['MODEL_PLACEHOLDER_M133', 'flash-3.5', 1.5, 9.0],
    ['MODEL_PLACEHOLDER_M47', 'flash-3', 0.5, 3.0],
    ['MODEL_PLACEHOLDER_M16', 'pro-3.1-high', 2.0, 12.0],
    ['MODEL_PLACEHOLDER_M264', 'flash-3.6-high', 0.75, 3.75],
    ['MODEL_PLACEHOLDER_M330', 'flash-2.5-lite', 0.1, 0.4],
  ];
  for (const [ph, shortName, inputPrice, outputPrice] of expectedPlaceholders) {
    const info = resolveModelInfo(ph);
    assert.equal(info.shortName, shortName, `${ph} shortName`);
    assert.ok(info.pricing, `${ph} should have pricing`);
    assert.equal(info.pricing.input, inputPrice, `${ph} input price`);
    assert.equal(info.pricing.output, outputPrice, `${ph} output price`);
  }

  const expectedSlugs = [
    ['gemini-3-flash-a', 'flash-3.5', 1.5, 9.0],
    ['gemini-3-flash-b', 'flash-3.5', 1.5, 9.0],
    ['gemini-3-flash-c', 'flash-3', 0.5, 3.0],
    ['gemini-3-flash-d', 'flash-3.5', 1.5, 9.0],
    ['gemini-3-flash-agent', 'flash-3.5', 1.5, 9.0],
    ['gemini-pro-default', 'pro-3.1', 2.0, 12.0],
    ['gemini-pro-agent', 'pro-3.1', 2.0, 12.0],
    ['gemini-pro-b', 'pro-3.1', 2.0, 12.0],
    ['gemini-3.7-flash-safety-le', 'flash-3.7', 0.75, 3.75],
    ['gemini-3.8-flash-n', 'flash-3.8', 0.75, 3.75],
    ['gemini-4-argon-f', 'argon-4', 2.0, 10.0],
    ['gemini-4-argon-disabled', 'argon-4', 2.0, 10.0],
  ];
  for (const [slug, shortName, inputPrice, outputPrice] of expectedSlugs) {
    const info = resolveModelInfo(slug);
    assert.equal(info.shortName, shortName, `${slug} shortName`);
    assert.ok(info.pricing, `${slug} should have pricing`);
    assert.equal(info.pricing.input, inputPrice, `${slug} input price`);
    assert.equal(info.pricing.output, outputPrice, `${slug} output price`);
  }

  // Unverified future variant must still remain unpriced (no reckless prefix fallback)
  const unknownVariant = resolveModelInfo('gemini-3.1-pro-ultra-v2');
  assert.equal(unknownVariant.pricing, null);
});

test('deep_stats session-display mislabeling is ignored when step-intrinsic model differs, and micro-costs preserve 6-decimal precision', async () => {
  const nowIso = new Date(Date.now() - 5_000).toISOString();
  const h = backendHarness({
    summaries: {
      ide_convo: { stepCount: 1 },
    },
    trajectories: {
      ide_convo: {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                sourceTrajectoryStepInfo: { stepIndex: 1 },
                createdAt: nowIso,
                completedAt: new Date(Date.now() - 4_000).toISOString(),
                modelUsage: {
                  model: 'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE',
                  apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                  inputTokens: '1900',
                  cacheReadTokens: '0',
                  outputTokens: '107',
                },
              },
            },
          ],
        },
      },
    },
    deepStats: {
      perConvo: {
        'standalone:11111111-2222-3333-4444-555555555555': {
          appSource: 'standalone',
          entries: [
            {
              ts: nowIso,
              model: 'gemini-2.5-flash-lite',
              modelCanonicalId: 'gemini-2.5-flash-lite',
              modelAggregationId: 'session-display:gemini-3-5-flash-lite',
              modelDisplayName: 'Gemini 3.5 Flash Lite',
              provider: 'API_PROVIDER_GOOGLE_GEMINI',
              inp: 12300,
              cache: 0,
              out: 154,
              reasoning: 0,
            },
            {
              ts: nowIso,
              model: 'gemini-3-flash-a',
              modelCanonicalId: 'gemini-3-flash-a',
              modelAggregationId: 'session:gemini-3-flash-a',
              provider: 'API_PROVIDER_GOOGLE_GEMINI',
              inp: 3320000,
              cache: 32730000,
              out: 120000,
              reasoning: 195500,
            },
          ],
        },
      },
    },
  });

  const p = await h.buildTelemetryPayloadInternal('ide_convo');
  const consumptionModels = p.modelBreakdown;

  // Both gemini-2.5-flash-lite calls (IDE + standalone with session-display:gemini-3-5-flash-lite) merge into one Gemini 2.5 Flash Lite bucket!
  const flash25Rows = consumptionModels.filter((m) => /2\.5 Flash Lite/i.test(m.label));
  assert.equal(flash25Rows.length, 1);
  assert.equal(
    consumptionModels.some((m) => /3\.5 Flash Lite/i.test(m.label)),
    false,
    'mismatched session-display:gemini-3-5-flash-lite should not create a bogus Gemini 3.5 Flash Lite bucket'
  );
  assert.equal(flash25Rows[0].calls, 2);
  assert.equal(flash25Rows[0].unpricedCalls, 0);
  // 14,200 input * $0.10/M + 261 output * $0.40/M = $0.0015244 -> 0.001524 (> 0, not truncated to 0!)
  assert.equal(flash25Rows[0].costUsd, 0.001524);

  // Also check single-step micro-cost (< $0.001) on activeConversation.modelBreakdown
  const sessionFlash25 = p.activeConversation.modelBreakdown.find((m) => /2\.5 Flash Lite/i.test(m.label));
  assert.ok(sessionFlash25);
  // 1,900 * $0.10/M + 107 * $0.40/M = $0.0002328 -> 0.000233
  assert.equal(sessionFlash25.costUsd, 0.000233);
  assert.equal(formatUsd(sessionFlash25.costUsd, { precise: true }), '<$0.001');
  assert.equal(formatUsd(flash25Rows[0].costUsd, { precise: true }), '$0.002');

  // Standalone session:gemini-3-flash-a entry preserves responseModel & prices cleanly
  const flash35Row = consumptionModels.find((m) => m.label === 'Gemini 3.5 Flash');
  assert.ok(flash35Row);
  assert.equal(flash35Row.upstreamName, 'gemini-3-flash-a');
  assert.equal(flash35Row.unpricedCalls, 0);
  assert.ok(flash35Row.costUsd > 12);
});

test('mergeModelsByDisplayName collapses distinct backend buckets that share the same rendered display text', () => {
  const rawModels = [
    {
      label: 'Gemini 3.8 Flash',
      shortName: 'flash-3.8',
      upstreamName: 'gemini-3-flash-a',
      upstreamModels: ['gemini-3-flash-a', 'gemini-3.8-flash'],
      calls: 7063,
      inputTokens: 91_800_000,
      cacheReadTokens: 674_810_000,
      outputTokens: 5_510_000,
      thinkingTokens: 3_130_000,
      responseTokens: 2_380_000,
      totalTokens: 772_120_000,
      costUsd: 286.2,
      unpricedCalls: 0,
      avgTokPerSec: 120,
      speedSummary: { sampleCount: 100, excludedCount: 5, avgTokPerSec: 120 },
      avgTtftSec: 2.0,
      ttftSampleCount: 100,
    },
    {
      label: 'Gemini 3.5 Flash',
      shortName: 'flash-3.5',
      upstreamName: 'gemini-3-flash-a',
      upstreamModels: ['gemini-3-flash-a'],
      calls: 449,
      inputTokens: 3_320_000,
      cacheReadTokens: 32_730_000,
      outputTokens: 315_500,
      thinkingTokens: 195_500,
      responseTokens: 120_000,
      totalTokens: 36_365_500,
      costUsd: 12.73,
      unpricedCalls: 0,
      avgTokPerSec: 80,
      speedSummary: { sampleCount: 100, excludedCount: 2, avgTokPerSec: 80 },
      avgTtftSec: 4.0,
      ttftSampleCount: 100,
    },
  ];

  // In upstream mode, both resolve to 'gemini-3-flash-a' -> merged into 1 row!
  const mergedUpstream = mergeModelsByDisplayName(
    rawModels,
    { showUpstreamModel: true },
    { preferLabelInShort: true }
  );
  assert.equal(mergedUpstream.length, 1);
  assert.equal(mergedUpstream[0].displayText, 'gemini-3-flash-a');
  assert.equal(mergedUpstream[0].calls, 7512);
  assert.equal(mergedUpstream[0].totalTokens, 808_485_500);
  assert.equal(mergedUpstream[0].costUsd, 298.93);
  assert.equal(mergedUpstream[0].avgTokPerSec, 100);
  assert.equal(mergedUpstream[0].avgTtftSec, 3);
  assert.deepEqual(mergedUpstream[0].sourceLabels, ['Gemini 3.8 Flash', 'Gemini 3.5 Flash']);

  // In friendly label mode, 'Gemini 3.8 Flash' and 'Gemini 3.5 Flash' stay distinct!
  const mergedShort = mergeModelsByDisplayName(
    rawModels,
    { showUpstreamModel: false },
    { preferLabelInShort: true }
  );
  assert.equal(mergedShort.length, 2);
});

test('Google AI Studio image resolution tiers and pricing map cleanly across Gemini 3.1 Flash Image, 3 Pro Image, and 2.5 Flash Image', () => {
  const h = backendHarness({ clock: () => PROMO_CLOCK_MS });

  // 1. Gemini 3.1 Flash Image: 0.5K (747), 1K (1120), 2K (1680), 4K (2520) @ $60/1M image output
  const flash31_05k = estimateImageGenStepUsage({
    generateImage: {
      modelName: 'gemini-3.1-flash-image',
      prompt: 'tiny icon',
      imageDimensions: { width: 512, height: 512 },
    },
  });
  assert.equal(flash31_05k.resolutionTier, '0.5K');
  assert.equal(flash31_05k.outputTokens, 747);

  const flash31_1k = estimateImageGenStepUsage({
    generateImage: {
      modelName: 'gemini-3.1-flash-image',
      prompt: 'cozy cat by rainy window',
      aspectRatio: '4:3',
      imageDimensions: { width: 1200, height: 896 },
    },
  });
  assert.equal(flash31_1k.resolutionTier, '1K');
  assert.equal(flash31_1k.outputTokens, 1120);

  const flash31_2k = estimateImageGenStepUsage({
    generateImage: {
      modelName: 'gemini-3.1-flash-image-preview',
      prompt: 'detailed wallpaper',
      imageDimensions: { width: 2048, height: 1536 },
    },
  });
  assert.equal(flash31_2k.resolutionTier, '2K');
  assert.equal(flash31_2k.outputTokens, 1680);

  const flash31_4k = estimateImageGenStepUsage({
    metadata: {
      toolCall: {
        argumentsJson: JSON.stringify({
          Prompt: 'edit reference scene',
          ImagePaths: ['a.png', 'b.png'],
        }),
      },
    },
    generateImage: {
      modelName: 'gemini-3.1-flash-image',
      imageDimensions: { width: 4096, height: 3072 },
    },
  });
  assert.equal(flash31_4k.resolutionTier, '4K');
  assert.equal(flash31_4k.outputTokens, 2520);
  assert.ok(flash31_4k.inputTokens >= 1120, '2 reference images add 2 * 560 = 1120 input tokens');

  // Canceled or failed step without generated result yields 0 image output tokens
  const failedUsage = estimateImageGenStepUsage(
    { generateImage: { modelName: 'gemini-3.1-flash-image', prompt: 'failed prompt' } },
    false
  );
  assert.equal(failedUsage.outputTokens, 0);

  const mFlash31 = h.resolveModelInfo('gemini-3.1-flash-image');
  assert.equal(mFlash31.label, 'Gemini 3.1 Flash Image');
  assert.equal(mFlash31.shortName, 'flash-3.1-img');
  assert.equal(mFlash31.pricing.input, 0.5);
  assert.equal(mFlash31.pricing.imageOutput, 60);
  // 200 input * $0.50/M ($0.0001) + 1120 image output * $60/M ($0.0672) = $0.0673
  const costFlash31 = h.computeStepCost(
    { isImageGenStep: true, inputTokens: 200, cacheReadTokens: 0, outputTokens: 1120 },
    mFlash31.pricing
  );
  assert.ok(Math.abs(costFlash31 - 0.0673) < 1e-9);

  // 2. Gemini 3 Pro Image: 1K/2K -> 1120, 4K -> 2000 @ $120/1M image output ($0.1344 and $0.24)
  const pro3_2k = estimateImageGenStepUsage({
    generateImage: {
      modelName: 'gemini-3-pro-image-preview',
      prompt: 'studio product render',
      imageDimensions: { width: 2048, height: 2048 },
    },
  });
  const pro3_4k = estimateImageGenStepUsage({
    generateImage: {
      modelName: 'gemini-3-pro-image',
      prompt: 'studio product render 4k',
      imageDimensions: { width: 4096, height: 4096 },
    },
  });
  assert.equal(pro3_2k.outputTokens, 1120);
  assert.equal(pro3_4k.outputTokens, 2000);
  const mPro3 = h.resolveModelInfo('MODEL_GOOGLE_GEMINI_3_PRO_IMAGE_PREVIEW');
  assert.equal(mPro3.shortName, 'pro-3-img');
  assert.equal(mPro3.pricing.imageOutput, 120);
  assert.ok(
    Math.abs(
      h.computeStepCost(
        { isImageGenStep: true, inputTokens: 0, cacheReadTokens: 0, outputTokens: 1120 },
        mPro3.pricing
      ) - 0.1344
    ) < 1e-9
  );
  assert.ok(
    Math.abs(
      h.computeStepCost(
        { isImageGenStep: true, inputTokens: 0, cacheReadTokens: 0, outputTokens: 2000 },
        mPro3.pricing
      ) - 0.24
    ) < 1e-9
  );

  // 3. Gemini 2.5 Flash Image: 1290 output tokens @ $30/1M ($0.0387)
  const flash25 = estimateImageGenStepUsage({
    generateImage: {
      modelName: 'gemini-2.5-flash-image',
      prompt: 'sketch',
      imageDimensions: { width: 1024, height: 1024 },
    },
  });
  assert.equal(flash25.outputTokens, 1290);
  const mFlash25 = h.resolveModelInfo('MODEL_GOOGLE_GEMINI_2_5_FLASH_IMAGE_PREVIEW');
  assert.equal(mFlash25.label, 'Gemini 2.5 Flash Image');
  assert.equal(mFlash25.shortName, 'flash-2.5-img');
  assert.equal(mFlash25.pricing.imageOutput, 30);
  assert.ok(
    Math.abs(
      h.computeStepCost(
        { isImageGenStep: true, inputTokens: 0, cacheReadTokens: 0, outputTokens: 1290 },
        mFlash25.pricing
      ) - 0.0387
    ) < 1e-9
  );

  // 4. Structured live activity i18n + reportExporter null-TTFT isolation
  const prevLang = i18nStore.getState().language;
  try {
    setI18nLanguage('zh-CN');
    assert.equal(formatLiveActivityLabel({ actionKey: 'generate_image' }), '生成图片');
    setI18nLanguage('en-US');
    assert.equal(formatLiveActivityLabel({ actionKey: 'generate_image' }), 'Generate Image');
  } finally {
    setI18nLanguage(prevLang);
  }

  const md = buildStepsMarkdownReport(
    [
      {
        stepIndex: 1,
        modelLabel: 'Gemini 4 Hydrogen (High)',
        modelShort: 'hydrogen-4-high',
        inputTokens: 1000,
        cacheReadTokens: 0,
        outputTokens: 200,
        tokPerSec: 50,
        ttftSec: 4.0,
        totalDurationSec: 4.0,
        costUsd: 0.008,
      },
      {
        stepIndex: 2,
        isImageGenStep: true,
        modelLabel: 'Gemini 3.1 Flash Image',
        modelShort: 'flash-3.1-img',
        inputTokens: 200,
        cacheReadTokens: 0,
        outputTokens: 1120,
        tokPerSec: 17.8,
        selectedSpeedReason: 'image_gen',
        ttftSec: null,
        totalDurationSec: 62.785,
        costUsd: 0.0673,
      },
    ],
    { locale: 'en-US' }
  );
  // Avg TTFT must remain 4.0s (from step #1 only), NOT diluted to 2.0s by Number(null) === 0!
  assert.match(md, /\*\*Avg Speed\*\*: 50\.0 tok\/s · \*\*Avg TTFT\*\*: 4\.0s/);
});

test('image-generator subagent surfaces generate_image step, isolates text TPS/TTFT/compaction/context, and auto-upgrades legacy cache', async () => {
  const HYDROGEN_HIGH = 'MODEL_PLACEHOLDER_M424';
  const mainId = '57963098-ddca-4441-a6f1-c931bbf600d8';
  const subId = 'd369e740-1f52-4f06-90a3-2f88bc623e2e';
  const t0 = PROMO_CLOCK_MS - 120_000;

  const mainTraj = {
    trajectory: {
      steps: [
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            sourceTrajectoryStepInfo: { stepIndex: 1 },
            createdAt: new Date(t0).toISOString(),
            completedAt: new Date(t0 + 5_000).toISOString(),
            modelUsage: {
              model: ARGON,
              apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
              inputTokens: '15000',
              cacheReadTokens: '0',
              outputTokens: '500',
            },
          },
          plannerResponse: {
            toolCalls: [{ name: 'invoke_subagent', argumentsJson: '{"TypeName":"image-generator"}' }],
          },
        },
        {
          type: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            sourceTrajectoryStepInfo: { stepIndex: 2 },
            createdAt: new Date(t0 + 5_100).toISOString(),
            completedAt: new Date(t0 + 75_000).toISOString(),
          },
          invokeSubagent: { conversationId: subId },
        },
      ],
    },
  };

  const subTraj = {
    trajectory: {
      steps: [
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            sourceTrajectoryStepInfo: { stepIndex: 1 },
            createdAt: new Date(t0 + 6_000).toISOString(),
            completedAt: new Date(t0 + 10_000).toISOString(),
            modelUsage: {
              model: HYDROGEN_HIGH,
              apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
              inputTokens: '3000',
              cacheReadTokens: '0',
              outputTokens: '400',
            },
          },
        },
        {
          type: 'CORTEX_STEP_TYPE_GENERATE_IMAGE',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            sourceTrajectoryStepInfo: { stepIndex: 2 },
            createdAt: new Date(t0 + 11_000).toISOString(),
            // finishedGeneratingAt is tool-call emission (~0.12s), whereas startedAt -> completedAt is 62.785s
            finishedGeneratingAt: new Date(t0 + 11_120).toISOString(),
            startedAt: new Date(t0 + 11_125).toISOString(),
            completedAt: new Date(t0 + 73_910).toISOString(),
            toolCall: {
              name: 'generate_image',
              argumentsJson: JSON.stringify({
                Prompt:
                  'Warm cozy orange tabby cat sitting on wooden windowsill watching gentle rain outside, cinematic warm lamp lighting, detailed illustration',
                AspectRatio: '4:3',
                ImageName: 'cozy_cat_window',
              }),
            },
          },
          generateImage: {
            prompt:
              'Warm cozy orange tabby cat sitting on wooden windowsill watching gentle rain outside, cinematic warm lamp lighting, detailed illustration',
            aspectRatio: '4:3',
            modelName: 'gemini-3.1-flash-image',
            imageName: 'cozy_cat_window',
            fileSizeBytes: 983509,
            imageDimensions: { width: 1200, height: 896 },
          },
        },
        // Checkpoint right after generate_image must inherit HYDROGEN_HIGH, NOT gemini-3.1-flash-image!
        {
          type: 'CORTEX_STEP_TYPE_CHECKPOINT',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            sourceTrajectoryStepInfo: { stepIndex: 3 },
            createdAt: new Date(t0 + 74_000).toISOString(),
            completedAt: new Date(t0 + 74_500).toISOString(),
            modelUsage: {
              apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
              inputTokens: '4000',
              cacheReadTokens: '0',
              outputTokens: '150',
            },
          },
        },
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            sourceTrajectoryStepInfo: { stepIndex: 5 },
            createdAt: new Date(t0 + 74_600).toISOString(),
            completedAt: new Date(t0 + 76_600).toISOString(),
            modelUsage: {
              model: HYDROGEN_HIGH,
              apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
              inputTokens: '2800',
              cacheReadTokens: '2200',
              outputTokens: '200',
            },
          },
        },
      ],
      generatorMetadata: [
        {
          stepIndices: [1],
          chatModel: {
            model: HYDROGEN_HIGH,
            responseModel: 'gemini-4-hydrogen-preview',
            modelDisplayName: 'Gemini 4 Hydrogen (High)',
            timeToFirstToken: '2.0s',
            chatStartMetadata: {
              contextWindowMetadata: { estimatedTokensUsed: 3400, maxContextTokens: 512000 },
            },
          },
        },
        {
          stepIndices: [5],
          chatModel: {
            model: HYDROGEN_HIGH,
            responseModel: 'gemini-4-hydrogen-preview',
            modelDisplayName: 'Gemini 4 Hydrogen (High)',
            timeToFirstToken: '1.0s',
            chatStartMetadata: {
              contextWindowMetadata: { estimatedTokensUsed: 5200, maxContextTokens: 512000 },
            },
          },
        },
      ],
    },
  };

  // Seed legacy pre-image-gen cache entry lacking `imageGenTelemetry` to verify automatic cache upgrade
  const h = backendHarness({
    clock: () => PROMO_CLOCK_MS,
    cache: {
      [subId]: {
        stepCount: 6,
        lastModifiedTime: new Date(t0 + 76_600).toISOString(),
        parentConversationId: mainId,
        agentTypeName: 'image-generator',
        steps: [
          {
            stepIndex: 1,
            modelKey: HYDROGEN_HIGH,
            inputTokens: 3000,
            cacheReadTokens: 0,
            outputTokens: 400,
          },
        ],
      },
    },
    summaries: {
      [mainId]: {
        stepCount: 3,
        lastModifiedTime: new Date(t0 + 76_600).toISOString(),
      },
      [subId]: {
        stepCount: 6,
        lastModifiedTime: new Date(t0 + 76_600).toISOString(),
        parentConversationId: mainId,
        trajectoryMetadata: {
          parentConversationId: mainId,
          subagentSpec: { typeName: 'image-generator', role: 'Image Generator' },
        },
      },
    },
    trajectories: {
      [mainId]: mainTraj,
      [subId]: subTraj,
    },
  });

  const p = await h.buildTelemetryPayloadInternal(mainId);
  const subAgent = p.activeConversation.agents.find((a) => !a.isMain);
  assert.ok(subAgent, 'image-generator subagent should be attached to activeConversation.agents');

  const imgStep = subAgent.recentSteps.find((s) => s.stepIndex === 2);
  assert.ok(imgStep, 'step #2 (generate_image) should be surfaced after auto-upgrading legacy cache');
  assert.equal(imgStep.isImageGenStep, true);
  assert.equal(imgStep.modelShort, 'flash-3.1-img');
  assert.equal(imgStep.modelLabel, 'Gemini 3.1 Flash Image');
  assert.equal(imgStep.outputTokens, 1120);
  assert.equal(imgStep.ttftSec, null);
  assert.equal(imgStep.selectedSpeedReason, 'image_gen');
  assert.ok(Math.abs(imgStep.totalDurationSec - 62.785) < 0.01);
  assert.equal(imgStep.tokPerSec, 17.8);
  assert.equal(imgStep.outCostUsd, 0.0672);
  assert.ok(imgStep.costUsd >= 0.0672 && imgStep.costUsd <= 0.0674);

  // Compaction step #3 must inherit Hydrogen High, NOT Gemini 3.1 Flash Image!
  const cpStep = subAgent.recentSteps.find((s) => s.stepIndex === 3);
  assert.ok(cpStep);
  assert.equal(cpStep.modelKey, HYDROGEN_HIGH);
  assert.equal(cpStep.modelSource, 'inferred_compaction');

  // Subagent text LLM TPS & TTFT averages must exclude image-gen step #2 and compaction step #3
  assert.equal(subAgent.speedSummary.sampleCount, 2);
  assert.equal(subAgent.ttftSummary.sampleCount, 2);
  assert.equal(subAgent.ttftSummary.avgSec, 1.5);
  assert.equal(subAgent.context.compactionLimitTokens, 512000);

  // Account & session model breakdowns include Gemini 3.1 Flash Image with 0 unpriced calls
  const imgBreakdown = p.modelBreakdown.find((m) => m.shortName === 'flash-3.1-img');
  assert.ok(imgBreakdown);
  assert.equal(imgBreakdown.label, 'Gemini 3.1 Flash Image');
  assert.equal(imgBreakdown.calls, 1);
  assert.equal(imgBreakdown.outputTokens, 1120);
  assert.equal(imgBreakdown.unpricedCalls, 0);
});
