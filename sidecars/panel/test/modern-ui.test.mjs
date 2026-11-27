import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMockDom } from './mock-dom.mjs';
import {
  DEFAULT_SETTINGS_SCHEMA,
  normalizeExperimentalModernUi,
  normalizeFullSettings,
  normalizeModernUi,
} from '../backend/settings-schema.mjs';
import {
  applyAppearanceToRoot,
  detectHostColorScheme,
  normalizeClientModernUi,
  parseCssColorLuminance,
} from '../src/core/appearance.js';
import { createTrendAreaChart } from '../src/components/charts/TrendAreaChart.js';
import { CustomSelect } from '../src/components/ui/CustomSelect.js';
import { SegmentedControl } from '../src/components/ui/SegmentedControl.js';
import {
  buildCapsuleSlotContext,
  createCapsuleSlotNode,
  patchCapsuleOdometerText,
  syncCapsuleSlotNodes,
  tokenizeCapsuleOdometerText,
} from '../src/components/widgets/CapsuleBarWidget.js';
import { ContextWindowWidget } from '../src/components/widgets/ContextWindowWidget.js';
import { LiveActivityWidget } from '../src/components/widgets/LiveActivityWidget.js';
import { StepTableWidget } from '../src/components/widgets/StepTableWidget.js';
import {
  fetchTelemetry,
  isEquivalentTelemetry,
  saveSettingsPatch,
  stopAsyncTelemetryLoop,
  telemetryStore,
} from '../src/store/telemetryStore.js';
import { uiStore } from '../src/store/uiStore.js';
import { i18nStore, setI18nLanguage } from '../src/i18n/index.js';
import { ConsumptionView } from '../src/views/ConsumptionView.js';
import { StepsDetailView } from '../src/views/StepsDetailView.js';

test('modernUi schema normalization defaults to true, upgrades 1.5.2 settings without modernUi key to true, and respects explicit false', () => {
  assert.equal(DEFAULT_SETTINGS_SCHEMA.language, 'auto');
  assert.equal(DEFAULT_SETTINGS_SCHEMA.modernUi, true);
  assert.equal(DEFAULT_SETTINGS_SCHEMA.experimentalModernUi, true);
  assert.equal(normalizeModernUi(undefined), true);
  assert.equal(normalizeModernUi(false), false);
  assert.equal(normalizeModernUi('off'), false);
  assert.equal(normalizeModernUi(true), true);
  assert.equal(normalizeModernUi('true'), true);
  assert.equal(normalizeModernUi('on'), true);
  assert.equal(normalizeExperimentalModernUi(undefined), false);
  assert.equal(normalizeClientModernUi(undefined), true);
  assert.equal(normalizeClientModernUi('on'), true);
  assert.equal(normalizeClientModernUi(false), false);
  assert.equal(normalizeClientModernUi('off'), false);

  // Fresh 1.5.3 install -> language='auto', modernUi=true
  assert.equal(normalizeFullSettings({}).language, 'auto');
  assert.equal(normalizeFullSettings({}).modernUi, true);
  assert.equal(normalizeFullSettings({}).experimentalModernUi, true);

  // 1.5.2 persisted settings.json (where experimentalModernUi: false was written by default, no modernUi key) -> upgrades to true!
  const upgradedFrom152 = normalizeFullSettings({ experimentalModernUi: false });
  assert.equal(upgradedFrom152.modernUi, true);
  assert.equal(upgradedFrom152.experimentalModernUi, true);

  // Explicit 1.5.3 user opt-out (`modernUi: false`) -> stays false!
  const explicitOff153 = normalizeFullSettings({ modernUi: false, experimentalModernUi: true });
  assert.equal(explicitOff153.modernUi, false);
  assert.equal(explicitOff153.experimentalModernUi, false);

  assert.equal(
    isEquivalentTelemetry(
      { settings: { modernUi: false } },
      { settings: { modernUi: true } }
    ),
    false,
    'isEquivalentTelemetry must detect modernUi changes'
  );
});

test('detectHostColorScheme accurately distinguishes light vs dark host polarity across classes, CSS colors, and media queries', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    getComputedStyle: () => null,
    matchMedia: () => ({ matches: false }),
  };

  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  assert.ok(parseCssColorLuminance('#ffffff') > 0.99);
  assert.ok(parseCssColorLuminance('#18181b') < 0.15);
  assert.ok(parseCssColorLuminance('rgb(255, 255, 255)') > 0.99);
  assert.ok(parseCssColorLuminance('rgb(21, 24, 30)') < 0.15);
  assert.equal(parseCssColorLuminance('rgba(0, 0, 0, 0)'), null);

  // 1. Light webview on a Dark OS: explicit vscode-light class wins over prefers-color-scheme: dark
  globalThis.window.matchMedia = () => ({ matches: true });
  document.body.className = 'vscode-light';
  assert.equal(detectHostColorScheme(document.documentElement), 'light');

  // 2. Dark class wins cleanly
  document.body.className = 'vscode-dark';
  assert.equal(detectHostColorScheme(document.documentElement), 'dark');

  // 3. Computed surface luminance when no explicit theme class is present
  document.body.className = '';
  globalThis.window.getComputedStyle = (el) => {
    if (el === document.body) {
      return {
        backgroundColor: 'rgb(255, 255, 255)',
        color: 'rgb(24, 24, 27)',
        getPropertyValue: () => '',
      };
    }
    return null;
  };
  assert.equal(detectHostColorScheme(document.documentElement), 'light');

  globalThis.window.getComputedStyle = (el) => {
    if (el === document.body) {
      return {
        backgroundColor: 'rgb(24, 24, 27)',
        color: 'rgb(244, 244, 245)',
        getPropertyValue: () => '',
      };
    }
    return null;
  };
  assert.equal(detectHostColorScheme(document.documentElement), 'dark');
});

test('applyAppearanceToRoot toggles data-modern-ui + data-color-scheme and bundle includes crisp light-mode rules', async (t) => {
  const prevLocale = i18nStore.getState().locale;
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevTelState = { ...telemetryStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;
  document.body.className = 'vscode-light';
  globalThis.window = {
    location: { pathname: '/' },
    addEventListener() {},
    removeEventListener() {},
  };

  t.after(() => {
    setI18nLanguage(prevLocale);
    telemetryStore.setState(prevTelState, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  setI18nLanguage('zh-CN');

  // 1. Default off -> no data-modern-ui attribute, stamps data-color-scheme="light"
  applyAppearanceToRoot(document.documentElement, { experimentalModernUi: false });
  assert.equal(document.documentElement.hasAttribute('data-modern-ui'), false);
  assert.equal(document.documentElement.getAttribute('data-color-scheme'), 'light');

  applyAppearanceToRoot(document.documentElement, { experimentalModernUi: true });
  assert.equal(document.documentElement.getAttribute('data-modern-ui'), 'true');
  assert.equal(document.documentElement.getAttribute('data-color-scheme'), 'light');

  document.body.className = 'vscode-dark';
  applyAppearanceToRoot(document.documentElement, { experimentalModernUi: true });
  assert.equal(document.documentElement.getAttribute('data-color-scheme'), 'dark');

  document.body.className = 'vscode-light';
  applyAppearanceToRoot(document.documentElement, { experimentalModernUi: false });
  assert.equal(document.documentElement.hasAttribute('data-modern-ui'), false);
  assert.equal(document.documentElement.getAttribute('data-color-scheme'), 'light');

  // 2. Built styles.css contains modern-ui borderless, sliding glider, and crisp pure-white light-mode rules
  const builtStyles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(builtStyles, /\[data-modern-ui="true"\]\s+\.panel/);
  assert.match(builtStyles, /\[data-modern-ui="true"\]\[data-color-scheme="light"\]/);
  assert.match(builtStyles, /--modern-surface-card:\s*#ffffff;/);
  assert.match(builtStyles, /--modern-glider-bg:\s*#ffffff;/);
  assert.match(
    builtStyles,
    /--text-secondary:\s*color-mix\(in srgb,\s*var\(--text-primary\)\s*80%,\s*transparent\);/
  );
  assert.match(
    builtStyles,
    /--text-muted:\s*color-mix\(in srgb,\s*var\(--text-primary\)\s*62%,\s*transparent\);/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.ctx-agent-pill\.is-more-toggle\s*\{[^}]*color:\s*var\(--text-secondary\);/
  );
  assert.match(builtStyles, /\.seg-glider\.is-ready/);
  assert.match(builtStyles, /\.thirdnav-glider/);
  assert.match(builtStyles, /\.segmented\s*\{[^}]*width:\s*fit-content;[^}]*\}/);
  assert.doesNotMatch(builtStyles, /#000000/);
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.dual-grid\s*>\s*\.matrix-cell\s*\{[^}]*background:\s*transparent;/
  );
  assert.match(
    builtStyles,
    /\.cons-custom-range-bar\s*\{[^}]*background:\s*transparent;/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.steps-data-table\s+tbody\s+tr\.is-step-entering/
  );
  assert.doesNotMatch(
    builtStyles,
    /(?:^|\n)\.steps-data-table\s+tbody\s+tr\.is-step-entering/,
    'Step row enter animation must ONLY exist under [data-modern-ui="true"]'
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.trend-tooltip\.is-tracking\s*\{[^}]*150ms/
  );
  assert.match(
    builtStyles,
    /\.trend-tip-sub\s*\{[^}]*background:\s*transparent;/
  );
  assert.match(
    builtStyles,
    /\.trend-tip-cost\s*\{[^}]*background:\s*transparent;/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.trend-tip-sub,\s*\[data-modern-ui="true"\]\s+\.trend-tip-cost\s*\{[^}]*background:\s*transparent;/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\.wm-multi-panel\s+\.live-task-card[\s\S]*?background:\s*transparent;/
  );
  assert.match(
    builtStyles,
    /:host\(\.wm-portal-host\)\s*\{[^}]*font-stretch:\s*100%;[^}]*font-variation-settings:\s*normal;[^}]*letter-spacing:\s*normal;/s,
    'Portal Shadow host must reset inherited host font-stretch/variation/letter-spacing to match sidebar typography'
  );
  assert.match(
    builtStyles,
    /\.wm-multi-panel\s+\.live-task-card\s*\{[^}]*gap:\s*7px;[^}]*padding:\s*10px\s+0;/s,
    'Floating multi-session task cards must match sidebar 7px row gap and 0px horizontal inset alignment'
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\.wm-multi-panel\s+\.live-task-card:last-child[\s\S]*?padding-bottom:\s*0;/,
    'Modern UI multi-session panel must preserve symmetric bottom padding on last task card'
  );
  assert.match(
    builtStyles,
    /\.ctx-inspector-bar\s*\{[^}]*align-items:\s*flex-start;/,
    'ctx-inspector-bar must top-align pills so height clip never hides row 1 during expand/collapse'
  );
  assert.match(
    builtStyles,
    /@keyframes\s+anim-modern-step-row-in\s*\{\s*0%\s*\{[^}]*opacity:\s*0;[^}]*background-color:\s*transparent;[\s\S]*?100%\s*\{[^}]*opacity:\s*1;[^}]*background-color:\s*transparent;/,
    'Step row fade-in must start and end with transparent background to avoid abrupt flashes'
  );
  assert.doesNotMatch(
    builtStyles,
    /scrollbar-width:\s*thin/,
    'No element may opt into Chromium native scrollbar-width: thin'
  );
});

test('SegmentedControl variable-width glider snaps cleanly on reveal and glides across variable-width buttons', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevUiState = { ...uiStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;
  let queuedRaf = null;
  globalThis.window = {
    requestAnimationFrame: (cb) => {
      queuedRaf = cb;
      return 1;
    },
    cancelAnimationFrame: () => {
      queuedRaf = null;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  let seg = null;
  t.after(() => {
    seg?.destroy();
    uiStore.setState(prevUiState, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  // 1. Hidden / 0x0 fallback -> no .has-glider, button fallback active
  const picked = [];
  seg = SegmentedControl({
    ariaLabel: '视图切换',
    modelValue: 'steps',
    options: [
      { value: 'steps', label: '按步查看 (1520)' },
      { value: 'models', label: '总汇总' },
    ],
    onUpdateModelValue: (v) => picked.push(v),
  });

  const glider = seg.refs.gliderEl;
  const btns = seg.el.querySelectorAll('.seg-btn');
  assert.equal(seg.el.children[0], glider, '.seg-glider stays at child index 0');
  assert.equal(seg.el.classList.contains('has-glider'), false);
  assert.equal(glider.classList.contains('is-ready'), false);

  // 2. Simulate layout reveal with variable widths: btn0 = 114px @ x=3, btn1 = 56px @ x=119
  Object.assign(btns[0], { offsetLeft: 3, offsetTop: 3, offsetWidth: 114, offsetHeight: 22 });
  Object.assign(btns[1], { offsetLeft: 119, offsetTop: 3, offsetWidth: 56, offsetHeight: 22 });

  seg.refs.refreshGlider();
  assert.equal(seg.el.classList.contains('has-glider'), true);
  assert.equal(glider.style.getPropertyValue('--glider-x'), '3px');
  assert.equal(glider.style.getPropertyValue('--glider-w'), '114px');
  assert.equal(
    glider.classList.contains('is-ready'),
    false,
    'Initial visible snap must not animate from 0px'
  );

  assert.equal(typeof queuedRaf, 'function');
  queuedRaf();
  assert.equal(glider.classList.contains('is-ready'), true, 'Transition armed on next frame');

  // 3. Click second segment ('总汇总') -> glider slides to x=119px, w=56px with .is-ready intact
  btns[1].dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.deepEqual(picked, ['models']);
  assert.equal(glider.style.getPropertyValue('--glider-x'), '119px');
  assert.equal(glider.style.getPropertyValue('--glider-w'), '56px');
  assert.equal(glider.classList.contains('is-ready'), true);

  // 4. ArrowLeft cycles back to 'steps'
  btns[1].dispatchEvent({ type: 'keydown', key: 'ArrowLeft', preventDefault() {} });
  assert.deepEqual(picked, ['models', 'steps']);
  assert.equal(glider.style.getPropertyValue('--glider-x'), '3px');
  assert.equal(glider.style.getPropertyValue('--glider-w'), '114px');

  // 6. LiveActivityWidget wraps .live-sub-list inside CustomScrollbar (.live-sub-scroll-host) with zero native scrollbars
  const liveWidget = LiveActivityWidget({ defaultExpandRunningSubs: true });
  liveWidget.refs.update({
    items: [
      {
        cascadeId: 'conv-swarm-1',
        title: 'Swarm Run',
        isMainRunning: true,
        subagentCount: 2,
        runningSubagentCount: 1,
        subagents: [
          { cascadeId: 'sub-1', index: 1, role: '@entry-runtime', isRunning: true, stepCount: 17 },
          { cascadeId: 'sub-2', index: 2, role: '@config-state', isRunning: false, stepCount: 7 },
        ],
      },
    ],
  });
  const scrollHost = liveWidget.el.querySelector('.live-sub-scroll-host');
  assert.ok(scrollHost, 'Subagent list is wrapped in CustomScrollbar .live-sub-scroll-host');
  assert.equal(scrollHost.hasAttribute('hidden'), false);
  assert.ok(scrollHost.querySelector('.scrollbar-rail'), 'CustomScrollbar rail is mounted');
  assert.equal(liveWidget.el.querySelector('.live-sub-list').hasAttribute('hidden'), false);
  liveWidget.destroy();

  // 7. ConsumptionView places '今天' ('today') first and defaults active selection to 'today'
  assert.equal(telemetryStore.getState().selectedTimeRange, 'today');
  setI18nLanguage('zh-CN');
  const consView = ConsumptionView({});
  const rangeBtns = consView.el.querySelector('.cons-overview-head').querySelectorAll('.seg-btn');
  assert.equal(rangeBtns[0].getAttribute('data-seg-value'), 'today');
  assert.equal(rangeBtns[0].textContent, '今天');
  assert.equal(rangeBtns[0].classList.contains('is-active'), true, 'Default active range remains today');
  consView.destroy();

  // 8. StepsDetailView inlineScopeSelect ('全部汇总') omits unnecessary leading SVG icon
  const stepsView = StepsDetailView({});
  const scopeTriggerChildren = stepsView.refs.inlineScopeSelect.refs.triggerBtn.children;
  assert.equal(
    scopeTriggerChildren[0].hasAttribute('hidden'),
    true,
    'inlineScopeSelect leading SVG icon is hidden'
  );
  stepsView.destroy();

  // 9. StepTableWidget animates ONLY genuinely newly added steps in Modern UI, never on initial load, filter change, classic UI, or conversation switch
  const stepTable = StepTableWidget({});
  const cols = ['step', 'model', 'tokens_combo'];
  const s1 = { stepIndex: 1, agentCascadeId: 'conv-a', modelShort: '4-carbon', inputTokens: 100 };
  const s2Sub = {
    stepIndex: 1,
    agentCascadeId: 'sub-1',
    isSubagent: true,
    agentId: 'sub-1',
    modelShort: '4-carbon',
    inputTokens: 80,
  };
  const s2Main = { stepIndex: 2, agentCascadeId: 'conv-a', modelShort: '4-carbon', inputTokens: 200 };

  // Initial load (conv-a, filtered to main only, while allConversationSteps has s2Sub too) -> 0 entering rows
  stepTable.refs.renderStepTable([s2Main, s1], 'conv-a', cols, 'zh-CN', {
    allConversationSteps: [s2Main, s2Sub, s1],
    allowNewRowFade: true,
  });
  assert.equal(
    stepTable.refs.stepsTbody.children.some((tr) => tr.classList.contains('is-step-entering')),
    false,
    'Initial render must never animate existing rows'
  );

  // Filter change reveals existing s2Sub -> 0 entering rows ("而且不是查看其他记录")
  stepTable.refs.renderStepTable([s2Main, s2Sub, s1], 'conv-a', cols, 'zh-CN', {
    allConversationSteps: [s2Main, s2Sub, s1],
    allowNewRowFade: false,
  });
  assert.equal(
    stepTable.refs.stepsTbody.children.some((tr) => tr.classList.contains('is-step-entering')),
    false,
    'Revealing existing subagent steps via filter must not animate'
  );

  // Classic UI (allowNewRowFade: false) when step #3 arrives -> 0 entering rows ("只有新ui才有这个动画")
  const s3Classic = { stepIndex: 3, agentCascadeId: 'conv-a', modelShort: '4-carbon', inputTokens: 300 };
  stepTable.refs.renderStepTable([s3Classic, s2Main, s2Sub, s1], 'conv-a', cols, 'zh-CN', {
    allConversationSteps: [s3Classic, s2Main, s2Sub, s1],
    allowNewRowFade: false,
  });
  assert.equal(
    stepTable.refs.stepsTbody.children.some((tr) => tr.classList.contains('is-step-entering')),
    false,
    'Classic UI must not animate newly added step rows'
  );

  // Modern UI live update (allowNewRowFade: true) when step #4 arrives -> ONLY row 0 (#4) gets is-step-entering
  const s4New = { stepIndex: 4, agentCascadeId: 'conv-a', modelShort: '4-carbon', inputTokens: 400 };
  stepTable.refs.renderStepTable([s4New, s3Classic, s2Main, s2Sub, s1], 'conv-a', cols, 'zh-CN', {
    allConversationSteps: [s4New, s3Classic, s2Main, s2Sub, s1],
    allowNewRowFade: true,
  });
  assert.equal(stepTable.refs.stepsTbody.children[0].classList.contains('is-step-entering'), true);
  assert.equal(stepTable.refs.stepsTbody.children[1].classList.contains('is-step-entering'), false);

  // Bubbled animationend from a child <td> must NOT cut off the <tr> highlight fade prematurely
  const enteringRow = stepTable.refs.stepsTbody.children[0];
  enteringRow.onanimationend?.({ target: enteringRow.children[0] });
  assert.equal(
    enteringRow.classList.contains('is-step-entering'),
    true,
    'Child td animationend must not prematurely strip is-step-entering from tr'
  );

  // Clear animationend on row 0 itself, then streaming update to step #4 arrives -> must NOT re-trigger fade-in
  enteringRow.onanimationend?.({ target: enteringRow });
  assert.equal(enteringRow.classList.contains('is-step-entering'), false);
  const s4Updated = { ...s4New, outputTokens: 520 };
  stepTable.refs.renderStepTable([s4Updated, s3Classic, s2Main, s2Sub, s1], 'conv-a', cols, 'zh-CN', {
    allConversationSteps: [s4Updated, s3Classic, s2Main, s2Sub, s1],
    allowNewRowFade: true,
  });
  assert.equal(
    stepTable.refs.stepsTbody.children[0].classList.contains('is-step-entering'),
    false,
    'In-place streaming update of an already seen step must not re-animate'
  );

  // Switching to another conversation ('conv-b') -> 0 entering rows
  const otherConvStep = { stepIndex: 99, agentCascadeId: 'conv-b', modelShort: '4-carbon', inputTokens: 50 };
  stepTable.refs.renderStepTable([otherConvStep], 'conv-b', cols, 'zh-CN', {
    allConversationSteps: [otherConvStep],
    allowNewRowFade: true,
  });
  assert.equal(
    stepTable.refs.stepsTbody.children.some((tr) => tr.classList.contains('is-step-entering')),
    false,
    'Switching conversation must not trigger row fade-in'
  );
  stepTable.destroy();

  // 10. TrendAreaChart tooltip arms 0.15s .is-tracking transition after initial snap and follows pointer steadily without top/bottom jumps
  const trendChart = createTrendAreaChart();
  Object.assign(trendChart.el, {
    clientWidth: 460,
    offsetHeight: 210,
    getBoundingClientRect: () => ({ left: 0, top: 240, width: 460, height: 210, right: 460, bottom: 450 }),
  });
  const tipEl = trendChart.el.querySelector('.trend-tooltip');
  Object.assign(tipEl, { offsetWidth: 216, offsetHeight: 82 });
  const plotStage = trendChart.el.querySelector('.trend-plot-stage');
  const trendPeakPill = trendChart.el.querySelector('.trend-peak-pill');
  const svgEl = trendChart.el.querySelector('.trend-svg');
  svgEl.getBoundingClientRect = () => ({ left: 0, top: 246, width: 460, height: 184, right: 460, bottom: 430 });
  // Zero-data slots must keep peak pill hidden even after hover + mouseleave
  trendChart.update([{ index: 0, label: '00:53', fullLabel: '11月25日 00:53 - 00:54', tokens: 0, calls: 0, costUsd: 0 }]);
  assert.equal(trendPeakPill.hasAttribute('hidden'), true, 'Zero-data chart must hide peak pill');
  plotStage.dispatchEvent({ type: 'mousemove', clientX: 200, clientY: 340 });
  plotStage.dispatchEvent({ type: 'mouseleave' });
  assert.equal(trendPeakPill.hasAttribute('hidden'), true, 'Peak pill stays hidden after mouseleave on zero-data chart');

  trendChart.update([
    { index: 0, label: '00:00', fullLabel: '11月19日 00:00 - 01:00', tokens: 1000, calls: 2, costUsd: 0.1 },
    { index: 1, label: '10:00', fullLabel: '11月19日 10:00 - 11:00', tokens: 25_000_000, calls: 80, costUsd: 6.37 },
  ]);
  assert.equal(trendPeakPill.hasAttribute('hidden'), false, 'Non-zero chart shows peak pill');
  queuedRaf = null;
  plotStage.dispatchEvent({ type: 'mousemove', clientX: 80, clientY: 360 });
  const firstY = tipEl.style.getPropertyValue('--tip-y');
  assert.equal(firstY, '24px');
  assert.equal(tipEl.classList.contains('is-tracking'), false);
  queuedRaf?.();
  assert.equal(tipEl.classList.contains('is-tracking'), true);

  // Sweeping horizontally from valley to peak at steady cursor Y keeps --tip-y rock steady (no top/bottom ping-pong)
  plotStage.dispatchEvent({ type: 'mousemove', clientX: 400, clientY: 360 });
  assert.equal(tipEl.style.getPropertyValue('--tip-y'), firstY);
  assert.equal(tipEl.classList.contains('is-tracking'), true);
  // Moving cursor vertically shifts --tip-y smoothly with cursor
  plotStage.dispatchEvent({ type: 'mousemove', clientX: 400, clientY: 390 });
  assert.equal(tipEl.style.getPropertyValue('--tip-y'), '54px');
  trendChart.destroy();

  // 11. ContextWindowWidget + LiveActivityWidget use pure SVG chevrons and animate expand/collapse under [data-modern-ui="true"]
  document.documentElement.setAttribute('data-modern-ui', 'true');
  const ctxWidget = ContextWindowWidget({});
  document.body.appendChild(ctxWidget.el);
  const subAgents = Array.from({ length: 8 }, (_, idx) => ({
    agentId: `sub-${idx + 1}`,
    cascadeId: `sub-${idx + 1}`,
    index: idx + 1,
    agentKind: 'swarm_worker',
    agentOrdinal: idx + 1,
    isMain: false,
    stepCount: 5,
    context: { usedPct: 15 + idx },
  }));
  ctxWidget.refs.update({
    data: {
      settings: { language: 'zh-CN' },
      activeConversation: {
        cascadeId: 'conv-ctx-anim',
        hasSubagents: true,
        agents: [
          { agentId: 'main', cascadeId: 'conv-ctx-anim', isMain: true, stepCount: 10, context: { usedPct: 40 } },
          ...subAgents,
        ],
        aggregated: { activeAgentId: 'main', activeAgentKind: 'main' },
      },
    },
  });

  const moreBtn = ctxWidget.el.querySelector('.ctx-agent-pill.is-more-toggle');
  assert.ok(moreBtn, 'Overflowing agent pills render .is-more-toggle pill');
  assert.doesNotMatch(moreBtn.textContent, /[▾▴▸]/, 'Zero Unicode arrow characters in toggle text');
  assert.equal(moreBtn.querySelector('.ctx-toggle-chevron')?.hasAttribute('hidden'), false);
  assert.equal(moreBtn.classList.contains('is-expanded'), false);

  const inspectorBar = ctxWidget.el.querySelector('.ctx-inspector-bar');
  const pillGroup = ctxWidget.el.querySelector('.ctx-pill-group');
  Object.assign(inspectorBar, { offsetHeight: 22 });
  Object.assign(pillGroup, { offsetHeight: 74 });

  moreBtn.onclick(); // Expand
  assert.equal(inspectorBar.style.height, '74px');
  const collapseBtn = ctxWidget.el.querySelector('.ctx-agent-pill.is-more-toggle');
  assert.equal(collapseBtn.textContent, '收起');
  assert.equal(collapseBtn.classList.contains('is-expanded'), true);
  inspectorBar.ontransitionend?.({ target: inspectorBar });
  assert.equal(inspectorBar.style.height, '');

  // Collapse back smoothly
  Object.assign(inspectorBar, { offsetHeight: 74 });
  Object.assign(pillGroup.children[0], { offsetHeight: 22, offsetTop: 0 });
  collapseBtn.onclick();
  assert.equal(collapseBtn.classList.contains('is-expanded'), false);
  assert.equal(inspectorBar.style.height, '22px');
  inspectorBar.ontransitionend?.({ target: inspectorBar });
  assert.equal(inspectorBar.style.height, '');
  ctxWidget.destroy();

  // LiveActivityWidget SVG chevron + smooth collapse/expand under [data-modern-ui="true"]
  const animLive = LiveActivityWidget({ defaultExpandRunningSubs: true });
  document.body.appendChild(animLive.el);
  animLive.refs.update({
    items: [
      {
        cascadeId: 'conv-live-anim',
        title: 'Swarm Session',
        isMainRunning: true,
        subagentCount: 2,
        swarmCount: 2,
        runningSubagentCount: 0,
        subagents: [
          { cascadeId: 'sw-1', index: 1, agentKind: 'swarm_worker', role: '@w1', isRunning: false, stepCount: 4 },
          { cascadeId: 'sw-2', index: 2, agentKind: 'swarm_worker', role: '@w2', isRunning: false, stepCount: 6 },
        ],
      },
    ],
  });
  const liveToggleBtn = animLive.el.querySelector('.live-sub-toggle');
  const liveScrollHost = animLive.el.querySelector('.live-sub-scroll-host');
  assert.equal(liveToggleBtn.textContent, '蜂群 (2)');
  assert.ok(liveToggleBtn.querySelector('.live-sub-toggle-chevron'));
  assert.equal(liveToggleBtn.classList.contains('is-expanded'), false);

  Object.assign(liveScrollHost, { offsetHeight: 64, scrollHeight: 64 });
  liveToggleBtn.onclick({ stopPropagation() {} }); // Expand
  assert.equal(liveToggleBtn.classList.contains('is-expanded'), true);
  assert.equal(liveScrollHost.hasAttribute('hidden'), false);
  assert.equal(liveScrollHost.classList.contains('is-sub-animating'), true);
  assert.equal(liveScrollHost.style.height, '64px');
  // Opacity finishes earlier than height -> must NOT cut off height transition early
  liveScrollHost.ontransitionend?.({ target: liveScrollHost, propertyName: 'opacity' });
  assert.equal(liveScrollHost.style.height, '64px');
  assert.equal(liveScrollHost.classList.contains('is-sub-animating'), true);
  liveScrollHost.ontransitionend?.({ target: liveScrollHost, propertyName: 'height' });
  assert.equal(liveScrollHost.style.height, '');
  assert.equal(liveScrollHost.classList.contains('is-sub-animating'), false);

  liveToggleBtn.onclick({ stopPropagation() {} }); // Collapse
  assert.equal(liveToggleBtn.classList.contains('is-expanded'), false);
  assert.equal(liveScrollHost.style.height, '0px');
  assert.equal(liveScrollHost.classList.contains('is-sub-animating'), true);
  liveScrollHost.ontransitionend?.({ target: liveScrollHost, propertyName: 'opacity' });
  assert.equal(liveScrollHost.hasAttribute('hidden'), false);
  liveScrollHost.ontransitionend?.({ target: liveScrollHost, propertyName: 'height' });
  assert.equal(liveScrollHost.hasAttribute('hidden'), true);
  assert.equal(liveScrollHost.classList.contains('is-sub-animating'), false);
  animLive.destroy();
  document.documentElement.removeAttribute('data-modern-ui');
});

test('saveSettingsPatch prevents stale in-flight telemetry polls from snapping settings back and commits UI preferences without blocking on forced telemetry', async (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevTelState = { ...telemetryStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;

  const baseSettings = {
    language: 'zh-CN',
    themeAccent: 'host',
    fontScale: 'md',
    experimentalModernUi: false,
    windowMountMode: 'dual',
    enableWindowOverlay: true,
  };
  const diskSettings = { ...baseSettings };
  telemetryStore.setState(
    { telemetry: { settings: { ...baseSettings }, activeConversation: { stepCount: 1 } } },
    { sync: true }
  );

  let resolveStalePoll = null;
  let resolveSlowPost = null;
  let telemetryGetCalls = 0;
  const postOrder = [];

  globalThis.window = {
    location: { pathname: '/' },
    sidecar: {
      fetch: async (url, opts = {}) => {
        const method = String(opts.method || 'GET').toUpperCase();
        if (method === 'GET' && String(url).startsWith('/api/telemetry')) {
          telemetryGetCalls += 1;
          if (telemetryGetCalls === 1) {
            // Simulate a slow poll that started BEFORE the user changed any setting
            return new Promise((resolve) => {
              resolveStalePoll = () =>
                resolve({
                  ok: true,
                  status: 200,
                  json: async () => ({
                    settings: { ...baseSettings },
                    activeConversation: { stepCount: 2 },
                  }),
                });
            });
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              settings: { ...diskSettings },
              activeConversation: { stepCount: 3 },
            }),
          };
        }
        if (method === 'POST' && url === '/api/settings') {
          const body = JSON.parse(opts.body);
          postOrder.push(body);
          if (postOrder.length === 1) {
            return new Promise((resolve) => {
              resolveSlowPost = () => {
                Object.assign(diskSettings, body);
                resolve({ ok: true, status: 200, json: async () => ({ ...diskSettings }) });
              };
            });
          }
          Object.assign(diskSettings, body);
          return { ok: true, status: 200, json: async () => ({ ...diskSettings }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };

  t.after(() => {
    stopAsyncTelemetryLoop();
    telemetryStore.setState(prevTelState, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  // 1. Start background telemetry poll (capturing stale settings: experimentalModernUi=false, fontScale='md')
  const stalePollPromise = fetchTelemetry({ force: false });
  assert.equal(telemetryGetCalls, 1);

  // 2. While poll is in flight, user toggles experimentalModernUi -> true AND rapidly switches fontScale -> 'lg'
  const save1 = saveSettingsPatch({ experimentalModernUi: true });
  const save2 = saveSettingsPatch({ fontScale: 'lg' });
  assert.equal(telemetryStore.getState().telemetry.settings.experimentalModernUi, true);
  assert.equal(telemetryStore.getState().telemetry.settings.fontScale, 'lg');

  // 3. Stale poll returns BEFORE POST finishes -> live stepCount updates to 2, yet settings NEVER snap back!
  resolveStalePoll();
  await stalePollPromise;
  assert.equal(telemetryStore.getState().telemetry.activeConversation.stepCount, 2);
  assert.equal(
    telemetryStore.getState().telemetry.settings.experimentalModernUi,
    true,
    'Stale in-flight poll must not revert pending experimentalModernUi'
  );
  assert.equal(
    telemetryStore.getState().telemetry.settings.fontScale,
    'lg',
    'Stale in-flight poll must not revert pending fontScale'
  );

  // 4. First POST completes; second serialized POST executes right after -> both settle WITHOUT forcing extra telemetry GET
  resolveSlowPost();
  await Promise.all([save1, save2]);
  assert.deepEqual(postOrder, [{ experimentalModernUi: true }, { fontScale: 'lg' }]);
  assert.equal(
    telemetryGetCalls,
    1,
    'Pure UI setting patches must not block on an unnecessary forced /api/telemetry reload'
  );
  assert.equal(telemetryStore.getState().telemetry.settings.experimentalModernUi, true);
  assert.equal(telemetryStore.getState().telemetry.settings.fontScale, 'lg');

  // 5. Subsequent fresh poll started after commit observes authoritative diskSettings and retires local overlay cleanly
  await fetchTelemetry({ force: false });
  assert.equal(telemetryGetCalls, 2);
  assert.equal(telemetryStore.getState().telemetry.activeConversation.stepCount, 3);
  assert.equal(telemetryStore.getState().telemetry.settings.experimentalModernUi, true);
  assert.equal(telemetryStore.getState().telemetry.settings.fontScale, 'lg');
});

test('StepTableWidget virtualizes large sessions (>80 rows) with exact turn-rail boundaries, stable zebra parity, live fade-in, and zero blank top gap on tab return', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document: mockDoc } = createMockDom();
  globalThis.document = mockDoc;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  };

  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  const stepTable = StepTableWidget({});
  const { stepsTablePane, stepsTableEl, stepsTbody, renderStepTable } = stepTable.refs;
  stepsTablePane.clientHeight = 500;
  stepsTablePane.clientWidth = 520;
  stepsTablePane.scrollTop = 0;

  const cols = ['step', 'model', 'tps', 'ttft', 'tokens_combo', 'cache', 'cost'];
  const makeStep = (idx, extra = {}) => ({
    stepIndex: idx,
    modelShort: idx % 5 === 0 ? '4-neon' : '4-carbon',
    tokPerSec: idx % 17 === 0 ? null : 62.5,
    selectedSpeedReason: idx % 17 === 0 ? 'below_min_output' : null,
    ttftSec: 1.2,
    inputTokens: 1200,
    cacheReadTokens: 80000,
    outputTokens: 600,
    thinkingTokens: 200,
    responseTokens: 400,
    contextTokens: 81800,
    cacheHitPct: 98.5,
    costUsd: 0.021,
    turnIndex: Math.floor((idx - 1) / 4) + 1,
    isTurnStart: (idx - 1) % 4 === 0,
    isLatestTurn: idx > 1718,
    turnPromptClean: `Turn ${Math.floor((idx - 1) / 4) + 1}`,
    ...extra,
  });

  // 1. Small dataset (<=80 rows) stays direct without virtualization or spacers
  const smallSteps = Array.from({ length: 12 }, (_, i) => makeStep(12 - i));
  renderStepTable(smallSteps, 'conv-small', cols, 'zh-CN', {
    showStepTurnRail: true,
    allConversationSteps: smallSteps,
    allowNewRowFade: false,
  });
  assert.equal(stepsTableEl.classList.contains('is-virtualized'), false);
  assert.equal(stepsTbody.children.length, 12);
  assert.equal(
    stepsTbody.children.some((tr) => tr.classList.contains('step-vspacer')),
    false
  );

  // 2. Large 1,722-step session activates transparent virtual windowing
  const isRealRow = (tr) =>
    !tr.classList.contains('step-vspacer') && !tr.classList.contains('step-vsizer');
  const totalSteps = 1722;
  const bigSteps = Array.from({ length: totalSteps }, (_, i) =>
    makeStep(
      totalSteps - i,
      i === 900
        ? { modelShort: '4-hydrogen', modelLabel: 'Gemini 4 Hydrogen', isCompactionStep: true }
        : {}
    )
  );
  const t0 = performance.now();
  renderStepTable(bigSteps, 'conv-big', cols, 'zh-CN', {
    showStepTurnRail: true,
    allConversationSteps: bigSteps,
    allowNewRowFade: false,
  });
  const initialRenderMs = performance.now() - t0;
  assert.equal(stepsTableEl.classList.contains('is-virtualized'), true);
  assert.equal(stepsTableEl.classList.contains('has-turn-rail'), true);

  const initialRealRows = stepsTbody.children.filter(isRealRow);
  const initialSpacers = stepsTbody.children.filter((tr) => tr.classList.contains('step-vspacer'));
  const initialSizers = stepsTbody.children.filter((tr) => tr.classList.contains('step-vsizer'));
  assert.equal(initialSizers.length, 1, 'Virtualized table mounts one zero-height global width sizer row');
  assert.match(
    initialSizers[0].children[1].textContent,
    /4-hydrogen/,
    'Sizer row pre-measures global widest model from off-screen row #900 on frame 1'
  );
  assert.ok(
    initialRealRows.length >= 25 && initialRealRows.length < 75,
    `Expected bounded mounted row window, got ${initialRealRows.length}`
  );
  assert.equal(initialSpacers.length, 1, 'At scrollTop=0 only bottom spacer should be mounted');
  assert.equal(initialRealRows[0].children[0].textContent, '#1722');
  assert.equal(initialRealRows[0].classList.contains('is-stripe-even'), false, 'Logical row 0 is odd');
  assert.equal(initialRealRows[1].classList.contains('is-stripe-even'), true, 'Logical row 1 is even');

  // 2.5 Hysteresis: small wheel scroll inside overscan margin skips DOM updates completely
  const initialSnapshot = [...initialRealRows];
  stepsTablePane.scrollTop = 56;
  stepsTablePane.dispatchEvent({ type: 'scroll' });
  const afterSmallScroll = stepsTbody.children.filter(isRealRow);
  assert.equal(afterSmallScroll.length, initialSnapshot.length);
  assert.equal(
    afterSmallScroll[0],
    initialSnapshot[0],
    'Small scroll within hysteresis margin must keep mounted rows untouched'
  );

  // 3. Scrolling mid-table shifts window, mounts both spacers, keeps logical parity & seamless turn-rail boundary
  const initialRowSet = new Set(initialSnapshot);
  stepsTablePane.scrollTop = 24000;
  stepsTablePane.dispatchEvent({ type: 'scroll' });
  const midRealRows = stepsTbody.children.filter(isRealRow);
  const midSpacers = stepsTbody.children.filter((tr) => tr.classList.contains('step-vspacer'));
  assert.equal(midSpacers.length, 2, 'Mid-scroll must mount both top and bottom spacers');
  assert.ok(midRealRows.length >= 25 && midRealRows.length < 75);
  assert.equal(
    midRealRows.some((tr) => tr.classList.contains('is-step-entering')),
    false,
    'Scrolling into historical rows must never trigger new-row fade-in animation'
  );

  // 3.5 Second distant jump recycles pooled <tr> nodes from the first jump (zero fresh allocations)
  stepsTablePane.scrollTop = 36000;
  stepsTablePane.dispatchEvent({ type: 'scroll' });
  const farRealRows = stepsTbody.children.filter(isRealRow);
  assert.ok(
    farRealRows.some((tr) => initialRowSet.has(tr)),
    'Distant jump must recycle previously unmounted <tr> nodes from rowPool'
  );
  assert.equal(
    stepTable.refs.stepsTheadRow.children.every((th) => !th.style.minWidth),
    true,
    'Scrolling must never ratchet th.style.minWidth and clip trailing columns'
  );
  // Return to mid-table to continue boundary checks
  stepsTablePane.scrollTop = 24000;
  stepsTablePane.dispatchEvent({ type: 'scroll' });
  const midCheckRows = stepsTbody.children.filter(isRealRow);

  // Verify logical zebra parity & turn-rail boundary continuity on first & last mounted mid rows
  for (const tr of midCheckRows) {
    const stepNum = Number(tr.children[0].textContent.replace(/^#/, ''));
    const logicalIdx = totalSteps - stepNum;
    assert.equal(
      tr.classList.contains('is-stripe-even'),
      logicalIdx % 2 === 1,
      `Row #${stepNum} (logicalIdx=${logicalIdx}) must preserve exact logical zebra parity`
    );
  }
  const firstMidRow = midCheckRows[0];
  const firstMidStepNum = Number(firstMidRow.children[0].textContent.replace(/^#/, ''));
  const firstMidIdx = totalSteps - firstMidStepNum;
  const expectedHasUp = bigSteps[firstMidIdx - 1]?.turnIndex === bigSteps[firstMidIdx]?.turnIndex;
  const firstMidRail = firstMidRow.querySelector('.turn-rail');
  assert.ok(firstMidRail, 'Mid-table virtualized row must preserve turn-rail element');
  assert.equal(
    firstMidRail.classList.contains('has-up'),
    expectedHasUp,
    'First mounted row in virtual window must compute has-up from real adjacent step outside window'
  );

  // 4. Simulating tab switch away & back (display:none resets scrollTop to 0 with unchanged bigSteps reference)
  stepsTablePane.scrollTop = 0;
  renderStepTable(bigSteps, 'conv-big', cols, 'zh-CN', {
    showStepTurnRail: true,
    allConversationSteps: bigSteps,
    allowNewRowFade: false,
  });
  const returnedRealRows = stepsTbody.children.filter(isRealRow);
  const returnedSpacers = stepsTbody.children.filter((tr) => tr.classList.contains('step-vspacer'));
  assert.equal(returnedSpacers.length, 1, 'Returning to scrollTop=0 must drop top spacer immediately');
  assert.equal(returnedRealRows[0].children[0].textContent, '#1722');

  // 5. Live new step prepended at top animates ONLY the new row even when virtualized
  const nextBigSteps = [makeStep(1723, { isLatestTurn: true }), ...bigSteps];
  renderStepTable(nextBigSteps, 'conv-big', cols, 'zh-CN', {
    showStepTurnRail: true,
    allConversationSteps: nextBigSteps,
    allowNewRowFade: true,
  });
  const liveRealRows = stepsTbody.children.filter(isRealRow);
  assert.equal(liveRealRows[0].children[0].textContent, '#1723');
  assert.equal(liveRealRows[0].classList.contains('is-step-entering'), true);
  assert.equal(liveRealRows[1].classList.contains('is-step-entering'), false);

  // 6. Narrowing filter below threshold cleanly exits virtualization
  const filteredSteps = nextBigSteps.slice(0, 20);
  renderStepTable(filteredSteps, 'conv-big', cols, 'zh-CN', {
    showStepTurnRail: true,
    allConversationSteps: nextBigSteps,
    allowNewRowFade: false,
  });
  assert.equal(stepsTableEl.classList.contains('is-virtualized'), false);
  assert.equal(stepsTbody.children.length, 20);
  assert.equal(
    stepsTbody.children.some((tr) => !isRealRow(tr)),
    false
  );

  // Verify compiled CSS ships virtualized zebra striping, sizer, spacer, and overflow-anchor rules
  const builtStyles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(builtStyles, /\.data-table\.is-virtualized\s+tbody\s+tr\.is-stripe-even/);
  assert.match(builtStyles, /\.step-vspacer-cell/);
  assert.match(builtStyles, /\.step-vsizer-inner/);
  assert.match(builtStyles, /overflow-anchor:\s*none;/);
  assert.ok(initialRenderMs < 150, `Virtualized 1722-row initial render should stay fast (was ${initialRenderMs.toFixed(1)}ms)`);

  stepTable.destroy();
});

test('CustomSelect collision detection clamps left/right overflow and flips upward near bottom boundary', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle: () => ({ overflow: 'visible', overflowX: 'visible', overflowY: 'visible' }),
    addEventListener() {},
    removeEventListener() {},
  };

  let selectComp = null;
  t.after(() => {
    selectComp?.destroy?.();
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  const shell = document.createElement('div');
  shell.className = 'wm-popover-panel';
  shell.getBoundingClientRect = () => ({ left: 20, top: 40, right: 560, bottom: 620, width: 540, height: 580 });
  document.body.appendChild(shell);

  selectComp = CustomSelect({
    className: 'steps-inline-scope-select',
    modelValue: 'all',
    options: [
      { value: 'all', label: '全部汇总', meta: '1994步' },
      { value: 'main', label: '主代理', meta: '1759步' },
      { value: 'w1', label: '蜂群 #1 · @entry-runtime', meta: '17步' },
    ],
  });
  shell.appendChild(selectComp.el);

  const menuEl = selectComp.refs.menuEl;
  const triggerBtn = selectComp.refs.triggerBtn;

  // 1. Trigger near left edge with a wide 260px menu whose raw layout overflows left (-50 < 26)
  selectComp.el.getBoundingClientRect = () => ({ left: 90, top: 100, right: 190, bottom: 124, width: 100, height: 24 });
  triggerBtn.getBoundingClientRect = () => ({ left: 90, top: 100, right: 190, bottom: 124, width: 100, height: 24 });
  menuEl.offsetWidth = 260;
  menuEl.offsetHeight = 180;
  menuEl.scrollHeight = 180;
  menuEl.getBoundingClientRect = () => ({ left: -50, top: 128, right: 210, bottom: 308, width: 260, height: 180 });

  triggerBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(menuEl.style.left, '0px');
  assert.equal(menuEl.style.right, 'auto');
  assert.equal(menuEl.classList.contains('is-above'), false);

  // 2. Trigger near right edge (460..540) overflows right (460+260 > 554) -> right-aligns cleanly inside shell
  triggerBtn.dispatchEvent({ type: 'click', stopPropagation() {} }); // close
  selectComp.el.getBoundingClientRect = () => ({ left: 460, top: 100, right: 540, bottom: 124, width: 80, height: 24 });
  triggerBtn.getBoundingClientRect = () => ({ left: 460, top: 100, right: 540, bottom: 124, width: 80, height: 24 });
  menuEl.getBoundingClientRect = () => ({ left: 460, top: 128, right: 720, bottom: 308, width: 260, height: 180 });

  triggerBtn.dispatchEvent({ type: 'click', stopPropagation() {} }); // reopen
  assert.equal(menuEl.style.left, '-180px', 'Right-edge menu shifts left to align with trigger right edge (540-260=280, offset=-180)');
  assert.equal(menuEl.style.right, 'auto');

  // 3. Trigger near bottom edge (580..604) flips upward (.is-above)
  triggerBtn.dispatchEvent({ type: 'click', stopPropagation() {} }); // close
  selectComp.el.getBoundingClientRect = () => ({ left: 90, top: 580, right: 190, bottom: 604, width: 100, height: 24 });
  triggerBtn.getBoundingClientRect = () => ({ left: 90, top: 580, right: 190, bottom: 604, width: 100, height: 24 });
  menuEl.getBoundingClientRect = () => ({ left: 90, top: 608, right: 350, bottom: 788, width: 260, height: 180 });

  triggerBtn.dispatchEvent({ type: 'click', stopPropagation() {} }); // reopen
  assert.equal(menuEl.classList.contains('is-above'), true);
  assert.equal(menuEl.style.bottom, 'calc(100% + 4px)');
  assert.equal(menuEl.style.top, 'auto');
});

test('Capsule odometer digit rolling (0.15s) and color transition (0.1s) stay strictly isolated to Modern UI', (t) => {
  const prevDoc = globalThis.document;
  const { document } = createMockDom();
  globalThis.document = document;
  t.after(() => {
    globalThis.document = prevDoc;
  });

  // Tokenizer keys integer digits right-to-left by place value and fraction digits left-to-right
  const toks = tokenizeCapsuleOdometerText('37.2 t/s');
  assert.deepEqual(
    toks.map((x) => `${x.key}=${x.kind === 'digit' ? x.digit : x.text}`),
    ['n:0:i:1=3', 'n:0:i:0=7', 'n:0:dot=.', 'n:0:f:0=2', 's:0= t/s']
  );

  const host = document.createElement('div');
  const slotText = document.createElement('span');
  slotText.className = 'wm-slot-text wm-speed-text';
  host.appendChild(slotText);
  document.body.appendChild(host);

  // 1. Classic UI (no data-modern-ui): strictly plain text, zero odometer reels
  patchCapsuleOdometerText(slotText, '37.2 t/s', { resetKey: 'tps' });
  assert.equal(slotText.textContent, '37.2 t/s');
  assert.equal(slotText.querySelectorAll('.wm-od-digit').length, 0);
  assert.equal(slotText.hasAttribute('data-od-active'), false);

  // 2. Enable Modern UI: builds 3 digit reels in place and preserves reel identity across digit updates
  host.setAttribute('data-modern-ui', 'true');
  patchCapsuleOdometerText(slotText, '37.2 t/s', { resetKey: 'tps' });
  assert.equal(slotText.getAttribute('data-od-active'), '1');
  assert.equal(slotText.getAttribute('data-od-value'), '37.2 t/s');
  assert.equal(slotText.getAttribute('aria-label'), '37.2 t/s');
  const reels1 = slotText.querySelectorAll('.wm-od-digit');
  assert.equal(reels1.length, 3);
  const tensTrack = reels1[0].querySelector('.wm-od-track');
  const onesTrack = reels1[1].querySelector('.wm-od-track');
  const fracTrack = reels1[2].querySelector('.wm-od-track');
  assert.equal(tensTrack.style.getPropertyValue('--od-val'), '3');
  assert.equal(onesTrack.style.getPropertyValue('--od-val'), '7');
  assert.equal(fracTrack.style.getPropertyValue('--od-val'), '2');

  // Update 37.2 -> 38.5: same DOM reel nodes reused, only changed digits update --od-val
  patchCapsuleOdometerText(slotText, '38.5 t/s', { resetKey: 'tps' });
  const reels2 = slotText.querySelectorAll('.wm-od-digit');
  assert.equal(reels2[0], reels1[0]);
  assert.equal(reels2[1], reels1[1]);
  assert.equal(reels2[2], reels1[2]);
  assert.equal(tensTrack.style.getPropertyValue('--od-val'), '3');
  assert.equal(onesTrack.style.getPropertyValue('--od-val'), '8');
  assert.equal(fracTrack.style.getPropertyValue('--od-val'), '5');

  // Digit count change 38.5 -> 9.4 -> 12.6 preserves ones & tenths place reels cleanly
  patchCapsuleOdometerText(slotText, '9.4 t/s', { resetKey: 'tps' });
  const reels3 = slotText.querySelectorAll('.wm-od-digit');
  assert.equal(reels3.length, 2);
  assert.equal(reels3[0], reels1[1], 'Ones-place reel stays mounted across 2-digit -> 1-digit shrink');
  assert.equal(reels3[1], reels1[2], 'Tenths-place reel stays mounted');
  assert.equal(onesTrack.style.getPropertyValue('--od-val'), '9');
  assert.equal(fracTrack.style.getPropertyValue('--od-val'), '4');

  patchCapsuleOdometerText(slotText, '12.6 t/s', { resetKey: 'tps' });
  const reels4 = slotText.querySelectorAll('.wm-od-digit');
  assert.equal(reels4.length, 3);
  assert.equal(reels4[1], reels1[1], 'Ones-place reel stays mounted across 1-digit -> 2-digit grow');
  assert.equal(reels4[2], reels1[2], 'Tenths-place reel stays mounted');
  assert.equal(reels4[0].querySelector('.wm-od-track').style.getPropertyValue('--od-val'), '1');
  assert.equal(onesTrack.style.getPropertyValue('--od-val'), '2');
  assert.equal(fracTrack.style.getPropertyValue('--od-val'), '6');

  // 3. Disable Modern UI: restores clean plain text with zero leftover odometer DOM
  host.removeAttribute('data-modern-ui');
  patchCapsuleOdometerText(slotText, '12.6 t/s', { resetKey: 'tps' });
  assert.equal(slotText.textContent, '12.6 t/s');
  assert.equal(slotText.querySelectorAll('.wm-od-digit').length, 0);
  assert.equal(slotText.hasAttribute('data-od-active'), false);

  // 4. Compiled CSS strictly scopes 150ms roll & 100ms color transition under [data-modern-ui="true"]
  const builtStyles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(builtStyles, /\.steps-inline-scope-select\s+\.select-menu[\s\S]*?left:\s*auto;\s*right:\s*0;/);
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.select-menu,[\s\S]*?animation:\s*anim-modern-tip-fade\s+120ms/
  );
  assert.match(builtStyles, /\[data-modern-ui="true"\]\s+\.select-menu\.is-above/);
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.wm-od-track\s*\{[^}]*transition:\s*transform\s+150ms/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.wm-multi-label\s*\{[^}]*transition:\s*color\s+100ms/
  );
  assert.doesNotMatch(
    builtStyles,
    /(?:^|\n)\.wm-od-track\s*\{/,
    'Odometer roll CSS must ONLY exist under [data-modern-ui="true"]'
  );
  // 5. Breakdown popovers translate on GPU layer only (no top/left layout transition jitter)
  assert.match(
    builtStyles,
    /\.cons-breakdown-popover\s*\{[^}]*left:\s*0;[^}]*top:\s*0;[^}]*transform:\s*translate3d\(var\(--pop-x,\s*8px\),\s*var\(--pop-y,\s*8px\),\s*0\);[^}]*will-change:\s*transform;/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.cons-breakdown-popover\.is-tracking\s*\{\s*transition:\s*transform\s+150ms\s+var\(--ease-modern\);\s*\}/
  );
  assert.match(
    builtStyles,
    /\.trend-tooltip\.is-rich-breakdown\s*\{[^}]*left:\s*0;[^}]*transform:\s*translate3d\(var\(--tip-x,\s*0px\),\s*var\(--tip-y,\s*0px\),\s*0\)/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.trend-tooltip\.is-rich-breakdown\.is-tracking\s*\{\s*transition:\s*transform\s+150ms\s+var\(--ease-modern\);\s*\}/
  );
  assert.match(
    builtStyles,
    /@starting-style\s*\{[\s\S]*?\[data-modern-ui="true"\]\s+\.wm-od-track\s*\{\s*transform:\s*translate3d\(0,\s*0,\s*0\);/
  );
  assert.match(
    builtStyles,
    /\.trend-tooltip\.is-floating-tip\s*\{[^}]*left:\s*0;[^}]*transform:\s*translate3d\(var\(--tip-x,\s*0px\),\s*var\(--tip-y,\s*0px\),\s*0\)/
  );

  // 6. Pending TTFT during a new step must NOT flash --s or destroy odometer reels before TTFT is calculated
  const capHost = document.createElement('div');
  capHost.setAttribute('data-modern-ui', 'true');
  const capSlots = [
    createCapsuleSlotNode(0, 'tps'),
    createCapsuleSlotNode(1, 'ttft'),
    createCapsuleSlotNode(2, 'context'),
    createCapsuleSlotNode(3, 'none'),
    createCapsuleSlotNode(4, 'none'),
  ];
  const capSeps = Array.from({ length: 4 }, () => document.createElement('span'));
  for (const s of capSlots) capHost.appendChild(s.el);
  document.body.appendChild(capHost);

  const slotKeys = ['tps', 'ttft', 'context'];

  // Poll 1: Step #10075 finished with ttft = 13.3s
  syncCapsuleSlotNodes(
    capSlots,
    capSeps,
    slotKeys,
    buildCapsuleSlotContext({
      activeConversation: {
        cascadeId: 'df95cefc-791c-4ece-b433-d6ac4ad10316',
        isRunning: false,
        stepCount: 2131,
        latestTokPerSec: 7.4,
        latestTtftSec: 13.3,
        lastKnownTtftSec: 13.3,
        context: { totalTokens: 130000, compactionLimitTokens: 256000 },
      },
    })
  );
  assert.equal(capSlots[1].textSpan.getAttribute('data-od-value'), '13.3s');
  const ttftReelsStep1 = capSlots[1].textSpan.querySelectorAll('.wm-od-digit');
  assert.equal(ttftReelsStep1.length, 3);
  const savedOnesReel = ttftReelsStep1[1];
  const savedTenthsReel = ttftReelsStep1[2];

  // Poll 2: Step #10077 streaming (10.5 t/s, latestTtftSec = null while TTFT is not calculated yet, even without lastKnownTtftSec)
  syncCapsuleSlotNodes(
    capSlots,
    capSeps,
    slotKeys,
    buildCapsuleSlotContext({
      activeConversation: {
        cascadeId: 'df95cefc-791c-4ece-b433-d6ac4ad10316',
        isRunning: true,
        stepCount: 2132,
        latestTokPerSec: 10.5,
        latestTtftSec: null,
        context: { totalTokens: 131000, compactionLimitTokens: 256000 },
      },
    })
  );
  assert.equal(
    capSlots[1].textSpan.getAttribute('data-od-value'),
    '13.3s',
    'TTFT slot keeps previous valid TTFT while new step TTFT is still pending'
  );
  const ttftReelsPending = capSlots[1].textSpan.querySelectorAll('.wm-od-digit');
  assert.equal(ttftReelsPending.length, 3);
  assert.equal(ttftReelsPending[1], savedOnesReel);
  assert.equal(ttftReelsPending[2], savedTenthsReel);

  // Poll 2b: Cold-mounted slot mid-generation resolves lastKnownTtftSec / recentSteps fallback instead of --s
  const coldSlotCtx = buildCapsuleSlotContext({
    activeConversation: {
      cascadeId: 'df95cefc-791c-4ece-b433-d6ac4ad10316',
      isRunning: true,
      stepCount: 2132,
      latestTokPerSec: 10.5,
      latestTtftSec: null,
      lastKnownTtftSec: 13.3,
      context: { totalTokens: 131000, compactionLimitTokens: 256000 },
    },
  });
  assert.equal(coldSlotCtx.ttft, 13.3);

  // Poll 3: Step #10077 TTFT calculated (8.4s) -> rolls directly 13.3s -> 8.4s on the preserved DOM reels
  syncCapsuleSlotNodes(
    capSlots,
    capSeps,
    slotKeys,
    buildCapsuleSlotContext({
      activeConversation: {
        cascadeId: 'df95cefc-791c-4ece-b433-d6ac4ad10316',
        isRunning: true,
        stepCount: 2132,
        latestTokPerSec: 10.5,
        latestTtftSec: 8.4,
        lastKnownTtftSec: 8.4,
        context: { totalTokens: 131000, compactionLimitTokens: 256000 },
      },
    })
  );
  assert.equal(capSlots[1].textSpan.getAttribute('data-od-value'), '8.4s');
  const ttftReelsResolved = capSlots[1].textSpan.querySelectorAll('.wm-od-digit');
  assert.equal(ttftReelsResolved.length, 2);
  assert.equal(ttftReelsResolved[0], savedOnesReel, 'Ones reel stays mounted for 150ms roll');
  assert.equal(ttftReelsResolved[1], savedTenthsReel, 'Tenths reel stays mounted for 150ms roll');
  assert.equal(savedOnesReel.querySelector('.wm-od-track').style.getPropertyValue('--od-val'), '8');
  assert.equal(savedTenthsReel.querySelector('.wm-od-track').style.getPropertyValue('--od-val'), '4');

  // Poll 4: Switching to a different conversation with no TTFT resets cleanly to --s without leaking
  syncCapsuleSlotNodes(
    capSlots,
    capSeps,
    slotKeys,
    buildCapsuleSlotContext({
      activeConversation: {
        cascadeId: 'dddddddd-7777-8888-9999-eeeeeeeeeeee',
        isRunning: false,
        stepCount: 8,
        latestTokPerSec: 120.5,
        latestTtftSec: null,
        recentSteps: [],
        context: { totalTokens: 64000, compactionLimitTokens: 256000 },
      },
    })
  );
  assert.equal(capSlots[1].textSpan.textContent, '--s');
  assert.equal(capSlots[1].textSpan.hasAttribute('data-od-active'), false);
});

test('uiTheme setting defaults to liquid_glass, switches cleanly to default, and scopes liquid-glass.css strictly', () => {
  const prevDoc = globalThis.document;
  const { document } = createMockDom();
  globalThis.document = document;
  try {
    applyAppearanceToRoot(document.documentElement, {});
    assert.equal(document.documentElement.getAttribute('data-ui-theme'), 'liquid-glass');

    applyAppearanceToRoot(document.documentElement, { uiTheme: 'default' });
    assert.equal(document.documentElement.getAttribute('data-ui-theme'), 'default');

    applyAppearanceToRoot(document.documentElement, { uiTheme: 'liquid_glass', modernUi: false });
    assert.equal(document.documentElement.getAttribute('data-ui-theme'), 'default');

    const builtStyles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    assert.match(builtStyles, /\[data-ui-theme="liquid-glass"\]\s+\.panel/);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('StepTrendChart computes robust 4-metric scales and StepsDetailView switches dots/curve/table cleanly', async (t) => {
  const { computeStepTrendScales } = await import('../src/components/charts/StepTrendChart.js');
  const { setStepsViewMode } = await import('../src/store/uiStore.js');

  const scales = computeStepTrendScales([
    { tps: 132, ttft: 6.2, cache: 97.4, cost: 0.045 },
    { tps: 148, ttft: 7.1, cache: 98.1, cost: 0.052 },
    { tps: 162, ttft: 8.4, cache: 96.5, cost: 0.058 },
    { tps: 155, ttft: 7.9, cache: 98.4, cost: 0.051 },
    { tps: 174, ttft: 9.0, cache: 97.9, cost: 0.062 },
    { tps: 141, ttft: 8.2, cache: 92.4, cost: 0.049 },
    { tps: 168, ttft: 9.1, cache: 98.8, cost: 0.056 },
    { tps: 1860, ttft: 10.4, cache: 99.1, cost: 0.064 },
    { tps: 1938, ttft: 11.1, cache: 99.3, cost: 0.072 },
    { tps: 1283, ttft: 9.9, cache: 99.2, cost: 0.068 },
    { tps: 156, ttft: 7.7, cache: 97.3, cost: 0.046 },
  ]);
  assert.equal(scales.hasOutlier, true);
  assert.ok(scales.tpsCap < 320 && scales.tpsCap > 160, `Expected robust cap in (160, 320), got ${scales.tpsCap}`);
  assert.equal(scales.maxTpsRaw, 1938);
  assert.equal(scales.cacheMin, 85, 'Dynamic cache floor zooms into high-hit range');
  assert.equal(scales.cacheMax, 100);

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevUi = { ...uiStore.getState() };
  const prevTel = { ...telemetryStore.getState() };
  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
  };

  let view = null;
  t.after(() => {
    view?.destroy?.();
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  setStepsViewMode('dots');
  uiStore.setState({ activeView: 'overview', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      telemetry: {
        settings: {},
        activeConversation: {
          cascadeId: 'cid-trend-1',
          stepCount: 3,
          recentSteps: [
            { stepIndex: 652, createdAtMs: 3000, modelShort: '4-neon-high', tokPerSec: 131, ttftSec: 9.1, cacheHitPct: 99.2, costUsd: 0.078, outputTokens: 690 },
            { stepIndex: 650, createdAtMs: 2000, modelShort: '4-neon-high', tokPerSec: 1283, ttftSec: 13.1, cacheHitPct: 99.3, costUsd: 0.076, outputTokens: 64 },
            { stepIndex: 646, createdAtMs: 1000, modelShort: '4-neon-high', tokPerSec: 149, ttftSec: 14.9, cacheHitPct: 99.1, costUsd: 0.099, outputTokens: 1180 },
          ],
          modelBreakdown: [],
        },
      },
    },
    { sync: true }
  );

  view = StepsDetailView({ embedded: true });
  document.body.appendChild(view.el);

  assert.equal(view.refs.stepTrendChart.el.hasAttribute('hidden'), false, 'Chart visible by default in dots mode');
  assert.equal(view.refs.stepsScroll.el.hasAttribute('hidden'), true, 'Table hidden by default in dots mode');
  assert.equal(view.refs.stepTrendChart.refs.getPointCount(), 3);
  assert.equal(view.el.querySelectorAll('.step-quad-cell').length, 4, 'Renders 2x2 four-metric quad cells');
  assert.deepEqual(
    ['tps', 'ttft', 'cache', 'cost'].map((k) => view.refs.stepTrendChart.refs.cellMap[k].labelTextEl.textContent),
    ['速度', '首字', '缓存', '费用'],
    'Quad metric headers resolve localized labels rather than raw i18n keys'
  );
  assert.equal(view.refs.stepTrendChart.refs.cellMap.tps.numEl.textContent, '131');
  assert.equal(view.refs.stepTrendChart.refs.cellMap.cost.numEl.textContent, '$0.078');

  const scrubPill = view.el.querySelector('.steps-header-scrub-pill');
  assert.equal(scrubPill.hasAttribute('hidden'), true);
  view.refs.stepTrendChart.refs.setHoverIndexForTest(1);
  assert.equal(scrubPill.hasAttribute('hidden'), false);
  assert.match(scrubPill.textContent, /#650/);
  assert.equal(view.refs.stepTrendChart.refs.cellMap.tps.numEl.textContent, '1283');
  assert.equal(view.refs.stepTrendChart.refs.cellMap.ttft.numEl.textContent, '13.1');
  assert.equal(view.refs.stepTrendChart.refs.cellMap.cache.numEl.textContent, '99.3');
  assert.equal(view.refs.stepTrendChart.refs.cellMap.cost.numEl.textContent, '$0.076');

  const curveBtn = view.refs.viewModeSwitchEl.querySelectorAll('.steps-view-mode-btn')[1];
  const tableBtn = view.refs.viewModeSwitchEl.querySelectorAll('.steps-view-mode-btn')[2];
  curveBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
  await Promise.resolve();
  assert.equal(uiStore.getState().stepsViewMode, 'curve');
  assert.equal(view.refs.stepTrendChart.el.hasAttribute('hidden'), false);
  assert.equal(view.refs.stepsScroll.el.hasAttribute('hidden'), true);

  tableBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
  await Promise.resolve();
  assert.equal(uiStore.getState().stepsViewMode, 'table');
  assert.equal(view.refs.stepTrendChart.el.hasAttribute('hidden'), true);
  assert.equal(view.refs.stepsScroll.el.hasAttribute('hidden'), false);
  assert.equal(scrubPill.hasAttribute('hidden'), true, 'Header scrub pill hides in table mode');
});
