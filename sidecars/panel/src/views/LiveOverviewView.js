/**
 * @fileoverview View 1: Decoupled `LiveOverviewView.js` (实时监控视图).
 * Acts as a lightweight host container delegating all telemetry cards
 * (`metrics`, `context`, `live_tasks`) to `widgetRegistry.js` (`a` calls `b`),
 * allowing users to freely reorder or remove any module down to 1 item.
 */

import { defineComponent } from '../core/component.js';
import { h } from '../core/domPatch.js';
import { i18nStore } from '../i18n/index.js';
import { createDynamicWidgetHost } from '../registries/widgetRegistry.js';
import {
  DEFAULT_CLIENT_OVERVIEW_MODULES,
  normalizeClientOverviewModules,
  telemetryStore,
} from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { StepsDetailView } from './StepsDetailView.js';

export { CTX_CHANNEL_DEFS } from '../components/widgets/ContextWindowWidget.js';

function resolveOverviewModules(raw) {
  const normalized = normalizeClientOverviewModules(raw);
  return normalized.length > 0 ? normalized : ['metrics', 'context', 'live_tasks'];
}

export const LiveOverviewView = defineComponent({
  name: 'LiveOverviewView',
  setup({ onCleanup }) {
    const overviewModulesEl = h('div', {
      className: 'overview-modules-host',
    });

    const widgetHost = createDynamicWidgetHost({
      containerEl: overviewModulesEl,
      mode: 'overview',
      isVisibleFn: () => getVisibleMonitorView() === 'overview',
      initialModuleKeys: resolveOverviewModules(DEFAULT_CLIENT_OVERVIEW_MODULES),
    });

    let viewScrollbar = null;
    const stepsView = StepsDetailView({
      embedded: true,
      onLayoutChange: () => viewScrollbar?.refresh(),
    });

    const overviewContentEl = h('div', { className: 'overview-merged-stack' }, [
      overviewModulesEl,
      stepsView.el,
    ]);

    viewScrollbar = CustomScrollbar({
      contentEl: overviewContentEl,
      className: 'view-pane',
    });

    let latestData = null;
    let isDirty = false;
    let countdownTickTimer = null;

    function stopCountdownTicker() {
      if (countdownTickTimer) {
        clearInterval(countdownTickTimer);
        countdownTickTimer = null;
      }
    }

    function ensureCountdownTicker() {
      if (getVisibleMonitorView() !== 'overview') {
        stopCountdownTicker();
        return;
      }
      if (!countdownTickTimer) {
        countdownTickTimer = setInterval(() => {
          if (getVisibleMonitorView() === 'overview' && latestData) {
            renderData(latestData);
          }
        }, 30_000);
      }
    }

    function renderData(data) {
      if (!data) return;
      const moduleKeys = resolveOverviewModules(data.settings?.overviewModules);
      const minuteTick = Math.floor(Date.now() / 30000);
      widgetHost.update({
        moduleKeys,
        data,
        minuteTick,
      });
      ensureCountdownTicker();
      viewScrollbar.refresh();
    }

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({ telemetry: st.telemetry, minuteTick: st.minuteTick }),
      ({ telemetry: data }) => {
        latestData = data;
        if (getVisibleMonitorView() !== 'overview') {
          const stillRunning =
            (Array.isArray(data?.runningConversations) && data.runningConversations.length > 0) ||
            Boolean(
              data?.activeConversation?.isRunning ||
                data?.activeConversation?.aggregated?.isRunning
            );
          if (!stillRunning) {
            widgetHost.pauseTickers();
          }
          isDirty = true;
          return;
        }
        isDirty = false;
        renderData(data);
      }
    );

    let prevCtxTarget = uiStore.getState().ctxInspectorAgentId;

    const unsubView = uiStore.subscribe(
      (st) => ({
        activeView: getVisibleMonitorView(st),
        ctxInspectorAgentId: st.ctxInspectorAgentId,
      }),
      (slice) => {
        const scopeChanged = slice.ctxInspectorAgentId !== prevCtxTarget;
        prevCtxTarget = slice.ctxInspectorAgentId;

        if (slice.activeView !== 'overview') {
          widgetHost.pauseTickers();
          stopCountdownTicker();
          if (scopeChanged) isDirty = true;
          return;
        }
        ensureCountdownTicker();
        if ((isDirty || scopeChanged) && latestData) {
          isDirty = false;
          renderData(latestData);
        } else {
          widgetHost.resumeTickers();
        }
      }
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        if (getVisibleMonitorView() !== 'overview') {
          isDirty = true;
          // Refresh initial skeleton labels even before telemetry arrives
          if (!latestData) {
            widgetHost.update({
              moduleKeys: resolveOverviewModules(DEFAULT_CLIENT_OVERVIEW_MODULES),
              data: null,
            });
          }
          return;
        }
        if (latestData) {
          renderData(latestData);
        } else {
          widgetHost.update({
            moduleKeys: resolveOverviewModules(DEFAULT_CLIENT_OVERVIEW_MODULES),
            data: null,
          });
        }
      }
    );

    onCleanup(() => {
      stopCountdownTicker();
      unsubTelemetry();
      unsubView();
      unsubI18n();
      widgetHost.destroy();
      stepsView.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: viewScrollbar.el,
      refs: { viewScrollbar, widgetHost, stepsView },
    };
  },
});
