/**
 * @fileoverview 消耗统计精简悬浮详情内容组件 (ConsumptionTooltipContent).
 * 供历史趋势（折线/热力图）悬浮卡片复用，保留简洁直观的核心信息：
 * 1. 顶部时间区间 + 右侧调用次数；
 * 2. 核心总量 (`TOKEN`) + 右侧预估费用；
 * 3. 轻量分模型占比列表（仅展示模型名与百分比，不含进度条与通道明细）。
 */

import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../../core/domPatch.js';
import { formatTokensPrecise } from '../../core/formatters.js';
import { t } from '../../i18n/index.js';

function safeNonNeg(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 创建可增量更新的精简消耗统计悬浮详情内容结构。
 *
 * @param {{ monoTitle?: boolean }} [options]
 * @returns {{
 *   children: HTMLElement[],
 *   update: (payload: {
 *     title?: string,
 *     calls?: number,
 *     totalTokens?: number,
 *     costText?: string,
 *     segments?: Array<{ key: string, label: string, pctText: string, isOther?: boolean }>,
 *   }) => void,
 * }}
 */
export function createConsumptionBreakdownContent({
  monoTitle = false,
} = {}) {
  const titleEl = h('span', {
    className: monoTitle ? 'trend-tip-time text-mono' : 'trend-tip-time',
  });
  const callsEl = h('span', { className: 'trend-tip-calls text-mono' });
  const headEl = h('div', { className: 'trend-tip-head cons-tip-head' }, [titleEl, callsEl]);

  const heroNumEl = h('span', { className: 'cons-tip-hero-num', text: '0' });
  const heroUnitEl = h('span', { className: 'cons-tip-hero-unit', text: ' TOKEN' });
  const tokensEl = h('strong', { className: 'trend-tip-tokens cons-tip-hero text-mono' }, [
    heroNumEl,
    heroUnitEl,
  ]);
  const costEl = h('span', { className: 'trend-tip-cost text-mono' });
  const mainEl = h('div', { className: 'trend-tip-main cons-tip-main' }, [tokensEl, costEl]);

  function createModelRow() {
    const nameEl = h('span', { className: 'cons-pop-model-name' });
    const pctEl = h('span', { className: 'cons-pop-model-pct text-mono' });
    const rowEl = h('div', { className: 'cons-pop-model-row' }, [nameEl, pctEl]);
    return {
      el: rowEl,
      refs: { rowEl, nameEl, pctEl },
    };
  }

  const modelsEl = h('div', { className: 'cons-pop-models', hidden: true });

  function update(payload = {}) {
    patchText(titleEl, payload.title || '--');
    patchText(
      callsEl,
      t('cons.callsCount', { calls: Math.max(0, Math.floor(Number(payload.calls) || 0)) })
    );
    const totalTokens = safeNonNeg(payload.totalTokens);
    patchText(heroNumEl, formatTokensPrecise(totalTokens));
    patchText(heroUnitEl, ' TOKEN');
    patchText(costEl, payload.costText || '');

    const rows = Array.isArray(payload.segments) ? payload.segments : [];
    patchAttr(modelsEl, 'hidden', rows.length === 0);
    patchKeyedList(modelsEl, rows, {
      keyFn: (r) => r.key,
      sigFn: (r) => `${r.key}:${r.label}:${r.pctText}:${r.isOther ? 1 : 0}`,
      createRow: createModelRow,
      updateRow: (rRefs, r) => {
        patchClasses(rRefs.rowEl, { 'is-other': Boolean(r.isOther) });
        patchText(rRefs.nameEl, r.label);
        patchText(rRefs.pctEl, r.pctText);
      },
    });
  }

  return {
    children: [headEl, mainEl, modelsEl],
    update,
  };
}
