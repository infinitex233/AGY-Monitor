/**
 * @fileoverview Root Application Shell (App.js).
 * Combines the compact dual-layer header (TopSessionHeader + TopLongPillNav)
 * and single-viewport functional views.
 */

import { defineComponent } from './core/component.js';
import { h, patchAttr, patchClasses, patchText } from './core/domPatch.js';
import { isWindowOverlayMode } from './core/httpClient.js';
import { createSvgIcon } from './icons/SvgIcon.js';
import { i18nStore, t } from './i18n/index.js';
import {
  fetchTelemetry,
  getDefaultCtxInspectorAgentId,
  normalizeClientWindowMountMode,
  telemetryStore,
} from './store/telemetryStore.js';
import { dismissUiToast, getViewTabs, uiStore } from './store/uiStore.js';
import { BridgeStatusNotice } from './components/settings/BridgeStatusNotice.js';
import { TopSessionHeader } from './components/layout/TopSessionHeader.js';
import { TopLongPillNav } from './components/ui/TopLongPillNav.js';
import { LiveOverviewView } from './views/LiveOverviewView.js';
import { ConsumptionView } from './views/ConsumptionView.js';
import { SettingsView } from './views/SettingsView.js';

const APP_VIEW_SHORTCUT_MAP = Object.freeze({
  1: 'overview',
  2: 'consumption',
  3: 'settings',
});

function isEditableKeyTarget(e) {
  const path = typeof e?.composedPath === 'function' ? e.composedPath() : null;
  const target = (Array.isArray(path) && path[0]) || e?.target;
  if (!target || typeof target !== 'object') return false;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  if (typeof target.getAttribute === 'function') {
    const ce = target.getAttribute('contenteditable');
    if (ce === '' || ce === 'true') return true;
  }
  return false;
}

export const App = defineComponent({
  name: 'App',
  setup({ onCleanup }) {
    const sessionHeader = TopSessionHeader();
    const initialActiveView = uiStore.getState().activeView;
    const topPillNav = TopLongPillNav({
      modelValue: initialActiveView === 'steps' ? 'overview' : initialActiveView,
      items: getViewTabs(),
      onUpdateModelValue: (nextView) => {
        uiStore.setState({ activeView: nextView });
      },
    });

    const overviewView = LiveOverviewView();
    const consumptionView = ConsumptionView();
    const stepsView = overviewView.refs.stepsView;
    const settingsView = SettingsView();

    const globalBridgeNotice = BridgeStatusNotice({
      dismissible: true,
    });
    const bannerSlotEl = h('div', { className: 'app-bridge-banner-slot', hidden: true }, [
      globalBridgeNotice.el,
    ]);

    function syncGlobalBridgeBanner() {
      const activeView = uiStore.getState().activeView;
      const telemetry = telemetryStore.getState().telemetry;
      const settings = telemetry?.settings;
      const mountMode = settings
        ? normalizeClientWindowMountMode(settings.windowMountMode, settings.enableWindowOverlay)
        : 'sidebar';
      const hasCtxOverrides = Boolean(
        settings?.modelContextWindows && Object.keys(settings.modelContextWindows).length > 0
      );
      const shouldOfferGlobal =
        !isWindowOverlayMode() &&
        activeView !== 'settings' &&
        (mountMode !== 'sidebar' || hasCtxOverrides);
      globalBridgeNotice.refs.update({
        visible: shouldOfferGlobal,
        contextMode: mountMode === 'sidebar' && hasCtxOverrides,
        windowBridge: telemetry?.windowBridge || null,
        hostPlatform: telemetry?.hostPlatform || 'win32',
      });
      patchAttr(bannerSlotEl, 'hidden', globalBridgeNotice.el.hasAttribute('hidden'));
    }

    const viewMap = {
      overview: overviewView.el,
      consumption: consumptionView.el,
      settings: settingsView.el,
    };

    const stageEl = h('div', { className: 'viewport-stage' }, [
      overviewView.el,
      consumptionView.el,
      settingsView.el,
    ]);

    const toastMsgEl = h('span', { className: 'app-toast-msg' });
    const toastDetailEl = h('span', { className: 'app-toast-detail text-mono', hidden: true });
    let activeToastAction = null;
    let activeToastId = 0;
    let toastAutoTimer = null;
    let toastRemainingMs = 0;
    let toastStartedAt = 0;

    function clearToastTimer() {
      if (toastAutoTimer) {
        clearTimeout(toastAutoTimer);
        toastAutoTimer = null;
      }
    }

    function scheduleToastAutoClose(toastId, delayMs) {
      clearToastTimer();
      if (!(delayMs > 0)) return;
      toastRemainingMs = delayMs;
      toastStartedAt = Date.now();
      toastAutoTimer = setTimeout(() => {
        toastAutoTimer = null;
        dismissUiToast(toastId);
      }, delayMs);
    }

    const toastActionLabelEl = h('span');
    const toastActionBtn = h(
      'button',
      {
        type: 'button',
        className: 'app-toast-action',
        hidden: true,
        onclick: () => {
          const fn = activeToastAction;
          if (typeof fn === 'function') fn();
        },
      },
      [createSvgIcon('folder', { size: 12 }), toastActionLabelEl]
    );
    const toastCloseBtn = h(
      'button',
      {
        type: 'button',
        className: 'app-toast-close',
        'aria-label': t('export.closeToast'),
        title: t('export.closeToast'),
        onclick: () => dismissUiToast(activeToastId),
      },
      [createSvgIcon('close', { size: 11 })]
    );
    const toastEl = h(
      'div',
      {
        className: 'app-toast',
        role: 'status',
        'aria-live': 'polite',
        hidden: true,
        onMouseenter: () => {
          if (toastAutoTimer) {
            const elapsed = Date.now() - toastStartedAt;
            toastRemainingMs = Math.max(800, toastRemainingMs - elapsed);
            clearToastTimer();
          }
        },
        onMouseleave: () => {
          if (activeToastId && toastRemainingMs > 0 && !toastAutoTimer) {
            scheduleToastAutoClose(activeToastId, toastRemainingMs);
          }
        },
      },
      [
        h('div', { className: 'app-toast-body' }, [toastMsgEl, toastDetailEl]),
        toastActionBtn,
        toastCloseBtn,
      ]
    );

    function syncToastState(toast) {
      if (!toast || !toast.message) {
        clearToastTimer();
        activeToastId = 0;
        activeToastAction = null;
        toastRemainingMs = 0;
        patchAttr(toastEl, 'hidden', true);
        return;
      }
      activeToastId = toast.id;
      activeToastAction = toast.onAction;
      patchText(toastMsgEl, toast.message);
      const hasDetail = Boolean(toast.detail);
      patchAttr(toastDetailEl, 'hidden', !hasDetail);
      if (hasDetail) {
        patchText(toastDetailEl, toast.detail);
        patchAttr(toastDetailEl, 'title', toast.detail);
      }
      const hasAction = Boolean(toast.actionLabel && typeof toast.onAction === 'function');
      patchAttr(toastActionBtn, 'hidden', !hasAction);
      if (hasAction) {
        patchText(toastActionLabelEl, toast.actionLabel);
      }
      patchClasses(toastEl, {
        'tone-ok': toast.tone === 'ok',
        'tone-info': toast.tone === 'info',
        'tone-warn': toast.tone === 'warn',
      });
      patchAttr(toastEl, 'hidden', false);
      scheduleToastAutoClose(toast.id, toast.durationMs);
    }

    const shellEl = h(
      'main',
      {
        className: 'app-shell',
        tabIndex: -1,
        onKeydown: (e) => {
          if (!e || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
          if (isEditableKeyTarget(e)) return;
          const key = String(e.key || '');
          const mappedView = APP_VIEW_SHORTCUT_MAP[key];
          if (mappedView) {
            e.preventDefault();
            if (uiStore.getState().activeView !== mappedView) {
              uiStore.setState({ activeView: mappedView });
            }
            return;
          }
          if (key === 'r' || key === 'R') {
            e.preventDefault();
            void fetchTelemetry({ force: true });
            return;
          }
          if (key === '/') {
            e.preventDefault();
            sessionHeader.refs?.convSelect?.openAndFocusSearch?.();
          }
        },
      },
      [
        h('div', { className: 'top-deck' }, [sessionHeader.el, topPillNav.el]),
        bannerSlotEl,
        stageEl,
        toastEl,
      ]
    );

    function syncNavTabs() {
      topPillNav.setProps({
        items: getViewTabs(),
      });
    }

    const unsubUi = uiStore.subscribe(
      (st) => st.activeView,
      (activeView) => {
        const targetView = activeView === 'steps' ? 'overview' : activeView;
        topPillNav.setValue(targetView);
        for (const [key, paneEl] of Object.entries(viewMap)) {
          patchAttr(paneEl, 'hidden', key !== targetView);
        }
        if (targetView === 'overview') {
          overviewView.refs?.viewScrollbar?.refresh();
          stepsView?.refs?.refreshStepTableViewport?.();
          stepsView?.refs?.stepsScroll?.refresh();
        } else if (targetView === 'consumption') {
          consumptionView.refs?.viewScrollbar?.refresh();
        } else if (targetView === 'settings') {
          settingsView.refs?.viewScrollbar?.refresh();
        }
        syncGlobalBridgeBanner();
      }
    );

    let syncedSettingsCtxMode = null;

    function syncContextAgentModeFromSettings(settings) {
      if (!settings || typeof settings !== 'object') return;
      const nextMode = getDefaultCtxInspectorAgentId(settings);
      if (nextMode === syncedSettingsCtxMode) return;
      const prevSynced = syncedSettingsCtxMode;
      syncedSettingsCtxMode = nextMode;
      const curCtx = uiStore.getState().ctxInspectorAgentId;
      if (prevSynced !== null || curCtx === 'main' || curCtx === 'auto') {
        if (curCtx !== nextMode) {
          uiStore.setState({ ctxInspectorAgentId: nextMode });
        }
      }
    }

    syncContextAgentModeFromSettings(telemetryStore.getState().telemetry?.settings);

    const unsubStepCount = telemetryStore.subscribe(
      (st) => ({
        windowMountMode: st.telemetry?.settings?.windowMountMode,
        enableWindowOverlay: st.telemetry?.settings?.enableWindowOverlay,
        contextAgentMode: st.telemetry?.settings?.contextAgentMode,
        modelContextWindows: st.telemetry?.settings?.modelContextWindows,
        windowBridge: st.telemetry?.windowBridge,
        hostPlatform: st.telemetry?.hostPlatform,
      }),
      () => {
        syncContextAgentModeFromSettings(telemetryStore.getState().telemetry?.settings);
        syncGlobalBridgeBanner();
      }
    );

    const unsubToast = uiStore.subscribe(
      (st) => st.toast,
      (toast) => syncToastState(toast)
    );
    syncToastState(uiStore.getState().toast);

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        syncNavTabs();
        globalBridgeNotice.refs.refreshLabels();
        patchAttr(bannerSlotEl, 'hidden', globalBridgeNotice.el.hasAttribute('hidden'));
        patchAttr(toastCloseBtn, 'aria-label', t('export.closeToast'));
        patchAttr(toastCloseBtn, 'title', t('export.closeToast'));
      }
    );

    onCleanup(() => {
      clearToastTimer();
      unsubUi();
      unsubStepCount();
      unsubToast();
      unsubI18n();
      globalBridgeNotice.destroy();
      sessionHeader.destroy();
      topPillNav.destroy();
      overviewView.destroy();
      consumptionView.destroy();
      settingsView.destroy();
    });

    return {
      el: shellEl,
      refs: {
        sessionHeader,
        topPillNav,
        globalBridgeNotice,
        toastEl,
        toastActionBtn,
        overviewView,
        consumptionView,
        stepsView,
        settingsView,
      },
    };
  },
});
