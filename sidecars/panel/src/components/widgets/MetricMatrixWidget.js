/**
 * @fileoverview Standalone decoupled Metric Matrix Widget (`MetricMatrixWidget.js`).
 * Renders 1..4 user-selected telemetry cells dynamically via `metricRegistry.js`.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { resolveOverviewMetricCell } from '../../registries/metricRegistry.js';
import {
  normalizeClientOverviewMetrics,
  resolveScopedConversation,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';

const LEGACY_OVERVIEW_METRICS_SIG = 'tps,ttft,avg_tps,step_cost';
const HOVER_REALTIME_METRICS = Object.freeze([
  'tps',
  'ttft',
  'cache_hit',
  'step_cost',
]);
const SESSION_SUMMARY_METRICS = Object.freeze([
  'avg_tps',
  'avg_ttft',
  'avg_cache',
  'session_cost',
]);
const SESSION_SUMMARY_SHORT_LABEL_KEYS = Object.freeze({
  avg_tps: 'ovSummary.avg_tps',
  avg_ttft: 'ovSummary.avg_ttft',
  avg_cache: 'ovSummary.avg_cache',
  session_cost: 'ovSummary.session_cost',
});

export const MetricMatrixWidget = defineComponent({
  name: 'MetricMatrixWidget',
  setup({ props }) {
    const isSessionSummaryPanel = props?.mode === 'overview' && !props?.preview;
    const isHoverMetrics = props?.mode === 'hover';
    const getCtxAgentId =
      typeof props?.getCtxAgentId === 'function'
        ? props.getCtxAgentId
        : () => uiStore.getState().ctxInspectorAgentId;
    const matrixEl = h('section', {
      className: isSessionSummaryPanel
        ? 'telemetry-matrix is-flat-summary'
        : 'telemetry-matrix',
      'aria-label': t('module.metrics'),
      'data-cols': '4',
    });
    patchStyleVar(matrixEl, '--matrix-cols', '4');

    const panelTitleTextEl = isSessionSummaryPanel
      ? h('span', { text: t('ovSummary.title') })
      : null;
    const rootEl = isSessionSummaryPanel
      ? h('section', { className: 'panel session-summary-panel' }, [
          h('div', { className: 'panel-header' }, [
            h('span', { className: 'panel-title' }, [
              createSvgIcon('pulse', { size: 13 }),
              panelTitleTextEl,
            ]),
          ]),
          matrixEl,
        ])
      : matrixEl;

    function createMetricCellNode() {
      const labelSpan = h('span', { text: '—' });
      const iconSvg = createSvgIcon('pulse', { size: 11 });
      const valueEl = h('strong', { className: 'cell-value', text: '—' });
      const el = h('div', { className: 'matrix-cell' }, [
        h('div', { className: 'cell-label' }, [labelSpan, iconSvg]),
        valueEl,
      ]);
      return {
        el,
        refs: { labelSpan, iconSvg, valueEl },
      };
    }

    function update({ data } = {}) {
      patchAttr(matrixEl, 'aria-label', t('module.metrics'));
      if (panelTitleTextEl) {
        patchText(panelTitleTextEl, t('ovSummary.title'));
      }
      const normalizedKeys = normalizeClientOverviewMetrics(data?.settings?.overviewMetrics);
      const isLegacyDefault = normalizedKeys.join(',') === LEGACY_OVERVIEW_METRICS_SIG;
      const metricKeys =
        isSessionSummaryPanel && isLegacyDefault
          ? SESSION_SUMMARY_METRICS
          : isHoverMetrics && isLegacyDefault
            ? HOVER_REALTIME_METRICS
            : normalizedKeys;
      const colCount = Math.max(1, Math.min(4, metricKeys.length));
      patchAttr(matrixEl, 'data-cols', String(colCount));
      patchStyleVar(matrixEl, '--matrix-cols', String(colCount));

      const { hasSubagents, scopedConv, ctxAgent } = resolveScopedConversation(
        data,
        'all',
        getCtxAgentId()
      );
      const active = scopedConv || data?.activeConversation || {};
      const ctx = ctxAgent?.context || active.context || {};
      const settings = data?.settings || {};
      const locale = getEffectiveLocale();

      const cells = metricKeys.map((key) => {
        const cell = resolveOverviewMetricCell(key, {
          active,
          ctx,
          settings,
          hasSubagents,
        });
        if (isSessionSummaryPanel && SESSION_SUMMARY_SHORT_LABEL_KEYS[cell.key]) {
          return {
            ...cell,
            label: t(SESSION_SUMMARY_SHORT_LABEL_KEYS[cell.key]),
          };
        }
        if (isHoverMetrics && cell.key === 'cache_hit') {
          return {
            ...cell,
            label: t('ovHover.cache_hit'),
          };
        }
        return cell;
      });

      patchKeyedList(matrixEl, cells, {
        keyFn: (cell) => cell.key,
        sigFn: (cell) =>
          `${locale}:${cell.key}:${cell.label}:${cell.icon}:${cell.isPulsing}:${cell.valueClass}:${cell.valueText}`,
        createRow: createMetricCellNode,
        updateRow: (refs, cell) => {
          patchText(refs.labelSpan, cell.label);
          patchSvgIcon(refs.iconSvg, cell.icon);
          refs.iconSvg.setAttribute('width', String(cell.iconSize));
          refs.iconSvg.setAttribute('height', String(cell.iconSize));
          patchClasses(refs.iconSvg, { 'is-pulsing': Boolean(cell.isPulsing) });
          patchAttr(refs.valueEl, 'class', cell.valueClass);
          patchText(refs.valueEl, cell.valueText);
        },
      });
    }

    // Initialize default 4-cell skeleton so hover/overview has zero initial height jump
    update({ data: null });

    return {
      el: rootEl,
      refs: { update },
    };
  },
});
