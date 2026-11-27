/**
 * @fileoverview View 2: ConsumptionView (全景消耗统计视图).
 * 采用 5 段式分析布局展示指定时间窗口内的全量 Token 与费用消耗：
 * 1. 用量概览：支持预设时间段与自定义区间筛选，通过 3+3 组合矩阵展示总 Token/调用次数、
 *    USD/CNY 预估费用、缓存命中率与命中量、新输入/缓存读取（含节省费用）/输出细分占比，以及底部 4 段比例条 (`FourSegmentBar`)。
 * 2. 历史趋势：基于 `TrendAreaChart` 渲染纯 SVG 三次贝塞尔平滑曲线面积图、峰值气泡、对齐多刻度时间轴与悬停详情浮层。
 * 3. 热门模型：按 Token 总量降序展示各模型的消耗占比徽章、4 段构成条及输入/缓存/输出/思考/调用明细。
 * 4. 数据来源：按调用来源聚合展示 Token 构成、占比与费用明细。
 * 5. 按月细分：12 个月垂直 4 段堆叠柱状图，直观对比全年各月费用、Token 总量与缓存/思考结构。
 */

import { mergeSpeedRateBins } from '../../shared/telemetry-display-rules.mjs';
import { defineComponent } from '../core/component.js';
import {
  h,
  patchAttr,
  patchKeyedList,
  patchText,
} from '../core/domPatch.js';
import {
  buildDeterministicModelColorMap,
  formatDateSpanBadge,
  formatPctNumber,
  formatTokensPrecise,
  formatUsd,
  mergeModelsByDisplayName,
  normalizeModelDisplayMode,
  normalizeOrchestratorIdDisplayMode,
} from '../core/formatters.js';
import {
  buildConsumptionExportBaseName,
  buildConsumptionMarkdownReport,
  buildConsumptionXlsx,
  sanitizeExportFilename,
} from '../core/reportExporter.js';
import {
  copyTextWithFeedback,
  exportBinaryFileWithFeedback,
} from '../core/fileExportClient.js';
import { i18nStore, t } from '../i18n/index.js';
import { createSvgIcon } from '../icons/SvgIcon.js';
import { ActionMenu } from '../components/ui/ActionMenu.js';
import {
  prefetchConsumptionPresets,
  selectConsumptionTimeRange,
  telemetryStore,
} from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import {
  createTrendAreaChart,
  HEATMAP_DAYS_THRESHOLD,
} from '../components/charts/TrendAreaChart.js';
import { CustomDateTimePicker } from '../components/ui/CustomDateTimePicker.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { createFourSegmentBar } from '../components/ui/FourSegmentBar.js';
import { SegmentedControl } from '../components/ui/SegmentedControl.js';
import {
  partitionModelSegments,
} from '../components/widgets/ConsumptionBreakdownRows.js';

/** 消耗统计顶栏支持的时间范围预设项 */
function getConsumptionTimeRangeOptions() {
  return [
    { value: 'today', label: t('cons.rangeToday') },
    { value: '24h', label: t('cons.range24h') },
    { value: '7d', label: t('cons.range7d') },
    { value: '14d', label: t('cons.range14d') },
    { value: '30d', label: t('cons.range30d') },
    { value: 'all', label: t('cons.rangeAll') },
    { value: 'custom', label: t('cons.rangeCustom') },
  ];
}

/** 热力图顶栏支持的四档聚合视图选项 */
function getHeatmapModeOptions() {
  return [
    { value: 'day', label: t('cons.hmModeDay') },
    { value: 'week', label: t('cons.hmModeWeek') },
    { value: 'month', label: t('cons.hmModeMonth') },
    { value: 'all', label: t('cons.hmModeAll') },
  ];
}

function floorToStartOfMinuteMs(ms) {
  const n = Number(ms);
  if (!(n > 0)) return 0;
  const d = new Date(n);
  d.setSeconds(0, 0);
  return d.getTime();
}

function ceilToEndOfMinuteMs(ms) {
  const n = Number(ms);
  if (!(n > 0)) return 0;
  const d = new Date(n);
  d.setSeconds(59, 999);
  return d.getTime();
}

export const ConsumptionView = defineComponent({
  name: 'ConsumptionView',
  setup({ onCleanup }) {
    // --- 时间筛选栏：快速时间段分段控制器与自定义起止时间选择条 ---
    let draftStartMs = telemetryStore.getState().customStartMs;
    let draftEndMs = telemetryStore.getState().customEndMs;
    let hasUncommittedCustomDraft = false;
    let hasCommittedCustomRange = false;

    const timeFilterSwitch = SegmentedControl({
      ariaLabel: t('cons.rangeAria'),
      modelValue: telemetryStore.getState().selectedTimeRange,
      options: getConsumptionTimeRangeOptions(),
      onUpdateModelValue: (nextRange) => {
        if (nextRange === 'custom') {
          const st = telemetryStore.getState();
          if (!hasCommittedCustomRange && st.selectedTimeRange !== 'custom') {
            const nowMs = Date.now();
            draftStartMs = floorToStartOfMinuteMs(nowMs - 24 * 3600 * 1000);
            draftEndMs = ceilToEndOfMinuteMs(nowMs);
            hasUncommittedCustomDraft = false;
            startPicker.setValue(draftStartMs);
            endPicker.setValue(draftEndMs);
            selectConsumptionTimeRange('custom', {
              customStartMs: draftStartMs,
              customEndMs: draftEndMs,
            });
            return;
          }
          draftStartMs = st.customStartMs;
          draftEndMs = st.customEndMs;
          hasUncommittedCustomDraft = false;
          startPicker.setValue(draftStartMs);
          endPicker.setValue(draftEndMs);
        } else {
          hasUncommittedCustomDraft = false;
        }
        selectConsumptionTimeRange(nextRange);
      },
    });

    const startPicker = CustomDateTimePicker({
      modelValue: draftStartMs,
      onUpdateModelValue: (ms) => {
        draftStartMs = ms;
        hasUncommittedCustomDraft = true;
        startPicker.setValue(ms);
      },
    });

    const endPicker = CustomDateTimePicker({
      modelValue: draftEndMs,
      onUpdateModelValue: (ms) => {
        draftEndMs = ms;
        hasUncommittedCustomDraft = true;
        endPicker.setValue(ms);
      },
    });

    const applyCustomBtnLabel = h('span', { text: t('cons.applyFilter') });
    const applyCustomBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-primary',
        style: 'height: 26px; padding: 0 10px;',
        onClick: () => {
          const sMs = Number(draftStartMs || 0);
          const eMs = Number(draftEndMs || 0);
          const rawMinMs = sMs > 0 && eMs > 0 ? Math.min(sMs, eMs) : sMs;
          const rawMaxMs = sMs > 0 && eMs > 0 ? Math.max(sMs, eMs) : eMs;
          const minMs = floorToStartOfMinuteMs(rawMinMs);
          const maxMs = ceilToEndOfMinuteMs(rawMaxMs);
          draftStartMs = minMs;
          draftEndMs = maxMs;
          hasUncommittedCustomDraft = false;
          hasCommittedCustomRange = true;
          startPicker.setValue(minMs);
          endPicker.setValue(maxMs);
          selectConsumptionTimeRange('custom', {
            customStartMs: minMs,
            customEndMs: maxMs,
          });
        },
      },
      [createSvgIcon('check', { size: 12 }), applyCustomBtnLabel]
    );

    const rangeToSpan = h('span', { className: 'text-muted', text: t('cons.rangeTo') });
    const customRangeBar = h(
      'div',
      {
        className: 'cons-custom-range-bar',
        hidden: true,
      },
      [
        startPicker.el,
        rangeToSpan,
        endPicker.el,
        applyCustomBtn,
      ]
    );

    // --- Section 1: 用量概览矩阵 (4 列核心指标 + Token 构成小字 + 底部 4 段比例条) ---
    const dateSpanBadge = h('span', { className: 'cons-badge text-mono', text: '-- ~ --' });
    const heroTotalTokens = h('strong', { className: 'cons-hero-num text-mono', text: '0' });
    const heroSplitInputLabel = h('span', { text: t('cons.footInput') });
    const heroSplitInputVal = h('span', { text: '0' });
    const heroSplitCacheLabel = h('span', { text: t('cons.footCache') });
    const heroSplitCacheVal = h('span', { text: '0' });
    const heroSplitOutputLabel = h('span', { text: t('cons.footOutput') });
    const heroSplitOutputVal = h('span', { text: '0' });
    const heroTokenSplitSub = h('span', { className: 'cons-hero-sub text-mono' }, [
      h('span', { className: 'cons-hero-sub-item' }, [
        h('span', { className: 'dot-swatch seg-input', 'aria-hidden': 'true' }),
        h('span', {}, [heroSplitInputLabel, heroSplitInputVal]),
      ]),
      h('span', { className: 'cons-hero-sub-item' }, [
        h('span', { className: 'dot-swatch seg-cached', 'aria-hidden': 'true' }),
        h('span', {}, [heroSplitCacheLabel, heroSplitCacheVal]),
      ]),
      h('span', { className: 'cons-hero-sub-item' }, [
        h('span', { className: 'dot-swatch seg-output', 'aria-hidden': 'true' }),
        h('span', {}, [heroSplitOutputLabel, heroSplitOutputVal]),
      ]),
    ]);
    const heroCostUsd = h('strong', { className: 'cons-hero-cost text-mono', text: '$0.00' });
    const cacheHitPctEl = h('strong', { className: 'cons-hero-cache text-mono', text: '0%' });
    const heroAvgSpeedEl = h('strong', { className: 'cons-hero-speed text-mono', text: '--' });

    const overviewSegBar = createFourSegmentBar();
    const consExportMenu = ActionMenu({
      ariaLabel: t('cons.exportMenuAria'),
      className: 'cons-export-menu',
      items: [
        {
          key: 'xlsx',
          icon: 'download',
          label: t('cons.exportXlsx'),
          title: t('cons.exportXlsxTip'),
          onSelect: () => {
            const cons = latestSlice?.consumption;
            if (!cons) return;
            const displaySettings = {
              modelDisplayMode: latestSlice?.modelDisplayMode,
              showUpstreamModel: latestSlice?.showUpstreamModel,
              orchestratorIdMode: latestSlice?.orchestratorIdMode,
            };
            const bytes = buildConsumptionXlsx(cons, latestSlice?.modelBreakdown || [], {
              displaySettings,
            });
            const baseName = buildConsumptionExportBaseName(
              cons,
              latestSlice?.range || 'all'
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
          label: t('cons.exportMd'),
          title: t('cons.exportMdTip'),
          onSelect: () => {
            const cons = latestSlice?.consumption;
            if (!cons) return;
            const displaySettings = {
              modelDisplayMode: latestSlice?.modelDisplayMode,
              showUpstreamModel: latestSlice?.showUpstreamModel,
              orchestratorIdMode: latestSlice?.orchestratorIdMode,
            };
            const md = buildConsumptionMarkdownReport(cons, latestSlice?.modelBreakdown || [], {
              displaySettings,
            });
            void copyTextWithFeedback(md, t('cons.exportMdDone'));
          },
        },
      ],
    });
    consExportMenu.refs.setHidden(true);
    const totalTokensLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.totalTokens') });
    const estCostLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.estCost') });
    const cacheHitRateLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.cacheHitRate') });
    const avgSpeedLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.avgOutputSpeed') });

    const unifiedMatrixEl = h('div', { className: 'cons-box cons-unified-matrix' }, [
      h('div', { className: 'cons-split-4' }, [
        h('div', { className: 'cons-col' }, [
          totalTokensLabel,
          h('div', { className: 'cons-baseline' }, [heroTotalTokens]),
        ]),
        h('div', { className: 'cons-col is-bordered-col' }, [
          estCostLabel,
          h('div', { className: 'cons-baseline' }, [heroCostUsd]),
        ]),
        h('div', { className: 'cons-col is-bordered-col' }, [
          cacheHitRateLabel,
          h('div', { className: 'cons-baseline' }, [cacheHitPctEl]),
        ]),
        h('div', { className: 'cons-col is-bordered-col' }, [
          avgSpeedLabel,
          h('div', { className: 'cons-baseline' }, [heroAvgSpeedEl]),
        ]),
      ]),
    ]);

    const overviewPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header cons-overview-head' }, [
        h('span', { className: 'panel-title cons-overview-title' }, [
          dateSpanBadge,
        ]),
        h('div', { className: 'cons-overview-controls' }, [
          timeFilterSwitch.el,
          consExportMenu.el,
        ]),
      ]),
      customRangeBar,
      unifiedMatrixEl,
      overviewSegBar.el,
      heroTokenSplitSub,
    ]);

    function drillDownToTimeRange(startMs, endMs) {
      const minMs = floorToStartOfMinuteMs(startMs);
      const maxMs = ceilToEndOfMinuteMs(endMs);
      if (!(minMs > 0) || !(maxMs > minMs)) return;
      draftStartMs = minMs;
      draftEndMs = maxMs;
      hasUncommittedCustomDraft = false;
      hasCommittedCustomRange = true;
      startPicker.setValue(minMs);
      endPicker.setValue(maxMs);
      selectConsumptionTimeRange('custom', {
        customStartMs: minMs,
        customEndMs: maxMs,
      });
    }

    // --- Section 2: 历史趋势 (交互式 SVG 平滑曲线图 / 7×W 四态热力格子图 + 悬停明细浮层 + 点击时段下钻) ---
    let heatmapViewMode = 'day';
    const trendTitleSpan = h('span', { text: t('cons.trendTitle') });
    const heatmapModeSwitch = SegmentedControl({
      ariaLabel: t('cons.hmModeAria'),
      modelValue: heatmapViewMode,
      options: getHeatmapModeOptions(),
      onUpdateModelValue: (nextMode) => {
        if (!['day', 'week', 'month', 'all'].includes(nextMode)) return;
        heatmapViewMode = nextMode;
        heatmapModeSwitch.setValue(nextMode);
        trendChart.setHeatmapMode(nextMode);
      },
    });
    heatmapModeSwitch.el.classList.add('cons-hm-mode-switch');
    patchAttr(heatmapModeSwitch.el, 'hidden', true);

    const trendChart = createTrendAreaChart({
      onSelectSlot: (slot) => {
        if (slot && Number(slot.startMs) > 0 && Number(slot.endMs) > Number(slot.startMs)) {
          drillDownToTimeRange(slot.startMs, slot.endMs);
        }
      },
    });

    const trendPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header cons-trend-head' }, [
        h('span', { className: 'panel-title' }, [
          trendTitleSpan,
        ]),
        h('div', { className: 'cons-trend-head-right' }, [
          heatmapModeSwitch.el,
        ]),
      ]),
      trendChart.el,
    ]);

    // --- Section 3: Magpie 风格模型用量表格（按 Token 降序，单行清晰展示全部关键指标） ---
    function formatModelSpeedCell(tps) {
      const n = Number(tps);
      if (!Number.isFinite(n) || n <= 0) return '--';
      return n >= 100 ? `${Math.round(n)} tok/s` : `${n.toFixed(1)} tok/s`;
    }

    function resolveAggregateAvgSpeed(acct, models) {
      const direct = Number(acct?.avgTokPerSec);
      if (Number.isFinite(direct) && direct > 0) return direct;
      const list = models || [];
      const allSpeedHaveBins = list.every(
        (m) => !(Number(m?.avgTokPerSec) > 0) || Boolean(m?.speedSummary?.rateBins)
      );
      const mergedRates = allSpeedHaveBins
        ? mergeSpeedRateBins(list.map((m) => m?.speedSummary))
        : null;
      if (mergedRates) return mergedRates.avgTokPerSec ?? 0;
      let sumTok = 0;
      let sumSec = 0;
      for (const m of models || []) {
        const ss = m?.speedSummary;
        const dur = Number(ss?.durationSec);
        const tok = Number(ss?.outputTokens || ss?.tokens);
        if (Number.isFinite(dur) && dur > 0 && Number.isFinite(tok) && tok > 0) {
          sumTok += tok;
          sumSec += dur;
        }
      }
      if (sumSec > 0 && sumTok > 0) return sumTok / sumSec;
      let weightedSum = 0;
      let weightCalls = 0;
      for (const m of models || []) {
        const tps = Number(m?.avgTokPerSec);
        const calls = Number(m?.calls || 0);
        if (Number.isFinite(tps) && tps > 0 && calls > 0) {
          weightedSum += tps * calls;
          weightCalls += calls;
        }
      }
      return weightCalls > 0 ? weightedSum / weightCalls : 0;
    }

    const modelsTitleSpan = h('span', { className: 'panel-title', text: t('cons.modelsTableTitle') });
    const thColModel = h('th', { className: 'col-model', text: t('cons.colModel') });
    const thColShare = h('th', { className: 'is-num', text: t('cons.colShare') });
    const thColTokens = h('th', { className: 'is-num', text: t('cons.colTokens') });
    const thColCost = h('th', { className: 'is-num', text: t('cons.colCost') });
    const thColCache = h('th', { className: 'is-num', text: t('cons.colCache') });
    const thColSpeed = h('th', { className: 'is-num', text: t('cons.colSpeed') });
    const thColTtft = h('th', { className: 'is-num', text: t('cons.colTtft') });
    const thColCalls = h('th', { className: 'is-num', text: t('cons.colCalls') });
    const modelsTbodyEl = h('tbody');
    const modelsTableWrapEl = h('div', { className: 'cons-models-table-wrap' }, [
      h('table', { className: 'cons-models-table' }, [
        h('thead', {}, [
          h('tr', {}, [
            thColModel,
            thColShare,
            thColTokens,
            thColCost,
            thColCache,
            thColSpeed,
            thColTtft,
            thColCalls,
          ]),
        ]),
        modelsTbodyEl,
      ]),
    ]);
    const modelsEmptyEl = h('div', {
      className: 'cons-models-empty text-muted',
      hidden: true,
      text: t('cons.modelsTableEmpty'),
    });
    const modelsPanel = h('section', { className: 'panel cons-models-panel' }, [
      h('div', { className: 'panel-header' }, [modelsTitleSpan]),
      modelsTableWrapEl,
      modelsEmptyEl,
    ]);

    function createModelTableRow() {
      const nameEl = h('td', { className: 'col-model' });
      const shareEl = h('td', { className: 'is-num text-mono' });
      const tokEl = h('td', { className: 'is-num text-mono' });
      const costEl = h('td', { className: 'is-num text-mono' });
      const cacheEl = h('td', { className: 'is-num text-mono' });
      const speedEl = h('td', { className: 'is-num text-mono' });
      const ttftEl = h('td', { className: 'is-num text-mono' });
      const callsEl = h('td', { className: 'is-num text-mono' });
      const el = h('tr', { className: 'cons-model-tr' }, [
        nameEl,
        shareEl,
        tokEl,
        costEl,
        cacheEl,
        speedEl,
        ttftEl,
        callsEl,
      ]);
      return {
        el,
        refs: { nameEl, shareEl, tokEl, costEl, cacheEl, speedEl, ttftEl, callsEl },
      };
    }

    const scrollInner = h(
      'div',
      {
        style: 'display: flex; flex-direction: column; gap: var(--space-3); padding-bottom: var(--space-3);',
      },
      [
        overviewPanel,
        trendPanel,
        modelsPanel,
      ]
    );

    const viewScrollbar = CustomScrollbar({
      contentEl: scrollInner,
      className: 'view-pane',
    });

    const rootEl = h('div', { className: 'cons-view-stage' }, [
      viewScrollbar.el,
    ]);

    let latestSlice = null;
    let isDirty = false;
    let prefetchedOnCurrentVisit = false;

    let lastRenderedTuple = null;

    function isSameRenderTuple(prev, next) {
      if (!prev || prev.length !== next.length) return false;
      for (let i = 0; i < prev.length; i++) {
        if (!Object.is(prev[i], next[i])) return false;
      }
      return true;
    }

    /**
     * 将遥测状态切片同步渲染至消费统计视图的 4 个子面板。
     */
    function renderConsumptionData(slice) {
      if (!slice) return;
      const cons = slice.consumption || {};
      const rangeInfo = cons.selectedRange || {};

      // 始终在 0ms 同步顶部时间段滑块及自定义日期条显隐，给予即刻交互反馈
      timeFilterSwitch.setValue(slice.range);
      patchAttr(customRangeBar, 'hidden', slice.range !== 'custom');
      if (!hasUncommittedCustomDraft) {
        draftStartMs = slice.customStartMs;
        draftEndMs = slice.customEndMs;
        startPicker.setValue(draftStartMs);
        endPicker.setValue(draftEndMs);
      }

      // 极少数缓存未命中时（如自定义新区间或进页瞬间抢点），跳过用旧趋势/模型跑无效半更新重绘，待几毫秒后单帧原子绘制
      if (rangeInfo.key && slice.range && rangeInfo.key !== slice.range) {
        return;
      }

      const preset =
        slice.range !== 'custom' && cons.presets?.[slice.range]
          ? cons.presets[slice.range]
          : null;
      const acct = cons.account || preset?.account || {};
      const dateSpan = formatDateSpanBadge(rangeInfo.startMs, rangeInfo.endMs);
      const locale = i18nStore.getState().locale;
      const renderTuple = [
        locale,
        slice.range,
        slice.customStartMs,
        slice.customEndMs,
        slice.modelDisplayMode,
        slice.showUpstreamModel,
        slice.orchestratorIdMode,
        dateSpan,
        preset?.label || rangeInfo.label,
        acct,
        cons.trendSeries,
        slice.modelBreakdown,
      ];
      if (isSameRenderTuple(lastRenderedTuple, renderTuple)) return;
      drawConsumptionData(slice, {
        cons,
        acct,
        rangeInfo,
        dateSpan,
      });
      lastRenderedTuple = renderTuple;
    }

    function drawConsumptionData(slice, { cons, acct, rangeInfo, dateSpan }) {
      const localeSig = i18nStore.getState().locale;
      const displaySettings = {
        modelDisplayMode: normalizeModelDisplayMode(
          slice.modelDisplayMode,
          slice.showUpstreamModel
        ),
        showUpstreamModel: Boolean(slice.showUpstreamModel),
        orchestratorIdMode: slice.orchestratorIdMode,
      };
      const mergeAndSortBucketModels = (rawList) =>
        mergeModelsByDisplayName(rawList || [], displaySettings, {
          preferLabelInShort: true,
        })
          .filter((m) => Number(m.totalTokens || 0) > 0 || Number(m.calls || 0) > 0)
          .sort(
            (a, b) =>
              (b.totalTokens || 0) - (a.totalTokens || 0) || (b.calls || 0) - (a.calls || 0)
          );

      const models = mergeModelsByDisplayName(slice.modelBreakdown || [], displaySettings, {
        preferLabelInShort: true,
      }).sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0) || (b.calls || 0) - (a.calls || 0));

      // 1. 同步用量概览矩阵（4 列核心指标 + Token 构成小字 + 底部 4 段比例条）
      patchText(dateSpanBadge, dateSpan);
      patchAttr(dateSpanBadge, 'title', null);
      const totalTokens = Number(acct.totalTokens || 0);
      const inputTokens = Number(acct.inputTokens || 0);
      const cacheTokens = Number(acct.cacheReadTokens || 0);
      const outputTokens = Number(acct.outputTokens || 0);
      const responseTokens = Number(acct.responseTokens || 0);
      const thinkingTokens = Number(acct.thinkingTokens || 0);
      const costUsd = Number(acct.costUsd || 0);
      const avgSpeed = resolveAggregateAvgSpeed(acct, models);

      patchText(heroTotalTokens, formatTokensPrecise(totalTokens));
      patchText(heroSplitInputVal, formatTokensPrecise(inputTokens));
      patchText(heroSplitCacheVal, formatTokensPrecise(cacheTokens));
      patchText(heroSplitOutputVal, formatTokensPrecise(outputTokens));
      patchText(heroCostUsd, formatUsd(costUsd));
      patchText(cacheHitPctEl, formatPctNumber(acct.cacheHitPct ?? 0, { withSymbol: true }));
      patchText(heroAvgSpeedEl, formatModelSpeedCell(avgSpeed));
      consExportMenu.refs.setHidden(!(totalTokens > 0 || Number(acct.calls || 0) > 0));

      overviewSegBar.update({
        inputTokens,
        cacheReadTokens: cacheTokens,
        responseTokens,
        thinkingTokens,
      });

      const modelsTotalTok = models.reduce((s, m) => s + Number(m.totalTokens || 0), 0);

      const rawTrendSeries = cons.trendSeries || [];
      const allTrendMergedModels = [];
      const trendMergedByIdx = rawTrendSeries.map((slot) => {
        if (!Array.isArray(slot?.models) || slot.models.length === 0) return null;
        const merged = mergeAndSortBucketModels(slot.models);
        for (const m of merged) {
          allTrendMergedModels.push(m);
        }
        return merged;
      });

      const modelColorMap = buildDeterministicModelColorMap([
        ...models,
        ...allTrendMergedModels,
      ]);

      // 2. 同步历史趋势交互式 SVG 面积图 / 近一年热力图
      const firstTrendSlot = rawTrendSeries[0] || null;
      const isMinuteTrend = firstTrendSlot?.granularity === 'minute';
      const isHourlyTrend =
        !isMinuteTrend &&
        (firstTrendSlot?.granularity === 'hour' ||
          (firstTrendSlot?.label || '').includes(':'));
      const isHeatmapTrend =
        !isMinuteTrend && !isHourlyTrend && rawTrendSeries.length > HEATMAP_DAYS_THRESHOLD;
      patchAttr(heatmapModeSwitch.el, 'hidden', !isHeatmapTrend);
      if (isHeatmapTrend) {
        heatmapModeSwitch.setValue(heatmapViewMode);
      }
      const buildTrendModelSegments = (mergedSlotModels) =>
        partitionModelSegments(mergedSlotModels, modelColorMap, {
          maxMain: 5,
          minSharePct: 1.5,
        });
      const enrichedTrendSeries = rawTrendSeries.map((slot, idx) => {
        const mergedSlotModels = trendMergedByIdx[idx];
        if (!mergedSlotModels || mergedSlotModels.length === 0) return slot;
        return {
          ...slot,
          mergedModels: mergedSlotModels,
          modelSegments: buildTrendModelSegments(mergedSlotModels),
        };
      });
      trendChart.update(enrichedTrendSeries, {
        heatmapMode: heatmapViewMode,
        buildModelSegments: buildTrendModelSegments,
      });

      // 3. 同步 Magpie 风格模型用量表格（按 Token 降序，单行展示全部关键指标）
      patchAttr(modelsTableWrapEl, 'hidden', models.length === 0);
      patchAttr(modelsEmptyEl, 'hidden', models.length > 0);
      patchText(modelsEmptyEl, t('cons.modelsTableEmpty'));

      patchKeyedList(modelsTbodyEl, models, {
        keyFn: (m) => m.displayText || m.label || m.shortName,
        sigFn: (m) =>
          `${localeSig}:${m.displayText}:${m.displayTitle}:${m.totalTokens}:${m.costUsd}:${m.unpricedCalls}:${m.calls}:${m.avgTokPerSec ?? ''}:${m.avgTtftSec ?? ''}:${m.cacheHitPct ?? ''}:${modelsTotalTok}`,
        createRow: createModelTableRow,
        updateRow: (refs, m) => {
          const nameText = m.displayText || m.label || m.shortName || '--';
          patchText(refs.nameEl, nameText);
          patchAttr(refs.nameEl, 'title', m.displayTitle || null);
          const tokVal = Number(m.totalTokens || 0);
          const sharePct = modelsTotalTok > 0 ? (tokVal / modelsTotalTok) * 100 : 0;
          patchText(refs.shareEl, formatPctNumber(sharePct, { withSymbol: true }));
          patchText(refs.tokEl, formatTokensPrecise(tokVal));
          const calls = Number(m.calls || 0);
          const cVal = Number(m.costUsd || 0);
          const isUnpriced = calls > 0 && Number(m.unpricedCalls || 0) >= calls && !(cVal > 0);
          patchText(
            refs.costEl,
            isUnpriced ? '—' : formatUsd(cVal, { precise: cVal > 0 && cVal < 0.01 })
          );
          patchText(refs.cacheEl, formatPctNumber(m.cacheHitPct ?? 0, { withSymbol: true }));
          patchText(refs.speedEl, formatModelSpeedCell(m.avgTokPerSec));
          const ttftVal = m.avgTtftSec != null ? Number(m.avgTtftSec) : NaN;
          patchText(refs.ttftEl, Number.isFinite(ttftVal) ? `${ttftVal.toFixed(1)}s` : '--');
          patchText(refs.callsEl, String(calls));
        },
      });

      viewScrollbar.refresh();
    }

    const unsub = telemetryStore.subscribe(
      (st) => ({
        range: st.selectedTimeRange,
        customStartMs: st.customStartMs,
        customEndMs: st.customEndMs,
        consumption: st.telemetry?.consumption,
        modelBreakdown: st.telemetry?.modelBreakdown,
        modelDisplayMode: normalizeModelDisplayMode(
          st.telemetry?.settings?.modelDisplayMode,
          st.telemetry?.settings?.showUpstreamModel
        ),
        showUpstreamModel: Boolean(st.telemetry?.settings?.showUpstreamModel),
        orchestratorIdMode: normalizeOrchestratorIdDisplayMode(
          st.telemetry?.settings?.orchestratorIdMode
        ),
      }),
      (slice) => {
        latestSlice = slice;
        if (getVisibleMonitorView() !== 'consumption') {
          isDirty = true;
          return;
        }
        isDirty = false;
        renderConsumptionData(slice);
        if (!prefetchedOnCurrentVisit && Number(slice?.consumption?.revision || 0) > 0) {
          prefetchedOnCurrentVisit = true;
          void prefetchConsumptionPresets();
        }
      }
    );

    const unsubView = uiStore.subscribe(
      getVisibleMonitorView,
      (activeView) => {
        if (activeView !== 'consumption') {
          prefetchedOnCurrentVisit = false;
          return;
        }
        if (isDirty) {
          isDirty = false;
          if (latestSlice) {
            renderConsumptionData(latestSlice);
          }
        }
        if (!prefetchedOnCurrentVisit && Number(latestSlice?.consumption?.revision || 0) > 0) {
          prefetchedOnCurrentVisit = true;
          void prefetchConsumptionPresets();
        }
      }
    );

    function syncStaticLocaleLabels() {
      timeFilterSwitch.setProps({
        ariaLabel: t('cons.rangeAria'),
        options: getConsumptionTimeRangeOptions(),
      });
      patchText(applyCustomBtnLabel, t('cons.applyFilter'));
      patchText(rangeToSpan, t('cons.rangeTo'));
      patchText(totalTokensLabel, t('cons.totalTokens'));
      patchText(heroSplitInputLabel, t('cons.footInput'));
      patchText(heroSplitCacheLabel, t('cons.footCache'));
      patchText(heroSplitOutputLabel, t('cons.footOutput'));
      patchText(estCostLabel, t('cons.estCost'));
      patchText(cacheHitRateLabel, t('cons.cacheHitRate'));
      patchText(avgSpeedLabel, t('cons.avgOutputSpeed'));
      consExportMenu.refs.setAriaLabel(t('cons.exportMenuAria'));
      consExportMenu.refs.updateItemLabels({
        xlsx: { label: t('cons.exportXlsx'), title: t('cons.exportXlsxTip') },
        md: { label: t('cons.exportMd'), title: t('cons.exportMdTip') },
      });
      patchText(trendTitleSpan, t('cons.trendTitle'));
      heatmapModeSwitch.setProps({
        ariaLabel: t('cons.hmModeAria'),
        modelValue: heatmapViewMode,
        options: getHeatmapModeOptions(),
      });
      patchText(modelsTitleSpan, t('cons.modelsTableTitle'));
      patchText(thColModel, t('cons.colModel'));
      patchText(thColShare, t('cons.colShare'));
      patchText(thColTokens, t('cons.colTokens'));
      patchText(thColCost, t('cons.colCost'));
      patchText(thColCache, t('cons.colCache'));
      patchText(thColSpeed, t('cons.colSpeed'));
      patchText(thColTtft, t('cons.colTtft'));
      patchText(thColCalls, t('cons.colCalls'));
      patchText(modelsEmptyEl, t('cons.modelsTableEmpty'));
    }

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        syncStaticLocaleLabels();
        if (getVisibleMonitorView() === 'consumption' && latestSlice) {
          isDirty = false;
          renderConsumptionData(latestSlice);
        } else {
          isDirty = true;
        }
      }
    );

    onCleanup(() => {
      unsub();
      unsubView();
      unsubI18n();
      consExportMenu.destroy();
      heatmapModeSwitch.destroy();
      trendChart.destroy?.();
      timeFilterSwitch.destroy();
      startPicker.destroy();
      endPicker.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: rootEl,
      refs: {
        timeFilterSwitch,
        heatmapModeSwitch,
        trendChart,
        startPicker,
        endPicker,
        viewScrollbar,
        consExportMenu,
      },
    };
  },
});
