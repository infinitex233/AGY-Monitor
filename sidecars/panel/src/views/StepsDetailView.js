/**
 * @fileoverview View 3: StepsDetailView (步骤明细与总汇总分析视图).
 * 提供“按步查看”与“总汇总”双子视图切换：
 * - 单步测速表通过 `stepColumnRegistry.js` 动态渲染用户自选的 2..12 个字段列，并支持行级增量对账；
 * - 总汇总视图提供会话线性走势图、多模型同图趋势拟合曲线与极简高密度模型总览卡片。
 */

import { resolveSettingsModernUi } from '../core/appearance.js';
import { defineComponent } from '../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../core/domPatch.js';
import {
  formatTimingDetailSec,
  formatTokensPrecise,
  formatUsd,
  formatPctNumber,
  formatAnomalyKindLabel,
  buildModelAnomalyDiagnostic,
  formatAnomalyTagText,
  mergeModelsByDisplayName,
  normalizeModelDisplayMode,
  normalizeOrchestratorIdDisplayMode,
  resolveModelAnomalySummary,
  resolveModelDisplayInfo,
  speedReasonText,
} from '../core/formatters.js';
import {
  computeStepQuickChipCounts,
  filterStepsBySearchAndChip,
} from '../core/stepInspector.js';
import {
  buildStepsExportBaseName,
  buildStepsMarkdownReport,
  buildStepsXlsx,
  sanitizeExportFilename,
} from '../core/reportExporter.js';
import {
  copyTextWithFeedback,
  exportBinaryFileWithFeedback,
} from '../core/fileExportClient.js';
import { createSvgIcon } from '../icons/SvgIcon.js';
import { ActionMenu } from '../components/ui/ActionMenu.js';
import { getEffectiveLocale, i18nStore, t } from '../i18n/index.js';
import {
  formatAgentLabel,
  getDefaultCtxInspectorAgentId,
  normalizeClientStepColumns,
  normalizeClientStepTokenComboFormat,
  resolveScopedConversation,
  telemetryStore,
} from '../store/telemetryStore.js';
import { getVisibleMonitorView, setStepsViewMode, uiStore } from '../store/uiStore.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { CustomSelect } from '../components/ui/CustomSelect.js';
import { createSearchInput } from '../components/ui/SearchInput.js';
import { StepTrendChart } from '../components/charts/StepTrendChart.js';
import { StepTableWidget } from '../components/widgets/StepTableWidget.js';
import { sortStepsByColumn } from '../registries/stepColumnRegistry.js';

function getStepModelGroupKey(step) {
  if (!step || typeof step !== 'object') return t('fmt.unknownModel');
  const rawLabel = String(step.baseModelLabel || step.modelLabel || step.label || '')
    .replace(/\s*\[自动压缩\]\s*$/u, '')
    .replace(/\s*\((?:Max|XHigh|High|Medium|Low|Thinking|Extra Low|Tiered)\)\s*$/i, '')
    .trim();
  if (rawLabel) return rawLabel;
  const rawShort = String(step.baseModelShort || step.modelShort || step.shortName || '')
    .replace(/·(?:压缩|Compact)\s*$/iu, '')
    .trim();
  return rawShort || t('fmt.unknownModel');
}

export function mergeSelectedAgentUnits(units) {
  const combinedSteps = [];
  const modelMap = new Map();

  for (const ag of units) {
    if (!ag || typeof ag !== 'object') continue;
    if (Array.isArray(ag.recentSteps)) {
      for (const step of ag.recentSteps) combinedSteps.push(step);
    }
    const breakdown = Array.isArray(ag.modelBreakdown) ? ag.modelBreakdown : [];
    for (const m of breakdown) {
      if (!m || typeof m !== 'object') continue;
      const gk = getStepModelGroupKey(m);
      let acc = modelMap.get(gk);
      if (!acc) {
        acc = {
          label: m.label || gk,
          shortName: m.shortName || gk,
          rawModel: m.rawModel || '',
          upstreamName: m.upstreamName || m.upstreamModel || '',
          upstreamSet: new Set(
            Array.isArray(m.upstreamModels) ? m.upstreamModels.filter(Boolean) : []
          ),
          calls: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          responseTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          unpricedCalls: 0,
          anomalySteps: 0,
          anomalyCount: 0,
          anomalyDangerCount: 0,
          anomalyTotalDelaySec: 0,
          anomalyByKind: {},
          _hasAnySpeedSummary: false,
          _speedTokens: 0,
          _speedSeconds: 0,
          _speedSampleCount: 0,
          _speedExcludedCount: 0,
          _speedExcludedReasons: {},
          _ttftWeightedSum: 0,
          _ttftWeight: 0,
          _ttftSampleCount: 0,
        };
        if (acc.upstreamName) acc.upstreamSet.add(acc.upstreamName);
        modelMap.set(gk, acc);
      }
      if (!acc.upstreamName && (m.upstreamName || m.upstreamModel)) {
        acc.upstreamName = m.upstreamName || m.upstreamModel;
      }
      if (m.upstreamName) acc.upstreamSet.add(m.upstreamName);
      if (Array.isArray(m.upstreamModels)) {
        for (const u of m.upstreamModels) {
          if (u) acc.upstreamSet.add(u);
        }
      }
      const calls = Math.max(0, Number(m.calls || 0));
      const inTok = Math.max(0, Number(m.inputTokens || 0));
      const cacheTok = Math.max(0, Number(m.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(m.outputTokens || 0));
      const thinkTok = Math.max(0, Number(m.thinkingTokens || 0));
      const respTok =
        m.responseTokens != null
          ? Math.max(0, Number(m.responseTokens))
          : Math.max(0, outTok - thinkTok);
      const totTok = Math.max(0, Number(m.totalTokens ?? inTok + cacheTok + outTok));
      const costUsd = Number.isFinite(Number(m.costUsd)) ? Math.max(0, Number(m.costUsd)) : 0;
      const unpricedCalls = Math.max(0, Number(m.unpricedCalls || 0));

      acc.calls += calls;
      acc.inputTokens += inTok;
      acc.cacheReadTokens += cacheTok;
      acc.outputTokens += outTok;
      acc.thinkingTokens += thinkTok;
      acc.responseTokens += respTok;
      acc.totalTokens += totTok;
      acc.costUsd += costUsd;
      acc.unpricedCalls += unpricedCalls;
      acc.anomalySteps += Math.max(0, Number(m.anomalySteps || 0));
      acc.anomalyCount += Math.max(0, Number(m.anomalyCount || 0));
      acc.anomalyDangerCount += Math.max(0, Number(m.anomalyDangerCount || 0));
      acc.anomalyTotalDelaySec += Math.max(0, Number(m.anomalyTotalDelaySec || 0));
      if (m.anomalyByKind && typeof m.anomalyByKind === 'object') {
        for (const [kind, cnt] of Object.entries(m.anomalyByKind)) {
          const n = Math.max(0, Number(cnt || 0));
          if (n > 0) acc.anomalyByKind[kind] = (acc.anomalyByKind[kind] || 0) + n;
        }
      }

      const rawSpeedTok = Number(m.speedSummary?.tokens);
      const rawSpeedSec = Number(m.speedSummary?.seconds);
      if (
        Number.isFinite(rawSpeedTok) &&
        Number.isFinite(rawSpeedSec) &&
        rawSpeedSec > 0 &&
        rawSpeedTok >= 0
      ) {
        acc._hasAnySpeedSummary = true;
        acc._speedTokens += rawSpeedTok;
        acc._speedSeconds += rawSpeedSec;
      } else if (Number.isFinite(Number(m.avgTokPerSec)) && Number(m.avgTokPerSec) > 0) {
        const fallbackTok = outTok > 0 ? outTok : Math.max(1, calls || 1);
        acc._speedTokens += fallbackTok;
        acc._speedSeconds += fallbackTok / Number(m.avgTokPerSec);
      }
      if (m.speedSummary) {
        acc._hasAnySpeedSummary = true;
        acc._speedSampleCount += Math.max(0, Number(m.speedSummary.sampleCount || 0));
        acc._speedExcludedCount += Math.max(0, Number(m.speedSummary.excludedCount || 0));
        if (m.speedSummary.excludedReasons && typeof m.speedSummary.excludedReasons === 'object') {
          for (const [rk, rv] of Object.entries(m.speedSummary.excludedReasons)) {
            const cnt = Math.max(0, Number(rv || 0));
            if (cnt > 0) acc._speedExcludedReasons[rk] = (acc._speedExcludedReasons[rk] || 0) + cnt;
          }
        }
      }
      if (
        m.avgTtftSec != null &&
        Number.isFinite(Number(m.avgTtftSec)) &&
        Number(m.avgTtftSec) >= 0
      ) {
        const ttftSamples = Math.max(0, Number(m.ttftSampleCount || 0));
        const w = ttftSamples > 0 ? ttftSamples : Math.max(1, calls || 1);
        acc._ttftWeightedSum += Number(m.avgTtftSec) * w;
        acc._ttftWeight += w;
        acc._ttftSampleCount += ttftSamples;
      }
    }
  }

  combinedSteps.sort(
    (a, b) =>
      (Number(b?.createdAtMs) || 0) - (Number(a?.createdAtMs) || 0) ||
      (Number(b?.agentIndex) || 0) - (Number(a?.agentIndex) || 0) ||
      (Number(b?.stepIndex) || 0) - (Number(a?.stepIndex) || 0)
  );

  const mergedModels = Array.from(modelMap.values())
    .map((acc) => {
      const promptTok = acc.inputTokens + acc.cacheReadTokens;
      const rawAvgTps = acc._speedSeconds > 0 ? acc._speedTokens / acc._speedSeconds : null;
      return {
        label: acc.label,
        shortName: acc.shortName,
        rawModel: acc.rawModel,
        upstreamName: acc.upstreamName,
        upstreamModels: Array.from(acc.upstreamSet),
        calls: acc.calls,
        inputTokens: acc.inputTokens,
        cacheReadTokens: acc.cacheReadTokens,
        outputTokens: acc.outputTokens,
        thinkingTokens: acc.thinkingTokens,
        responseTokens: acc.responseTokens,
        totalTokens: acc.totalTokens,
        costUsd: +acc.costUsd.toFixed(6),
        unpricedCalls: acc.unpricedCalls,
        avgTokPerSec: rawAvgTps !== null ? +rawAvgTps.toFixed(1) : null,
        avgTtftSec:
          acc._ttftWeight > 0 ? +(acc._ttftWeightedSum / acc._ttftWeight).toFixed(1) : null,
        ttftSampleCount: acc._ttftSampleCount,
        ...(acc._hasAnySpeedSummary
          ? {
              speedSummary: {
                tokens: acc._speedTokens,
                seconds: +acc._speedSeconds.toFixed(6),
                sampleCount: acc._speedSampleCount,
                excludedCount: acc._speedExcludedCount,
                excludedReasons: acc._speedExcludedReasons,
                avgTokPerSec: rawAvgTps,
              },
            }
          : {}),
        cacheHitPct: promptTok > 0 ? +((acc.cacheReadTokens / promptTok) * 100).toFixed(1) : 0,
        ...(acc.anomalyCount > 0
          ? {
              anomalySteps: acc.anomalySteps,
              anomalyCount: acc.anomalyCount,
              anomalyDangerCount: acc.anomalyDangerCount,
              anomalyTotalDelaySec: +acc.anomalyTotalDelaySec.toFixed(1),
              anomalyByKind: acc.anomalyByKind,
            }
          : {}),
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);

  return { steps: combinedSteps, models: mergedModels };
}

const LEGACY_FIVE_COL_SIG = 'step,model,tps,ttft,cost';
function resolveStepDisplayColumns(rawCols, isEmbedded) {
  const cols = normalizeClientStepColumns(rawCols);
  if (isEmbedded && cols.join(',') === LEGACY_FIVE_COL_SIG) {
    return ['step', 'model', 'tps', 'ttft', 'cache', 'cost'];
  }
  return cols;
}

export const StepsDetailView = defineComponent({
  name: 'StepsDetailView',
  setup({ props, onCleanup }) {
    const isEmbedded = Boolean(props?.embedded);
    const onLayoutChange = typeof props?.onLayoutChange === 'function' ? props.onLayoutChange : null;
    const isStepsViewActive = (view = getVisibleMonitorView()) =>
      isEmbedded ? view === 'overview' || view === 'steps' : view === 'steps';
    let selectedAgentScopes = [uiStore.getState().selectedAgentScope || 'all'];
    let lastSyncedUiScope = uiStore.getState().selectedAgentScope || 'all';
    let selectedTableModels = ['__all__'];
    let onlyAnomalies = false;
    let anomalyKindFilter = '';
    let stepSearchQuery = '';
    let stepQuickChip = '';
    let currentTableSteps = [];
    let currentAllConvSteps = [];
    let currentDisplaySettings = {};
    let sortKey = '';
    let sortDir = '';
    let cachedSortSrc = null;
    let cachedSortSig = '';
    let cachedSortedOut = [];

    function applyAgentScopesSelection(nextScopes) {
      selectedAgentScopes = nextScopes;
      const mappedSingle =
        nextScopes.length === 1 && nextScopes[0] !== 'all' ? nextScopes[0] : 'all';
      const prevUiScope = uiStore.getState().selectedAgentScope;
      lastSyncedUiScope = mappedSingle;
      if (prevUiScope !== mappedSingle) {
        const curCtxId = uiStore.getState().ctxInspectorAgentId;
        const shouldResetSubCtx =
          mappedSingle === 'all' && curCtxId && curCtxId !== 'main' && curCtxId !== 'auto';
        uiStore.setState({
          selectedAgentScope: mappedSingle,
          ...(shouldResetSubCtx
            ? {
                ctxInspectorAgentId: getDefaultCtxInspectorAgentId(
                  telemetryStore.getState().telemetry?.settings
                ),
              }
            : {}),
        });
      } else if (latestSlice) {
        renderStepsData(latestSlice);
      }
    }

    const inlineScopeSelect = CustomSelect({
      multiple: true,
      allValue: 'all',
      collapseAll: true,
      multiUnit: t('steps.unitAgent'),
      modelValue: selectedAgentScopes,
      placeholder: t('steps.allAgents'),
      className: 'steps-inline-scope-select',
      options: [{ value: 'all', label: t('steps.allAgents') }],
      onUpdateModelValue: (nextScopes) => {
        if (!Array.isArray(nextScopes) || nextScopes.length === 0) return;
        applyAgentScopesSelection(nextScopes);
      },
    });
    inlineScopeSelect.el.setAttribute('hidden', '');

    const stepsModelSelect = CustomSelect({
      multiple: true,
      allValue: '__all__',
      collapseAll: false,
      multiUnit: t('steps.unitModel'),
      modelValue: selectedTableModels,
      placeholder: t('steps.allModels'),
      className: 'steps-inline-model-select',
      options: [{ value: '__all__', label: t('steps.allModels') }],
      onUpdateModelValue: (nextModels) => {
        if (!Array.isArray(nextModels) || nextModels.length === 0) return;
        selectedTableModels = nextModels;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    stepsModelSelect.el.setAttribute('hidden', '');

    const stepsTitleTextEl = h('span', { text: t('steps.detailTitle') });
    const stepsTitleEl = h('span', { className: 'panel-title' }, [
      createSvgIcon('table', { size: 13 }),
      stepsTitleTextEl,
    ]);

    // --- 单步明细表（委托给可复用的 `StepTableWidget` 解耦组件） ---
    let stepsScroll = null;
    const stepTableWidget = StepTableWidget({
      onSelectAgentScopes: applyAgentScopesSelection,
      onVirtualHeightChange: () => stepsScroll?.refresh(),
      onSortChange: (nextKey, nextDir) => {
        sortKey = nextKey || '';
        sortDir = nextDir || '';
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    const {
      stepsTablePane,
      stepsTableEl,
      stepsTheadRow,
      stepsTbody,
      turnTipEl,
      anomalyTipEl,
      hideTurnTip,
      showAnomalyTip,
      hideAnomalyTip,
      syncTableHeaderColumns,
      renderStepTable,
      refreshViewport: refreshStepTableViewport,
    } = stepTableWidget.refs;
    stepsScroll = CustomScrollbar({
      contentEl: stepsTablePane,
      className: 'table-scroll-host',
    });

    const anomalyFilterLabelEl = h('span', { className: 'steps-anomaly-filter-label text-mono' });
    const anomalyFilterClearBtn = h('button', {
      type: 'button',
      className: 'btn-ghost-sm steps-anomaly-filter-clear',
      text: t('steps.anomalyFilterAll'),
      onclick: () => {
        onlyAnomalies = false;
        anomalyKindFilter = '';
        if (stepQuickChip === 'anomaly') stepQuickChip = '';
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    const anomalyFilterBarEl = h(
      'div',
      { className: 'steps-anomaly-filterbar', hidden: true },
      [anomalyFilterLabelEl, anomalyFilterClearBtn]
    );

    // --- 步骤搜索栏及快捷诊断芯片 ---
    const stepSearchBox = createSearchInput({
      wrapClassName: 'steps-search-wrap',
      iconClassName: 'steps-search-icon',
      inputClassName: 'steps-search-input',
      clearClassName: 'steps-search-clear',
      placeholder: t('steps.searchPlaceholder'),
      ariaLabel: t('steps.searchPlaceholder'),
      clearAriaLabel: t('steps.searchClearAria'),
      closeIconSize: 11,
      onInput: (val) => {
        stepSearchQuery = String(val ?? '');
        if (latestSlice) renderStepsData(latestSlice);
      },
      onClear: () => {
        stepSearchQuery = '';
        if (latestSlice) renderStepsData(latestSlice);
        stepSearchInput.focus?.();
      },
      onKeydown: (e) => {
        if (e?.key === 'Escape') {
          e.stopPropagation?.();
          if (stepSearchQuery) {
            stepSearchQuery = '';
            stepSearchBox.setValue('');
            if (latestSlice) renderStepsData(latestSlice);
          } else {
            stepSearchInput.blur?.();
          }
        }
      },
    });
    const stepSearchWrapEl = stepSearchBox.el;
    const stepSearchInput = stepSearchBox.inputEl;
    const stepSearchClearBtn = stepSearchBox.clearBtnEl;

    const QUICK_CHIP_DEFS = [
      { key: 'anomaly', i18nKey: 'steps.chipAnomaly', tone: 'is-warn' },
      { key: 'compaction', i18nKey: 'steps.chipCompaction', tone: 'is-info' },
      { key: 'low_cache', i18nKey: 'steps.chipLowCache', tipKey: 'steps.chipLowCacheTip', tone: 'is-warn' },
      { key: 'slow_ttft', i18nKey: 'steps.chipSlowTtft', tipKey: 'steps.chipSlowTtftTip', tone: 'is-danger' },
    ];
    const quickChipBtns = QUICK_CHIP_DEFS.map((def) => {
      const btn = h('button', {
        type: 'button',
        className: `steps-chip-btn ${def.tone}`,
        'data-chip': def.key,
        hidden: true,
        onclick: () => {
          if (def.key === 'anomaly') {
            const nextOn = !(onlyAnomalies || stepQuickChip === 'anomaly');
            onlyAnomalies = nextOn;
            anomalyKindFilter = '';
            stepQuickChip = nextOn ? 'anomaly' : '';
          } else {
            const nextKey = stepQuickChip === def.key ? '' : def.key;
            stepQuickChip = nextKey;
            if (nextKey) {
              onlyAnomalies = false;
              anomalyKindFilter = '';
            }
          }
          if (latestSlice) renderStepsData(latestSlice);
        },
      });
      return { def, btn };
    });
    const stepQuickChipsEl = h(
      'div',
      { className: 'steps-quick-chips', hidden: true },
      quickChipBtns.map((c) => c.btn)
    );
    const stepsExportMenu = ActionMenu({
      ariaLabel: t('steps.exportMenuAria'),
      className: 'steps-export-menu',
      items: [
        {
          key: 'xlsx',
          icon: 'download',
          label: t('steps.exportXlsx'),
          title: t('steps.exportXlsxTip'),
          onSelect: () => {
            if (currentTableSteps.length === 0) return;
            const bytes = buildStepsXlsx(currentTableSteps, {
              title: latestSlice?.activeConversation?.title || '',
              cascadeId: latestSlice?.cascadeId || latestSlice?.activeConversation?.cascadeId || '',
              displaySettings: currentDisplaySettings,
            });
            const baseName = buildStepsExportBaseName(
              latestSlice?.activeConversation?.title || '',
              latestSlice?.cascadeId || latestSlice?.activeConversation?.cascadeId || ''
            );
            void exportBinaryFileWithFeedback(
              sanitizeExportFilename(baseName, 'xlsx'),
              bytes
            );
          },
        },
        {
          key: 'md',
          icon: 'copy',
          label: t('steps.exportMd'),
          title: t('steps.exportMdTip'),
          onSelect: () => {
            if (currentTableSteps.length === 0) return;
            const md = buildStepsMarkdownReport(currentTableSteps, {
              title: latestSlice?.activeConversation?.title || '',
              cascadeId: latestSlice?.cascadeId || latestSlice?.activeConversation?.cascadeId || '',
              displaySettings: currentDisplaySettings,
            });
            void copyTextWithFeedback(md, t('steps.exportMdDone'));
          },
        },
      ],
    });
    stepsExportMenu.refs.setHidden(true);
    const stepsFilterToolbarEl = h(
      'div',
      { className: 'steps-filter-toolbar', hidden: true },
      [stepSearchWrapEl, stepQuickChipsEl]
    );

    const headerFiltersEl = h('div', { className: 'steps-header-filters', hidden: true }, [
      inlineScopeSelect.el,
      stepsModelSelect.el,
    ]);

    // --- 三态视图切换（点阵 / 曲线 / 列表）与步骤趋势图 ---
    const VIEW_MODE_DEFS = [
      { value: 'dots', icon: 'dot-matrix', i18nKey: 'steps.modeDots' },
      { value: 'curve', icon: 'trend-curve', i18nKey: 'steps.modeCurve' },
      { value: 'table', icon: 'list', i18nKey: 'steps.modeTable' },
    ];
    let currentViewMode = uiStore.getState().stepsViewMode || 'dots';
    const viewModeThumbEl = h('span', { className: 'steps-view-mode-thumb', 'aria-hidden': 'true' });
    const viewModeBtns = VIEW_MODE_DEFS.map((def) => {
      const labelEl = h('span', { text: t(def.i18nKey) });
      const btn = h(
        'button',
        {
          type: 'button',
          className: 'steps-view-mode-btn',
          'data-mode': def.value,
          role: 'tab',
          'aria-selected': def.value === currentViewMode ? 'true' : 'false',
          onclick: () => setStepsViewMode(def.value),
        },
        [createSvgIcon(def.icon, { size: 11 }), labelEl]
      );
      return { def, btn, labelEl };
    });
    const viewModeSwitchEl = h(
      'div',
      {
        className: 'steps-view-mode-switch',
        role: 'tablist',
        'aria-label': t('steps.modeSwitchAria'),
      },
      [viewModeThumbEl, ...viewModeBtns.map((item) => item.btn)]
    );

    const headerScrubStepEl = h('strong', { className: 'steps-scrub-step text-mono' });
    const headerScrubMetaEl = h('span', { className: 'steps-scrub-meta' });
    const headerScrubPillEl = h(
      'span',
      { className: 'steps-header-scrub-pill', hidden: true },
      [headerScrubStepEl, headerScrubMetaEl]
    );
    const stepsTitleGroupEl = h('div', { className: 'steps-title-group' }, [
      stepsTitleEl,
      headerScrubPillEl,
    ]);

    const stepTrendChart = StepTrendChart({
      onHoverChange: (info) => {
        if (!info || currentViewMode === 'table') {
          patchAttr(headerScrubPillEl, 'hidden', true);
          return;
        }
        patchText(headerScrubStepEl, `#${info.stepIndex}`);
        const metaParts = [info.modelText, info.outputTokensText].filter(Boolean);
        patchText(headerScrubMetaEl, metaParts.length > 0 ? ` · ${metaParts.join(' · ')}` : '');
        patchAttr(headerScrubPillEl, 'hidden', false);
      },
    });

    function applyStepsViewMode(nextMode, { skipChartUpdate = false } = {}) {
      const resolved =
        nextMode === 'curve' || nextMode === 'table' || nextMode === 'dots' ? nextMode : 'dots';
      currentViewMode = resolved;
      const activeIdx = Math.max(
        0,
        VIEW_MODE_DEFS.findIndex((d) => d.value === resolved)
      );
      viewModeThumbEl.style.transform = `translateX(${activeIdx * 100}%)`;
      for (const item of viewModeBtns) {
        const isActive = item.def.value === resolved;
        patchClasses(item.btn, { 'is-active': isActive });
        patchAttr(item.btn, 'aria-selected', isActive ? 'true' : 'false');
      }
      const isTable = resolved === 'table';
      patchAttr(stepTrendChart.el, 'hidden', isTable);
      patchAttr(stepsScroll.el, 'hidden', !isTable);
      if (isTable) {
        stepTrendChart.refs.hideTooltip();
        stepsScroll.refresh();
        refreshStepTableViewport?.();
      } else {
        hideTurnTip();
        hideAnomalyTip();
        if (!skipChartUpdate) {
          stepTrendChart.refs.update({
            steps: currentTableSteps,
            mode: resolved,
            displaySettings: currentDisplaySettings,
            immediate: true,
          });
        }
      }
      onLayoutChange?.();
    }

    applyStepsViewMode(currentViewMode, { skipChartUpdate: true });

    const panelEl = h(
      'section',
      {
        className: isEmbedded ? 'panel steps-embedded-panel' : 'panel',
        ...(isEmbedded
          ? {}
          : { style: 'flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative;' }),
      },
      [
        h('div', { className: 'panel-header steps-panel-header' }, [
          h('div', { className: 'steps-header-controls' }, [
            stepsTitleGroupEl,
            h('div', { className: 'steps-header-right' }, [
              headerFiltersEl,
              viewModeSwitchEl,
              stepsExportMenu.el,
            ]),
          ]),
        ]),
        stepsFilterToolbarEl,
        anomalyFilterBarEl,
        stepTrendChart.el,
        stepsScroll.el,
        turnTipEl,
        anomalyTipEl,
      ]
    );
    stepTableWidget.refs.setBoundsElGetter(() => panelEl);

    const rootEl = isEmbedded ? panelEl : h('div', { className: 'view-pane' }, [panelEl]);

    let latestSlice = null;
    let isDirty = false;
    let lastSyncedCascadeId = null;

    function normalizeMultiModelSelection(rawSelection, availableModelKeys) {
      if (availableModelKeys.size <= 1) return ['__all__'];
      const arr = Array.isArray(rawSelection) ? rawSelection : [];
      if (arr.length === 0 || arr.includes('__all__')) return ['__all__'];
      const valid = Array.from(new Set(arr.filter((k) => availableModelKeys.has(k))));
      if (valid.length === 0) return ['__all__'];
      return valid;
    }

    function refreshStaticLocaleLabels() {
      patchText(anomalyFilterClearBtn, t('steps.anomalyFilterAll'));
      patchAttr(stepSearchInput, 'placeholder', t('steps.searchPlaceholder'));
      patchAttr(stepSearchInput, 'aria-label', t('steps.searchPlaceholder'));
      patchAttr(stepSearchClearBtn, 'aria-label', t('steps.searchClearAria'));
      stepsExportMenu.refs.setAriaLabel(t('steps.exportMenuAria'));
      stepsExportMenu.refs.updateItemLabels({
        xlsx: { label: t('steps.exportXlsx'), title: t('steps.exportXlsxTip') },
        md: { label: t('steps.exportMd'), title: t('steps.exportMdTip') },
      });
      const colKeys = resolveStepDisplayColumns(latestSlice?.stepTableColumns, isEmbedded);
      syncTableHeaderColumns(colKeys);
      patchText(stepsTitleTextEl, t('steps.detailTitle'));
      patchAttr(viewModeSwitchEl, 'aria-label', t('steps.modeSwitchAria'));
      for (const item of viewModeBtns) {
        patchText(item.labelEl, t(item.def.i18nKey));
      }
      stepTrendChart.refs.refreshLabels();
    }

    function renderStepsData(slice, { allowNewRowFade = false } = {}) {
      if (!slice) return;
      const uiSt = uiStore.getState();
      const locale = getEffectiveLocale();

      const currentCid = String(slice.cascadeId || slice.activeConversation?.cascadeId || '');
      if (currentCid !== lastSyncedCascadeId) {
        if (lastSyncedCascadeId !== null) {
          selectedAgentScopes = [uiSt.selectedAgentScope || 'all'];
          lastSyncedUiScope = uiSt.selectedAgentScope || 'all';
          selectedTableModels = ['__all__'];
          onlyAnomalies = false;
          anomalyKindFilter = '';
          stepSearchQuery = '';
          stepSearchInput.value = '';
          patchAttr(stepSearchClearBtn, 'hidden', true);
          stepQuickChip = '';
          sortKey = '';
          sortDir = '';
        }
        lastSyncedCascadeId = currentCid;
      }

      const baseScope = resolveScopedConversation(
        { activeConversation: slice.activeConversation },
        'all',
        uiSt.ctxInspectorAgentId,
        true
      );
      const { hasSubagents, agents, subagents, mainAgent, aggregated } = baseScope;

      let effectiveScopes = ['main'];
      let isMergedMultiAgents = false;
      let steps = [];
      let models = [];

      patchAttr(inlineScopeSelect.el, 'hidden', !hasSubagents);
      if (hasSubagents) {
        const validAgentIds = ['main', ...subagents.map((s) => s.agentId)];
        const validSet = new Set(validAgentIds);
        if (selectedAgentScopes.length === 0 || selectedAgentScopes.includes('all')) {
          effectiveScopes = ['all'];
        } else {
          const filtered = selectedAgentScopes.filter((id) => validSet.has(id));
          effectiveScopes =
            filtered.length === 0 || filtered.length >= validAgentIds.length
              ? ['all']
              : filtered;
        }
        selectedAgentScopes = effectiveScopes;

        const scopeOpts = [
          {
            value: 'all',
            label: t('steps.allAgents'),
            meta: t('header.convMetaSteps', { count: aggregated?.stepCount ?? 0 }),
          },
          {
            value: 'main',
            label: t('fmt.mainAgent'),
            meta: t('header.convMetaSteps', { count: mainAgent?.stepCount ?? 0 }),
          },
          ...subagents.map((s) => ({
            value: s.agentId,
            label: formatAgentLabel(s),
            meta: t('header.convMetaSteps', { count: s.stepCount || 0 }),
          })),
        ];
        inlineScopeSelect.setProps({
          modelValue: effectiveScopes,
          options: scopeOpts,
          placeholder: t('steps.allAgents'),
          multiUnit: t('steps.unitAgent'),
        });

        if (effectiveScopes[0] === 'all') {
          steps = aggregated?.recentSteps || [];
          models = aggregated?.modelBreakdown || [];
          isMergedMultiAgents = true;
        } else if (effectiveScopes.length === 1) {
          const targetId = effectiveScopes[0];
          const unit =
            targetId === 'main'
              ? mainAgent
              : agents.find((a) => a.agentId === targetId) || mainAgent;
          steps = unit?.recentSteps || [];
          models = unit?.modelBreakdown || [];
          isMergedMultiAgents = false;
        } else {
          const scopeSet = new Set(effectiveScopes);
          const selectedUnits = agents.filter((a) =>
            scopeSet.has(a.isMain ? 'main' : a.agentId)
          );
          const merged = mergeSelectedAgentUnits(selectedUnits);
          steps = merged.steps;
          models = merged.models;
          isMergedMultiAgents = true;
        }
      } else {
        inlineScopeSelect.close();
        steps = slice.recentSteps || [];
        models = slice.sessionModelBreakdown || [];
      }

      const displaySettings = {
        modelDisplayMode: normalizeModelDisplayMode(
          slice.modelDisplayMode,
          slice.showUpstreamModel
        ),
        showUpstreamModel: Boolean(slice.showUpstreamModel),
        orchestratorIdMode: slice.orchestratorIdMode,
      };

      const showAgentPrefix = isMergedMultiAgents;

      const availableModelKeys = new Set();
      const perModelOptions = [];
      let breakdownCalls = 0;
      for (const m of models) {
        if (!m || typeof m !== 'object') continue;
        breakdownCalls += Math.max(0, Number(m.calls || 0));
        const gk = getStepModelGroupKey(m);
        if (availableModelKeys.has(gk)) continue;
        availableModelKeys.add(gk);
        const disp = resolveModelDisplayInfo(m, displaySettings, {
          preferLabelInShort: false,
          fallback: gk,
        });
        perModelOptions.push({
          value: gk,
          label: disp.baseText || disp.text || gk,
          meta: t('header.convMetaSteps', { count: Number(m.calls || 0) }),
        });
      }

      const needStepModelFallback =
        steps.length > 0 && (models.length === 0 || breakdownCalls < steps.length);
      if (needStepModelFallback) {
        const stepModelOptionMap = new Map();
        for (const st of steps) {
          const gk = getStepModelGroupKey(st);
          if (!stepModelOptionMap.has(gk)) {
            const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: gk });
            stepModelOptionMap.set(gk, {
              label: disp.baseText || disp.text || gk,
              calls: 0,
            });
          }
          stepModelOptionMap.get(gk).calls += 1;
        }
        for (const [gk, info] of stepModelOptionMap.entries()) {
          if (!availableModelKeys.has(gk)) {
            availableModelKeys.add(gk);
            perModelOptions.push({
              value: gk,
              label: info.label,
              meta: t('header.convMetaSteps', { count: info.calls }),
            });
          }
        }
      }

      const hasMultipleModels = availableModelKeys.size > 1;
      const modelSelectOptions = [
        {
          value: '__all__',
          label: t('steps.allModels'),
          meta: t('header.convMetaSteps', { count: steps.length }),
        },
        ...perModelOptions,
      ];

      // 1. 动态列头同步与表格行级增量对账
      selectedTableModels = normalizeMultiModelSelection(
        selectedTableModels,
        availableModelKeys
      );
      const showStepsModelFilter = hasMultipleModels;
      patchAttr(stepsModelSelect.el, 'hidden', !showStepsModelFilter);
      patchAttr(headerFiltersEl, 'hidden', !hasSubagents && !showStepsModelFilter);
      if (hasMultipleModels) {
        stepsModelSelect.setProps({
          modelValue: selectedTableModels,
          options: modelSelectOptions,
          placeholder: t('steps.allModels'),
          multiUnit: t('steps.unitModel'),
        });
        if (!showStepsModelFilter) stepsModelSelect.close();
      } else {
        stepsModelSelect.close();
      }

      const tableModelFilterSet = selectedTableModels.includes('__all__')
        ? null
        : new Set(selectedTableModels);
      const modelFilteredSteps = tableModelFilterSet
        ? steps.filter((st) => tableModelFilterSet.has(getStepModelGroupKey(st)))
        : steps;

      const filterToolbarEnabled = slice.showStepFilterToolbar === true;
      if (!filterToolbarEnabled) {
        if (stepSearchQuery) {
          stepSearchQuery = '';
          stepSearchInput.value = '';
          patchAttr(stepSearchClearBtn, 'hidden', true);
        }
        if (stepQuickChip && stepQuickChip !== 'anomaly') {
          stepQuickChip = '';
        }
      }
      const chipCounts = computeStepQuickChipCounts(modelFilteredSteps);
      const effectiveQuickChip = onlyAnomalies
        ? 'anomaly'
        : filterToolbarEnabled
          ? stepQuickChip
          : '';
      const showFilterToolbar = filterToolbarEnabled && steps.length > 0;
      patchAttr(stepsFilterToolbarEl, 'hidden', !showFilterToolbar);
      stepsExportMenu.refs.setHidden(steps.length === 0);
      if (showFilterToolbar) {
        let visibleChipsCount = 0;
        for (const { def, btn } of quickChipBtns) {
          const cnt = chipCounts[def.key] || 0;
          const isActive = effectiveQuickChip === def.key;
          const showChip = cnt > 0 || isActive;
          patchAttr(btn, 'hidden', !showChip);
          if (showChip) {
            visibleChipsCount += 1;
            patchText(btn, t(def.i18nKey, { count: cnt }));
            if (def.tipKey) patchAttr(btn, 'title', t(def.tipKey));
            patchClasses(btn, { 'is-active': isActive });
            patchAttr(btn, 'aria-pressed', isActive ? 'true' : 'false');
          }
        }
        patchAttr(stepQuickChipsEl, 'hidden', visibleChipsCount === 0);
      }

      const filteredTableSteps = filterStepsBySearchAndChip(modelFilteredSteps, {
        query: filterToolbarEnabled ? stepSearchQuery : '',
        quickChip: effectiveQuickChip,
        anomalyKindFilter: onlyAnomalies ? anomalyKindFilter : '',
        displaySettings,
      });

      const normTokenFmt = normalizeClientStepTokenComboFormat(slice.stepTokenComboFormat);
      const sortSig = `${sortKey}:${sortDir}:${normTokenFmt}:${displaySettings.modelDisplayMode}:${displaySettings.showUpstreamModel ? 1 : 0}:${displaySettings.orchestratorIdMode}`;
      let tableSteps = filteredTableSteps;
      if (sortKey && sortDir) {
        if (cachedSortSrc === filteredTableSteps && cachedSortSig === sortSig) {
          tableSteps = cachedSortedOut;
        } else {
          tableSteps = sortStepsByColumn(filteredTableSteps, sortKey, sortDir, {
            stepTokenComboFormat: normTokenFmt,
            displaySettings,
          });
          cachedSortSrc = filteredTableSteps;
          cachedSortSig = sortSig;
          cachedSortedOut = tableSteps;
        }
      } else {
        cachedSortSrc = null;
        cachedSortSig = '';
        cachedSortedOut = [];
      }

      const showAnomalyFilterBar = onlyAnomalies;
      patchAttr(anomalyFilterBarEl, 'hidden', !showAnomalyFilterBar);
      if (showAnomalyFilterBar) {
        const baseLabel = t('steps.anomalyFilterLabel', { count: tableSteps.length });
        const kindSuffix = anomalyKindFilter
          ? ` · ${formatAnomalyKindLabel(anomalyKindFilter)}`
          : '';
        patchText(anomalyFilterLabelEl, `${baseLabel}${kindSuffix}`);
      }

      const allConversationSteps = hasSubagents
        ? aggregated?.recentSteps || []
        : slice.recentSteps || [];
      currentTableSteps = tableSteps;
      currentAllConvSteps = allConversationSteps;
      currentDisplaySettings = displaySettings;
      const shouldAnimateNewRows = Boolean(allowNewRowFade && slice.experimentalModernUi);
      const colKeys = resolveStepDisplayColumns(slice.stepTableColumns, isEmbedded);
      renderStepTable(tableSteps, slice.cascadeId, colKeys, locale, {
        effectiveScopes,
        hasSubagents,
        isMergedMultiAgents,
        showStepTurnRail: slice.showStepTurnRail === true,
        showStepAgentBadge: slice.showStepAgentBadge !== false,
        showStepSpeedColor: slice.showStepSpeedColor === true,
        stepTokenComboFormat: slice.stepTokenComboFormat,
        displaySettings,
        allConversationSteps,
        allowNewRowFade: shouldAnimateNewRows,
        sortKey,
        sortDir,
      });
      if (currentViewMode !== 'table') {
        stepTrendChart.refs.update({
          steps: tableSteps,
          mode: currentViewMode,
          displaySettings,
          immediate: !allowNewRowFade,
        });
      }
      stepsScroll.refresh();
      onLayoutChange?.();
    }

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({
        activeConversation: st.telemetry?.activeConversation,
        cascadeId: st.telemetry?.activeConversation?.cascadeId,
        recentSteps: st.telemetry?.activeConversation?.recentSteps,
        sessionModelBreakdown: st.telemetry?.activeConversation?.modelBreakdown,
        modelDisplayMode: normalizeModelDisplayMode(
          st.telemetry?.settings?.modelDisplayMode,
          st.telemetry?.settings?.showUpstreamModel
        ),
        showUpstreamModel: Boolean(st.telemetry?.settings?.showUpstreamModel),
        orchestratorIdMode: normalizeOrchestratorIdDisplayMode(
          st.telemetry?.settings?.orchestratorIdMode
        ),
        showStepTurnRail: st.telemetry?.settings?.showStepTurnRail === true,
        showStepAgentBadge: st.telemetry?.settings?.showStepAgentBadge !== false,
        showStepSpeedColor: st.telemetry?.settings?.showStepSpeedColor === true,
        showStepFilterToolbar: st.telemetry?.settings?.showStepFilterToolbar === true,
        stepTokenComboFormat: normalizeClientStepTokenComboFormat(
          st.telemetry?.settings?.stepTokenComboFormat
        ),
        stepTableColumns: st.telemetry?.settings?.stepTableColumns,
        experimentalModernUi: resolveSettingsModernUi(st.telemetry?.settings),
      }),
      (slice) => {
        latestSlice = slice;
        if (!isStepsViewActive()) {
          isDirty = true;
          return;
        }
        isDirty = false;
        renderStepsData(slice, {
          allowNewRowFade: true,
        });
      }
    );

    let prevScope = uiStore.getState().selectedAgentScope;
    let prevActiveView = getVisibleMonitorView();
    let prevViewMode = currentViewMode;

    const unsubView = uiStore.subscribe(
      (st) => ({
        activeView: getVisibleMonitorView(st),
        selectedAgentScope: st.selectedAgentScope,
        stepsViewMode: st.stepsViewMode || 'dots',
      }),
      (uiSlice) => {
        const scopeChanged = uiSlice.selectedAgentScope !== prevScope;
        if (uiSlice.selectedAgentScope !== lastSyncedUiScope) {
          lastSyncedUiScope = uiSlice.selectedAgentScope;
          selectedAgentScopes = [uiSlice.selectedAgentScope || 'all'];
        }
        const modeChanged = uiSlice.stepsViewMode !== prevViewMode;
        if (modeChanged) {
          prevViewMode = uiSlice.stepsViewMode;
          applyStepsViewMode(uiSlice.stepsViewMode);
        }
        const viewEntered = isStepsViewActive(uiSlice.activeView) && !isStepsViewActive(prevActiveView);
        prevScope = uiSlice.selectedAgentScope;
        prevActiveView = uiSlice.activeView;
        if (!isStepsViewActive(uiSlice.activeView)) {
          hideTurnTip();
          hideAnomalyTip();
          stepTrendChart.refs.hideTooltip();
          if (scopeChanged) isDirty = true;
          return;
        }
        if ((isDirty || scopeChanged || viewEntered) && latestSlice) {
          isDirty = false;
          renderStepsData(latestSlice);
        } else if (viewEntered && currentViewMode !== 'table') {
          stepTrendChart.refs.draw();
        }
      }
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        refreshStaticLocaleLabels();
        if (isStepsViewActive() && latestSlice) {
          renderStepsData(latestSlice);
        } else {
          isDirty = true;
        }
      }
    );

    onCleanup(() => {
      stepsExportMenu.destroy();
      stepTrendChart.destroy();
      unsubTelemetry();
      unsubView();
      unsubI18n();
      stepTableWidget.destroy();
      inlineScopeSelect.destroy();
      stepsModelSelect.destroy();
      stepsScroll.destroy();
    });

    return {
      el: rootEl,
      refs: {
        stepsTableEl,
        stepsTheadRow,
        stepsTbody,
        turnTipEl,
        anomalyTipEl,
        anomalyFilterBarEl,
        stepsFilterToolbarEl,
        stepSearchInput,
        stepQuickChipsEl,
        stepsExportMenu,
        viewModeSwitchEl,
        stepTrendChart,
        inlineScopeSelect,
        stepsModelSelect,
        stepsScroll,
        refreshStepTableViewport,
      },
    };
  },
});
