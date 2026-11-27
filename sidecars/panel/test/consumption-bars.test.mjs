import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockDom } from './mock-dom.mjs';
import { backendHarness } from './backend-harness.mjs';
import {
  buildDeterministicModelColorMap,
  getCanonicalModelColorSeed,
  mergeModelsByDisplayName,
  resolveDeterministicModelColor,
} from '../src/core/formatters.js';
import {
  clearConsumptionRangeCache,
  fetchTelemetry,
  isEquivalentTelemetry,
  prefetchConsumptionPresets,
  selectConsumptionTimeRange,
  stopAsyncTelemetryLoop,
  telemetryStore,
} from '../src/store/telemetryStore.js';
import { createTrendAreaChart } from '../src/components/charts/TrendAreaChart.js';
import { uiStore } from '../src/store/uiStore.js';
import { i18nStore, setI18nLanguage } from '../src/i18n/index.js';
import { createFourSegmentBar } from '../src/components/ui/FourSegmentBar.js';
import { ConsumptionView } from '../src/views/ConsumptionView.js';

function parsePctVar(el, prop = '--seg-w') {
  const raw = el?.style?.getPropertyValue?.(prop) || '';
  return Number.parseFloat(raw.replace('%', '')) || 0;
}

test('Perceptual 20-color ring: deterministic cross-machine assignment without green pileups or hardcoded tables', () => {
  const realUserModels = [
    '3.7-flash',
    '3-flash-b',
    '3.8-flash',
    'pro-default',
    '3-flash-c',
    '3.6-flash',
    'opus-4-6-thinking',
    '3.1-flash-lite',
    'sonnet-4-6',
    '2.5-flash-lite',
    '4-argon',
    '4-carbon',
    '3.8-flash-n',
    '4-hydrogen',
    'orchestrator-carbon',
    'worker-agy-hydrogen',
  ];

  const mapForward = buildDeterministicModelColorMap(realUserModels);
  const mapReversed = buildDeterministicModelColorMap([...realUserModels].reverse());
  assert.deepEqual([...mapForward.entries()], [...mapReversed.entries()]);

  // All 16 models receive 16 completely distinct perceptual HSL colors
  const uniqueColors = new Set(mapForward.values());
  assert.equal(uniqueColors.size, realUserModels.length);

  // Merged upstream buckets ('4-carbon' across App vs CLI with different sourceLabels subsets) share identical seed
  const appMergedCarbon = {
    displayText: '4-carbon',
    mergedCount: 2,
    sourceLabels: ['Gemini 4 Carbon (High)', 'Gemini 4 Carbon (Medium)'],
  };
  const cliMergedCarbon = {
    displayText: '4-carbon',
    mergedCount: 1,
    sourceLabels: ['Gemini 4 Carbon (Low)'],
    label: 'Gemini 4 Carbon (Low)',
  };
  assert.equal(getCanonicalModelColorSeed(appMergedCarbon), '4-carbon');
  const singleModeModels = mergeModelsByDisplayName(
    [
      {
        label: 'Gemini 4 Carbon (Low)',
        shortName: '4-carbon',
        upstreamName: '4-carbon',
        calls: 2,
        totalTokens: 1000,
      },
    ],
    { modelDisplayMode: 'upstream', showUpstreamModel: true }
  );
  assert.equal(singleModeModels[0].displayText, '4-carbon');

  // Arbitrary future models work without hardcoding
  const future = resolveDeterministicModelColor('Gemini 9 Krypton (Ultra)');
  assert.match(future, /^hsl\(\d+\s+\d+%\s+\d+%\)$/);
  assert.equal(future, resolveDeterministicModelColor('  gemini 9   krypton (ultra) '));
  assert.ok(cliMergedCarbon);
});

test('FourSegmentBar supports percentage scaling while keeping 100% default for Overview', () => {
  const prevDoc = globalThis.document;
  const { document } = createMockDom();
  globalThis.document = document;
  try {
    const barFull = createFourSegmentBar();
    barFull.update({
      inputTokens: 200,
      cacheReadTokens: 500,
      responseTokens: 200,
      thinkingTokens: 100,
    });
    const segsFull = barFull.el.querySelectorAll('.progress-seg');
    assert.deepEqual(
      segsFull.map((el) => el.className.split(/\s+/).find((c) => c.startsWith('seg-'))),
      ['seg-input', 'seg-cached', 'seg-thinking', 'seg-output']
    );
    const sumFull = segsFull.reduce((acc, el) => acc + parsePctVar(el), 0);
    assert.ok(Math.abs(sumFull - 100) < 0.05);

    const barScaled = createFourSegmentBar();
    barScaled.update({
      inputTokens: 200,
      cacheReadTokens: 500,
      responseTokens: 200,
      thinkingTokens: 100,
      scaleRatio: 0.4,
    });
    const segsScaled = barScaled.el.querySelectorAll('.progress-seg');
    const sumScaled = segsScaled.reduce((acc, el) => acc + parsePctVar(el), 0);
    assert.ok(Math.abs(sumScaled - 40) < 0.05);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('Backend keeps source totals and per-model details on the usage trend', async () => {
  const nowMs = Date.parse('2026-11-18T12:00:00Z');
  const nowIso = '2026-11-18T12:00:00Z';
  const appCid = 'aaaaaaaa-1111-4111-8111-111111111111';
  const cliCid = 'cccccccc-2222-4222-8222-222222222222';

  const harness = backendHarness({
    clock: () => nowMs,
    trajectories: {
      [appCid]: {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_USER_INPUT',
              status: 'CORTEX_STEP_STATUS_DONE',
              userInput: { userResponse: 'Hello App' },
              metadata: { createdAt: nowIso },
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: nowIso,
                completedAt: '2026-11-18T12:00:03Z',
                sourceTrajectoryStepInfo: { stepIndex: 1 },
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M429',
                  apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                  inputTokens: '6000',
                  cacheReadTokens: '2000',
                  outputTokens: '2000',
                },
              },
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: '2026-11-18T12:00:05Z',
                completedAt: '2026-11-18T12:00:08Z',
                sourceTrajectoryStepInfo: { stepIndex: 2 },
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M405',
                  apiProvider: 'API_PROVIDER_ANTHROPIC',
                  inputTokens: '4000',
                  cacheReadTokens: '0',
                  outputTokens: '1000',
                },
              },
            },
          ],
        },
      },
    },
    summaries: {
      [appCid]: {
        summary: 'App Session',
        status: 'CASCADE_RUN_STATUS_IDLE',
        stepCount: 3,
        createdTime: nowIso,
        lastModifiedTime: '2026-11-18T12:00:08Z',
      },
    },
    deepStats: {
      perConvo: {
        [`cli:${cliCid}`]: {
          appSource: 'cli',
          entries: [
            {
              ts: '2026-11-18T12:01:00Z',
              modelRuntimeId: 'MODEL_PLACEHOLDER_M429',
              inp: 3000,
              cache: 1000,
              out: 800,
              reasoning: 200,
            },
          ],
        },
      },
    },
  });

  const payload = await harness.buildTelemetryPayloadInternal(appCid, false, { range: 'all' });
  const sources = payload.consumption?.sourcesBreakdown || [];
  assert.equal(sources.length, 2);
  assert.equal(sources[0].name, 'Antigravity App');
  assert.equal(sources[0].totalTokens, 15_000);
  assert.equal(sources[0].calls, 2);
  assert.equal(sources[0].models, undefined);
  assert.equal(sources[1].name, 'Antigravity CLI');
  assert.equal(sources[1].totalTokens, 5_000);
  assert.equal(sources[1].calls, 1);
  assert.equal(sources[1].models, undefined);
  assert.equal(payload.consumption.monthlyYear, undefined);
  assert.equal(payload.consumption.monthlySeries, undefined);

  const scoped = JSON.parse((await harness.executeTelemetryAction({
    conversationId: appCid,
    scope: 'consumption',
    range: 'custom',
    startMs: nowMs - 60_000,
    endMs: nowMs + 120_000,
  })).body);
  assert.equal(scoped.scope, 'consumption');
  assert.deepEqual(scoped.consumption.sourcesBreakdown, JSON.parse(JSON.stringify(sources)));

  // Active trendSeries bucket carries 4-channel totals & per-model 4-channel breakdown while zero-token buckets omit models
  const trendSlots = payload.consumption?.trendSeries || [];
  assert.ok(trendSlots.length >= 176 && trendSlots.length <= 183, `All-range trend spans ~6 months (${trendSlots.length} days)`);
  const activeTrendSlot = trendSlots.find((s) => s.tokens > 0);
  const zeroTrendSlot = trendSlots.find((s) => s.tokens === 0);
  assert.ok(activeTrendSlot);
  assert.equal(activeTrendSlot.tokens, 20_000);
  assert.equal(activeTrendSlot.inputTokens, 13_000);
  assert.equal(activeTrendSlot.cacheReadTokens, 3_000);
  assert.equal(activeTrendSlot.thinkingTokens, 200);
  assert.equal(activeTrendSlot.responseTokens, 3_800);
  assert.equal(activeTrendSlot.models.length, 2);
  const trendMainModel = activeTrendSlot.models[0];
  assert.equal(trendMainModel.inputTokens, 9_000);
  assert.equal(trendMainModel.cacheReadTokens, 3_000);
  assert.equal(trendMainModel.thinkingTokens, 200);
  assert.equal(trendMainModel.responseTokens, 2_800);
  if (zeroTrendSlot) {
    assert.equal(zeroTrendSlot.models, undefined);
  }
});

test('ConsumptionView renders the overview, model table, and compact usage trend tooltip', async (t) => {
  const prevLocale = i18nStore.getState().locale;
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevTelState = { ...telemetryStore.getState() };
  const prevUiState = { ...uiStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    location: { pathname: '/' },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };

  let view = null;
  t.after(() => {
    if (view) view.destroy();
    setI18nLanguage(prevLocale);
    telemetryStore.setState(prevTelState, { sync: true });
    uiStore.setState(prevUiState, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  setI18nLanguage('zh-CN');
  uiStore.setState(
    { monitorVisible: true, activeView: 'consumption', settingsOpen: false },
    { sync: true }
  );

  const mkModel = (name, tok, calls = 2, costUsd = 0.1) => ({
    label: name,
    shortName: name,
    upstreamName: name,
    calls,
    inputTokens: Math.floor(tok * 0.2),
    cacheReadTokens: Math.floor(tok * 0.6),
    outputTokens: Math.floor(tok * 0.2),
    responseTokens: Math.floor(tok * 0.15),
    thinkingTokens: tok - Math.floor(tok * 0.2) - Math.floor(tok * 0.6) - Math.floor(tok * 0.15),
    totalTokens: tok,
    costUsd,
    unpricedCalls: 0,
  });

  const mArgon = mkModel('4-argon', 50_000, 10, 0.5);
  const mCarbon = mkModel('4-carbon', 30_000, 6, 0.3);
  const mFlash = mkModel('3.8-flash-n', 18_000, 4, 0.12);
  const mTail1 = mkModel('opus-4-6-thinking', 800, 1, 0.02);
  const mTail2 = mkModel('3.1-flash-lite', 700, 1, 0.01);
  const mTail3 = mkModel('2.5-flash-lite', 500, 1, 0.01);

  const baseTelemetry = {
    settings: {
      language: 'zh-CN',
      modelDisplayMode: 'upstream',
      showUpstreamModel: true,
    },
    modelBreakdown: [mArgon, mCarbon, mFlash, mTail1, mTail2, mTail3],
    consumption: {
      selectedRange: { key: 'all', label: '全部', startMs: 1_700_000_000_000, endMs: 1_700_086_400_000 },
      account: {
        totalTokens: 100_000,
        inputTokens: 20_000,
        cacheReadTokens: 60_000,
        outputTokens: 20_000,
        responseTokens: 15_000,
        thinkingTokens: 5_000,
        calls: 23,
        costUsd: 0.96,
        savedCostUsd: 0.25,
        cacheHitPct: 75.0,
        avgTokPerSec: 88.4,
      },
      trendSeries: [
        {
          index: 0,
          granularity: 'day',
          label: '11/17',
          fullLabel: '11月17日 (周二)',
          tokens: 0,
          calls: 0,
          costUsd: 0,
        },
        {
          index: 1,
          granularity: 'day',
          label: '11/18',
          fullLabel: '11月18日 (周三)',
          tokens: 100_000,
          inputTokens: 20_000,
          cacheReadTokens: 60_000,
          thinkingTokens: 5_000,
          responseTokens: 15_000,
          outputTokens: 20_000,
          calls: 23,
          costUsd: 0.96,
          models: [mArgon, mCarbon, mFlash, mTail1, mTail2, mTail3],
        },
      ],
      sourcesBreakdown: [
        {
          name: 'Antigravity App',
          calls: 20,
          inputTokens: 15_000,
          cacheReadTokens: 50_000,
          totalTokens: 80_000,
          costUsd: 0.8,
          unpricedCalls: 0,
        },
        {
          name: 'Antigravity CLI',
          calls: 3,
          inputTokens: 5_000,
          cacheReadTokens: 10_000,
          totalTokens: 20_000,
          costUsd: 0.16,
          unpricedCalls: 0,
        },
      ],
    },
  };

  assert.equal(
    isEquivalentTelemetry(baseTelemetry, {
      ...baseTelemetry,
      consumption: {
        ...baseTelemetry.consumption,
        trendSeries: baseTelemetry.consumption.trendSeries.map((slot, index) =>
          index === 1 ? { ...slot, models: [mArgon] } : slot
        ),
      },
    }),
    false,
    'isEquivalentTelemetry must detect model breakdown changes inside trendSeries'
  );

  const rebalancedSources = structuredClone(baseTelemetry);
  rebalancedSources.consumption.sourcesBreakdown[0].inputTokens += 1_000;
  rebalancedSources.consumption.sourcesBreakdown[0].cacheReadTokens -= 1_000;
  rebalancedSources.consumption.sourcesBreakdown[1].inputTokens -= 1_000;
  rebalancedSources.consumption.sourcesBreakdown[1].cacheReadTokens += 1_000;
  assert.equal(isEquivalentTelemetry(baseTelemetry, rebalancedSources), false);

  telemetryStore.setState(
    { selectedTimeRange: 'all', telemetry: baseTelemetry },
    { sync: true }
  );

  view = ConsumptionView({});
  document.body.appendChild(view.el);
  await Promise.resolve();

  const modelRows = view.el.querySelectorAll('.cons-model-tr');
  const sourceRows = view.el.querySelectorAll('.cons-source-row');
  assert.equal(modelRows.length, 6);
  assert.equal(sourceRows.length, 0);

  // 1. Overview & Magpie-style Models Table: 4-col overview with token breakdown subtext + avg speed; table renders all metrics sorted by Token desc
  assert.match(view.el.querySelector('.cons-hero-sub')?.textContent || '', /20\.0k.*60\.0k.*20\.0k/);
  assert.deepEqual(
    view.el.querySelectorAll('.cons-hero-sub .dot-swatch').map((el) => el.className),
    ['dot-swatch seg-input', 'dot-swatch seg-cached', 'dot-swatch seg-output']
  );
  assert.equal(view.el.querySelector('.cons-hero-speed')?.textContent, '88.4 tok/s');
  assert.equal(modelRows[0].children[0].textContent, '4-argon');
  assert.equal(modelRows[0].children[1].textContent, '50.0%');
  assert.equal(modelRows[0].children[2].textContent, '50.0k');
  assert.equal(modelRows[0].children[3].textContent, '$0.50');
  assert.equal(modelRows[0].children[7].textContent, '10');

  // 2. Client Sources panel removed cleanly from ConsumptionView
  assert.equal((view.el.textContent || '').includes('客户端来源'), false);

  // 3. No duplicate bottom heatmap or monthly panel
  assert.equal(view.el.querySelector('.cons-heatmap-panel'), null);
  assert.equal(view.el.querySelectorAll('.monthly-grid').length, 0);

  // 4. Usage Trend: taller 184px viewBox & hovering x-axis tick opens compact tooltip (time + calls, hero TOKEN + cost, concise model + share lines without progress bars or 4-channel micro-grid)
  const trendSvg = view.el.querySelector('.trend-svg');
  assert.match(trendSvg?.getAttribute('viewBox') || '', /\s184$/);
  const trendTicks = view.el.querySelectorAll('.trend-x-tick');
  assert.equal(trendTicks.length, 2);
  trendTicks[1].onclick();
  const trendTip = view.el.querySelector('.trend-tooltip');
  assert.equal(trendTip?.hasAttribute('hidden'), false);
  assert.equal(trendTip.querySelector('.trend-tip-time')?.textContent, '11月18日 (周三)');
  assert.equal(trendTip.querySelector('.trend-tip-calls')?.textContent, '23 次');
  assert.match(trendTip.querySelector('.trend-tip-tokens')?.textContent || '', /100\.0k TOKEN/);
  assert.equal(trendTip.querySelector('.trend-tip-cost')?.textContent, '$0.96');
  const trendTipModelRows = trendTip.querySelectorAll('.cons-pop-model-row');
  assert.equal(trendTipModelRows.length, 4);
  assert.deepEqual(
    trendTipModelRows.map((row) => row.querySelector('.cons-pop-model-name')?.textContent),
    ['4-argon', '4-carbon', '3.8-flash-n', '其他 (3)']
  );
  assert.deepEqual(
    trendTipModelRows.map((row) => row.querySelector('.cons-pop-model-pct')?.textContent),
    ['50.0%', '30.0%', '18.0%', '2.0%']
  );
  assert.equal(trendTip.querySelectorAll('.progress-seg').length, 0);
  assert.equal(trendTip.querySelector('.cons-pop-channels'), null);

  const histogramTelemetry = structuredClone(baseTelemetry);
  delete histogramTelemetry.consumption.account.avgTokPerSec;
  histogramTelemetry.modelBreakdown = [
    { ...mArgon, avgTokPerSec: 100, speedSummary: { avgTokPerSec: 100, rateBins: { 632: 3 } } },
    { ...mCarbon, avgTokPerSec: 10, speedSummary: { avgTokPerSec: 10, rateBins: { 516: 1 } } },
  ];
  telemetryStore.setState({ telemetry: histogramTelemetry }, { sync: true });
  await Promise.resolve();
  assert.equal(view.el.querySelector('.cons-hero-speed')?.textContent, '99.9 tok/s');
});

test('selectConsumptionTimeRange serves prefetched presets with 0 network calls, blocks stale 2s poll overwrites, and TrendAreaChart heatmap batches via DocumentFragment', async (t) => {
  const prevTelState = { ...telemetryStore.getState() };
  const prevDoc = globalThis.document;
  t.after(() => {
    stopAsyncTelemetryLoop();
    clearConsumptionRangeCache();
    telemetryStore.setState(prevTelState, { sync: true });
    globalThis.document = prevDoc;
  });

  clearConsumptionRangeCache();
  const mkSlice = (key, label, totalTokens, rev = 7) => ({
    revision: rev,
    selectedRange: { key, label, startMs: 1_700_000_000_000, endMs: 1_700_086_400_000 },
    session: { totalTokens },
    account: { totalTokens, calls: 2, inputTokens: totalTokens, cacheReadTokens: 0, outputTokens: 0, costUsd: 0.1, savedCostUsd: 0, cacheHitPct: 0 },
    trendSeries: [{ index: 0, label: '11/19', fullLabel: '11月19日', tokens: totalTokens, calls: 2, costUsd: 0.1 }],
    sourcesBreakdown: [{ name: 'Antigravity App', calls: 2, totalTokens, costUsd: 0.1 }],
    modelBreakdown: [{ label: 'Claude 4.5 Sonnet', shortName: 'Sonnet 4.5', calls: 2, totalTokens, costUsd: 0.1 }],
  });

  const baseTelemetry = {
    account: { email: 'u@example.com', status: 'signedIn' },
    settings: { language: 'zh-CN', weeklyLimitMode: 'official' },
    cloudStatus: { catalogVersion: 'v1' },
    activeConversation: { cascadeId: 'c1', recentSteps: [], agents: [] },
    consumption: {
      ...mkSlice('today', '今日', 1000, 7),
      presets: { today: { label: '今日', account: { totalTokens: 1000 } } },
    },
    modelBreakdown: mkSlice('today', '今日', 1000, 7).modelBreakdown,
  };
  telemetryStore.setState({ selectedTimeRange: 'today', telemetry: baseTelemetry }, { sync: true });

  const requestedUrls = [];
  let resolveStalePoll = null;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    requestedUrls.push(u);
    if (u.includes('scope=consumption-presets')) {
      return {
        ok: true,
        json: async () => ({
          scope: 'consumption-presets',
          usageRevision: 7,
          ranges: {
            today: mkSlice('today', '今日', 1000, 7),
            '24h': mkSlice('24h', '近 24 小时', 1500, 7),
            '7d': mkSlice('7d', '近 7 天', 7000, 7),
            '14d': mkSlice('14d', '近 14 天', 14000, 7),
            '30d': mkSlice('30d', '近 30 天', 30000, 7),
            all: mkSlice('all', '全部时间', 90000, 7),
          },
        }),
      };
    }
    if (u.includes('scope=consumption') && u.includes('range=30d')) {
      return {
        ok: true,
        json: async () => ({
          scope: 'consumption',
          usageRevision: 8,
          consumption: mkSlice('30d', '近 30 天', 31000, 8),
          modelBreakdown: mkSlice('30d', '近 30 天', 31000, 8).modelBreakdown,
        }),
      };
    }
    // Simulated slow 2s background poll started on 'today' that resolves later with rev=8
    return {
      ok: true,
      json: async () =>
        new Promise((resolve) => {
          resolveStalePoll = () =>
            resolve({
              ...baseTelemetry,
              consumption: {
                ...baseTelemetry.consumption,
                ...mkSlice('today', '今日', 1200, 8),
              },
              modelBreakdown: mkSlice('today', '今日', 1200, 8).modelBreakdown,
            });
        }),
    };
  });

  // 1. Entering ConsumptionView prefetches all 6 presets once
  assert.equal(await prefetchConsumptionPresets(), true);
  assert.equal(requestedUrls.length, 1);
  assert.match(requestedUrls[0], /scope=consumption-presets/);

  // 2. Switching across presets hits rangeCache with ZERO network requests and atomic state swap
  await selectConsumptionTimeRange('7d');
  assert.equal(requestedUrls.length, 1, 'Cached preset switch must issue 0 HTTP requests');
  assert.equal(telemetryStore.getState().selectedTimeRange, '7d');
  assert.equal(telemetryStore.getState().telemetry.consumption.selectedRange.key, '7d');
  assert.equal(telemetryStore.getState().telemetry.consumption.account.totalTokens, 7000);

  await selectConsumptionTimeRange('today');
  assert.equal(requestedUrls.length, 1);

  // 3. Stale in-flight 2s background poll ('today', rev=8) finishes AFTER user switched to '30d' locally:
  // must NOT overwrite view back to 'today', and should trigger silent background revalidation for '30d'
  const stalePollPromise = fetchTelemetry({ force: false });
  await Promise.resolve();
  await selectConsumptionTimeRange('30d');
  assert.equal(telemetryStore.getState().telemetry.consumption.selectedRange.key, '30d');
  assert.equal(telemetryStore.getState().telemetry.consumption.account.totalTokens, 30000);

  assert.equal(typeof resolveStalePoll, 'function');
  resolveStalePoll();
  await stalePollPromise;
  // Wait microtasks for silent background scope=consumption revalidation of 30d
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(telemetryStore.getState().selectedTimeRange, '30d');
  assert.equal(telemetryStore.getState().telemetry.consumption.selectedRange.key, '30d');
  assert.equal(telemetryStore.getState().telemetry.consumption.account.totalTokens, 31000);

  // 4. TrendAreaChart >90d heatmap builds all cells cleanly via DocumentFragment when available
  const { document } = createMockDom();
  let fragUsed = false;
  document.createDocumentFragment = () => {
    fragUsed = true;
    const holder = document.createElement('div');
    holder.isFragment = true;
    return holder;
  };
  const origAppend = Object.getPrototypeOf(document.createElement('div')).appendChild;
  globalThis.document = document;
  const chart = createTrendAreaChart();
  const hmGrid = chart.el.querySelector('.trend-hm-grid');
  hmGrid.appendChild = function (node) {
    if (node?.isFragment) {
      for (const child of [...(node.children || [])]) {
        origAppend.call(this, child);
      }
      return node;
    }
    return origAppend.call(this, node);
  };
  const startDay = Date.parse('2026-06-01T00:00:00.000Z');
  const slots = Array.from({ length: 100 }, (_, i) => ({
    index: i,
    granularity: 'day',
    startMs: startDay + i * 86400_000,
    label: `D${i}`,
    fullLabel: `Day ${i}`,
    tokens: (i % 5) * 1000,
    calls: i % 5,
    costUsd: 0.05,
  }));
  chart.update(slots);
  assert.equal(fragUsed, true);
  assert.equal(
    chart.el.querySelectorAll('.trend-hm-cell').filter((c) => !c.classList.contains('is-pad')).length,
    100
  );
  chart.destroy();
});

test('ConsumptionView >90d heatmap replaces static hint with Day/Week/Month/Total 7xW LED matrix switcher, rich tooltips, and drill-down', async (t) => {
  const prevLocale = i18nStore.getState().locale;
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevTelState = { ...telemetryStore.getState() };
  const prevUiState = { ...uiStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    location: { pathname: '/' },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };

  let view = null;
  t.after(() => {
    stopAsyncTelemetryLoop();
    clearConsumptionRangeCache();
    if (view) view.destroy();
    setI18nLanguage(prevLocale);
    telemetryStore.setState(prevTelState, { sync: true });
    uiStore.setState(prevUiState, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ scope: 'noop' }),
  }));

  setI18nLanguage('zh-CN');
  uiStore.setState(
    { monitorVisible: true, activeView: 'consumption', settingsOpen: false },
    { sync: true }
  );

  // Build 105 daily slots (15 exact weeks starting Monday 2026-08-03 local midnight)
  const firstMondayMs = new Date(2026, 7, 3, 0, 0, 0, 0).getTime();
  const dayMs = 86_400_000;
  const pad2 = (n) => String(n).padStart(2, '0');
  const trendSlots = Array.from({ length: 105 }, (_, i) => {
    const sMs = firstMondayMs + i * dayMs;
    const d = new Date(sMs);
    const lbl = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
    const weekIdx = Math.floor(i / 7);
    // Week 0 = 0 tokens; Week 1 = 20k/day (140k total); Week 2 = peak 100k/day (700k total); others = 40k/day
    const dailyTok =
      weekIdx === 0 ? 0 : weekIdx === 1 ? 20_000 : weekIdx === 2 ? 100_000 : 40_000;
    return {
      index: i,
      granularity: 'day',
      startMs: sMs,
      endMs: sMs + dayMs,
      label: lbl,
      fullLabel: lbl,
      tokens: dailyTok,
      inputTokens: Math.floor(dailyTok * 0.25),
      cacheReadTokens: Math.floor(dailyTok * 0.5),
      thinkingTokens: Math.floor(dailyTok * 0.1),
      responseTokens: Math.floor(dailyTok * 0.15),
      outputTokens: Math.floor(dailyTok * 0.25),
      calls: dailyTok > 0 ? 4 : 0,
      costUsd: dailyTok > 0 ? +(dailyTok / 100_000).toFixed(2) : 0,
      models:
        dailyTok > 0
          ? [
              {
                label: 'Claude Opus 4.6',
                shortName: 'Opus 4.6',
                upstreamName: 'opus-4-6',
                calls: 4,
                inputTokens: Math.floor(dailyTok * 0.25),
                cacheReadTokens: Math.floor(dailyTok * 0.5),
                thinkingTokens: Math.floor(dailyTok * 0.1),
                responseTokens: Math.floor(dailyTok * 0.15),
                outputTokens: Math.floor(dailyTok * 0.25),
                totalTokens: dailyTok,
                costUsd: +(dailyTok / 100_000).toFixed(2),
              },
            ]
          : undefined,
    };
  });

  const makePayload = (rangeKey, slots) => ({
    settings: { language: 'zh-CN', modelDisplayMode: 'short' },
    modelBreakdown: [],
    consumption: {
      revision: 1,
      selectedRange: {
        key: rangeKey,
        label: rangeKey === 'all' ? '全部时间' : '近 7 天',
        startMs: slots[0].startMs,
        endMs: slots[slots.length - 1].endMs - 1,
      },
      account: {
        totalTokens: 4_480_000,
        inputTokens: 1_120_000,
        cacheReadTokens: 2_240_000,
        outputTokens: 1_120_000,
        responseTokens: 672_000,
        thinkingTokens: 448_000,
        calls: 392,
        costUsd: 44.8,
        savedCostUsd: 12.0,
        cacheHitPct: 66.7,
      },
      trendSeries: slots,
      sourcesBreakdown: [],
    },
  });

  // 1. <=90d (7 days): static hint removed, heatmap switcher hidden
  telemetryStore.setState(
    { selectedTimeRange: '7d', telemetry: makePayload('7d', trendSlots.slice(0, 7)) },
    { sync: true }
  );
  view = ConsumptionView({});
  document.body.appendChild(view.el);
  await Promise.resolve();

  assert.equal(view.el.querySelector('.cons-trend-hint'), null);
  const hmSwitchEl = view.refs.heatmapModeSwitch.el;
  assert.equal(hmSwitchEl.hasAttribute('hidden'), true);

  // 2. >90d (105 days = 15 weeks): 4-way switcher visible ('日' / '周' / '月' / '全部')
  telemetryStore.setState(
    { selectedTimeRange: 'all', telemetry: makePayload('all', trendSlots) },
    { sync: true }
  );
  await Promise.resolve();

  assert.equal(hmSwitchEl.hasAttribute('hidden'), false, '4-mode switcher must be shown on >90d');
  const modeBtns = hmSwitchEl.querySelectorAll('.seg-btn');
  assert.deepEqual(
    modeBtns.map((b) => b.textContent),
    ['日', '周', '月', '全部']
  );

  const hmWeekdaysEl = view.el.querySelector('.trend-hm-weekdays');
  const hmGridEl = view.el.querySelector('.trend-hm-grid');
  const hmSummaryEl = view.el.querySelector('.trend-hm-summary');
  const trendTip = view.el.querySelector('.trend-tooltip');

  // Default 'day' mode: weekday labels visible, 105 cells
  assert.equal(view.refs.trendChart.getHeatmapMode(), 'day');
  assert.equal(hmWeekdaysEl.style.visibility, '');
  assert.equal(hmGridEl.children.length, 105);
  assert.match(hmSummaryEl.textContent || '', /活跃 98\/105 天/);

  // 3. Switch to 'week' mode: keeps exact 105-cell (7x15) grid, hides weekday labels in-place, lights bottom-up LED columns
  modeBtns[1].dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(view.refs.trendChart.getHeatmapMode(), 'week');
  assert.equal(hmWeekdaysEl.style.visibility, 'hidden');
  assert.equal(hmGridEl.children.length, 105);
  assert.match(hmSummaryEl.textContent || '', /活跃 14\/15 周/);

  const colCells = (col) =>
    [...hmGridEl.children].filter((c) => Number(c.getAttribute('data-hm-col')) === col);
  const litRowsInCol = (col) =>
    colCells(col)
      .filter((c) => !c.classList.contains('lv-0'))
      .map((c) => Number(c.getAttribute('data-hm-row')));

  // Week 0 has 0 tokens -> 0 lit rows; Week 1 has 140k/700k = 20% -> ceil(1.4) = 2 bottom rows [5, 6]; Week 2 is peak 700k -> all 7 rows [0..6]
  assert.deepEqual(litRowsInCol(0), []);
  assert.deepEqual(litRowsInCol(1), [5, 6]);
  assert.deepEqual(litRowsInCol(2), [0, 1, 2, 3, 4, 5, 6]);

  // Hovering top unlit cell (row 0) of Week 1 still highlights Week 1's lit bar [row 5, row 6] and shows compact aggregated weekly tooltip
  hmGridEl.dispatchEvent({ type: 'mouseover', target: colCells(1)[0], clientX: 40, clientY: 20 });
  assert.equal(trendTip.hasAttribute('hidden'), false);
  assert.equal(trendTip.querySelector('.trend-tip-time')?.textContent, '8月10日 ~ 16日');
  assert.equal(trendTip.querySelector('.trend-tip-calls')?.textContent, '28 次');
  assert.match(trendTip.querySelector('.trend-tip-tokens')?.textContent || '', /140\.0k TOKEN/);
  assert.equal(trendTip.querySelector('.trend-tip-cost')?.textContent, '$1.40');
  assert.equal(trendTip.querySelectorAll('.cons-pop-model-row').length, 1);
  assert.equal(trendTip.querySelector('.cons-pop-model-name')?.textContent, 'Claude Opus 4.6');
  assert.equal(trendTip.querySelector('.cons-pop-model-pct')?.textContent, '100%');
  assert.equal(trendTip.querySelectorAll('.progress-seg').length, 0);
  assert.equal(trendTip.querySelector('.cons-pop-channels'), null);
  assert.equal(colCells(1)[5].classList.contains('is-bar-hovered'), true);
  assert.equal(colCells(1)[6].classList.contains('is-bar-hovered'), true);
  assert.equal(colCells(1)[0].classList.contains('is-bar-hovered'), false);

  // 4. Switch to 'month' mode: columns group by dominant calendar month with month-edge markers and monthly tooltip
  modeBtns[2].dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(view.refs.trendChart.getHeatmapMode(), 'month');
  assert.equal(hmGridEl.children.length, 105);
  assert.match(hmSummaryEl.textContent || '', /月 · 峰值/);
  assert.ok(
    [...hmGridEl.children].some((c) => c.classList.contains('is-month-edge')),
    'Month mode should mark boundary columns between adjacent months'
  );
  hmGridEl.dispatchEvent({ type: 'mouseover', target: colCells(0)[6], clientX: 20, clientY: 60 });
  assert.equal(trendTip.querySelector('.trend-tip-time')?.textContent, '2026年 8月');
  assert.equal(trendTip.querySelector('.trend-tip-calls')?.textContent, '88 次');
  assert.match(trendTip.querySelector('.trend-tip-tokens')?.textContent || '', /1\.16M TOKEN/i);
  assert.equal(trendTip.querySelector('.cons-pop-model-pct')?.textContent, '100%');

  // 5. Switch to 'all' (cumulative) mode: monotonic bottom-up growth ramp reaching 7 rows on last column
  modeBtns[3].dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(view.refs.trendChart.getHeatmapMode(), 'all');
  assert.equal(hmGridEl.children.length, 105);
  let prevLitCount = 0;
  for (let col = 0; col < 15; col++) {
    const cnt = litRowsInCol(col).length;
    assert.ok(cnt >= prevLitCount, `Cumulative column ${col} must be non-decreasing`);
    prevLitCount = cnt;
  }
  assert.equal(prevLitCount, 7, 'Final cumulative column must reach full 7-row height');
  hmGridEl.dispatchEvent({ type: 'mouseover', target: colCells(14)[0], clientX: 200, clientY: 20 });
  assert.match(trendTip.querySelector('.trend-tip-time')?.textContent || '', /^截至 .+ 累计$/);
  assert.match(hmSummaryEl.textContent || '', /^累计 105 天/);

  // 6. Locale switch updates switcher labels ('Day' / 'Week' / 'Month' / 'Total') and summary text
  setI18nLanguage('en-US');
  await Promise.resolve();
  assert.deepEqual(
    hmSwitchEl.querySelectorAll('.seg-btn').map((b) => b.textContent),
    ['Day', 'Week', 'Month', 'Total']
  );
  assert.match(hmSummaryEl.textContent || '', /^Cumulative 105d/);

  // 7. Clicking a week bar in 'week' mode drills down into custom time range for that week
  setI18nLanguage('zh-CN');
  await Promise.resolve();
  hmSwitchEl.dispatchEvent({ type: 'noop' });
  hmSwitchEl.querySelectorAll('.seg-btn')[1].dispatchEvent({ type: 'click', stopPropagation() {} });

  // 7a. Cross-review regression: moving tokens among daily tail models in week mode refreshes aggregate weekly leader
  const mkDayWithHiddenTail = (dayIdx, tailXTok, tailYTok) => [
    { label: `Day${dayIdx}-A`, shortName: `Day${dayIdx}-A`, calls: 1, totalTokens: 30_000 },
    { label: `Day${dayIdx}-B`, shortName: `Day${dayIdx}-B`, calls: 1, totalTokens: 25_000 },
    { label: `Day${dayIdx}-C`, shortName: `Day${dayIdx}-C`, calls: 1, totalTokens: 20_000 },
    { label: 'Tail X', shortName: 'Tail X', calls: 1, totalTokens: tailXTok },
    { label: 'Tail Y', shortName: 'Tail Y', calls: 1, totalTokens: tailYTok },
  ];
  const weekTailPayload1 = makePayload(
    'all',
    trendSlots.map((slot, idx) =>
      idx >= 14 && idx <= 20
        ? { ...slot, tokens: 85_000, models: mkDayWithHiddenTail(idx, 9_000, 1_000) }
        : slot
    )
  );
  weekTailPayload1.consumption.revision = 10;
  telemetryStore.setState({ selectedTimeRange: 'all', telemetry: weekTailPayload1 }, { sync: true });
  await Promise.resolve();
  hmGridEl.dispatchEvent({ type: 'mouseover', target: colCells(2)[3], clientX: 60, clientY: 40 });
  assert.equal(
    trendTip.querySelector('.cons-pop-model-name')?.textContent,
    'Tail X',
    'Weekly aggregation promotes cumulative Tail X to #1 even when hidden in daily Others'
  );

  const weekTailPayload2 = makePayload(
    'all',
    trendSlots.map((slot, idx) =>
      idx >= 14 && idx <= 20
        ? { ...slot, tokens: 85_000, models: mkDayWithHiddenTail(idx, 1_000, 9_000) }
        : slot
    )
  );
  weekTailPayload2.consumption.revision = 11;
  assert.equal(
    isEquivalentTelemetry(weekTailPayload1, {
      ...weekTailPayload1,
      consumption: { ...weekTailPayload1.consumption, revision: 11 },
    }),
    false,
    'isEquivalentTelemetry must detect consumption.revision bumps even when visible window totals match'
  );
  telemetryStore.setState({ selectedTimeRange: 'all', telemetry: weekTailPayload2 }, { sync: true });
  await Promise.resolve();
  hmGridEl.dispatchEvent({ type: 'mouseover', target: colCells(2)[3], clientX: 60, clientY: 40 });
  assert.equal(
    trendTip.querySelector('.cons-pop-model-name')?.textContent,
    'Tail Y',
    'Shifting tokens between daily tail models must invalidate weekly heatmap signature and update leader'
  );

  hmGridEl.dispatchEvent({ type: 'click', target: colCells(2)[3], clientX: 60, clientY: 40 });
  assert.equal(telemetryStore.getState().selectedTimeRange, 'custom');
  assert.equal(telemetryStore.getState().customStartMs, firstMondayMs + 14 * dayMs);
});
