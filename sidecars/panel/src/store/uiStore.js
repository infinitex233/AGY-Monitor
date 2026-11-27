/**
 * @fileoverview UI navigation and view state store.
 */

import { createReactiveStore } from '../core/reactive.js';
import { t } from '../i18n/index.js';

export function getViewTabs() {
  return [
    { value: 'overview', label: t('nav.overview'), icon: 'pulse' },
    { value: 'consumption', label: t('nav.consumption'), icon: 'chart-bar' },
    { value: 'settings', label: t('nav.settings'), icon: 'sliders' },
  ];
}

const STEPS_VIEW_MODE_STORAGE_KEY = 'agy.stepsViewMode';
const VALID_STEPS_VIEW_MODES = new Set(['table', 'dots', 'curve']);

function loadInitialStepsViewMode() {
  try {
    const saved = globalThis.localStorage?.getItem?.(STEPS_VIEW_MODE_STORAGE_KEY);
    if (VALID_STEPS_VIEW_MODES.has(saved)) return saved;
  } catch {
    // ignore storage restriction
  }
  return 'table';
}

export function setStepsViewMode(mode) {
  const next = VALID_STEPS_VIEW_MODES.has(mode) ? mode : 'table';
  try {
    globalThis.localStorage?.setItem?.(STEPS_VIEW_MODE_STORAGE_KEY, next);
  } catch {
    // ignore storage restriction
  }
  uiStore.setState({ stepsViewMode: next });
}

export const uiStore = createReactiveStore({
  activeView: 'overview',
  monitorVisible: true,
  stepsViewMode: loadInitialStepsViewMode(), // 'table' | 'dots' | 'curve'
  selectedAgentScope: 'all', // 'all' | 'main' | <subagent cascadeId>
  ctxInspectorAgentId: 'main', // 'main' | 'auto' | <subagent cascadeId>
  toast: null, // { id, message, detail, actionLabel, onAction, tone, durationMs }
});

let toastSeq = 0;

/**
 * 触发全局底部轻量通知条（用于文件导出路径提示、一键定位文件夹及剪贴板复制反馈）。
 *
 * @param {{ message: string, detail?: string, actionLabel?: string, onAction?: (() => void) | null, tone?: 'ok' | 'info' | 'warn', durationMs?: number }} toastConfig
 * @returns {number}
 */
export function showUiToast(toastConfig) {
  if (!toastConfig || !toastConfig.message) return 0;
  toastSeq += 1;
  uiStore.setState({
    toast: {
      id: toastSeq,
      message: String(toastConfig.message),
      detail: toastConfig.detail ? String(toastConfig.detail) : '',
      actionLabel: toastConfig.actionLabel ? String(toastConfig.actionLabel) : '',
      onAction: typeof toastConfig.onAction === 'function' ? toastConfig.onAction : null,
      tone: toastConfig.tone || 'ok',
      durationMs: Number(toastConfig.durationMs) >= 0 ? Number(toastConfig.durationMs) : 5200,
    },
  });
  return toastSeq;
}

export function dismissUiToast(toastId = 0) {
  const cur = uiStore.getState().toast;
  if (!cur) return;
  if (toastId && cur.id !== toastId) return;
  uiStore.setState({ toast: null });
}

export function getVisibleMonitorView(state = uiStore.getState()) {
  return state.monitorVisible ? state.activeView : null;
}
