/**
 * @fileoverview Slot, ring, and odometer primitives for the host window capsule.
 */

import { isModernUiActiveForElement } from '../../core/appearance.js';
import { h, patchAttr, patchClasses, patchStyleVar, patchText } from '../../core/domPatch.js';
import { t } from '../../i18n/index.js';
import { SVG_NS } from '../../icons/SvgIcon.js';
import { resolveCapsuleMetricPresentation } from '../../registries/metricRegistry.js';
import { buildFallbackRunningConversations } from './LiveActivityWidget.js';

export const RING_RADIUS = 5.2;
export const RING_CIRCUMFERENCE = +(2 * Math.PI * RING_RADIUS).toFixed(2);

const ODOMETER_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const capsuleOdometerState = new WeakMap();

/**
 * 将胶囊指标文本拆分为「按数位对齐的数字滚轮 + 静态字符片段」：
 * - 整数部分从右向左按位次键控（个位 `i:0`、十位 `i:1`...），小数部分从左向右键控（`f:0`...）；
 * - 位数增减时既有数位节点原地复用，仅发生变化的数字位执行 0.15s 老虎机垂直滚动，未变位与单位纹丝不动。
 *
 * @param {string} rawText
 * @returns {Array<{ key: string, kind: 'digit' | 'static', digit?: number, text?: string }>}
 */
export function tokenizeCapsuleOdometerText(rawText) {
  const str = String(rawText ?? '');
  if (!str) return [];
  const parts = str.split(/(\d+(?:\.\d+)?)/g);
  const tokens = [];
  let numIdx = 0;
  let staticIdx = 0;

  for (let p = 0; p < parts.length; p += 1) {
    const seg = parts[p];
    if (!seg) continue;
    if (/^\d+(?:\.\d+)?$/.test(seg)) {
      const dotPos = seg.indexOf('.');
      const intPart = dotPos >= 0 ? seg.slice(0, dotPos) : seg;
      const fracPart = dotPos >= 0 ? seg.slice(dotPos + 1) : '';
      const intLen = intPart.length;
      for (let i = 0; i < intLen; i += 1) {
        const place = intLen - 1 - i;
        tokens.push({
          key: `n:${numIdx}:i:${place}`,
          kind: 'digit',
          digit: Number(intPart[i]),
        });
      }
      if (dotPos >= 0) {
        tokens.push({ key: `n:${numIdx}:dot`, kind: 'static', text: '.' });
        for (let j = 0; j < fracPart.length; j += 1) {
          tokens.push({
            key: `n:${numIdx}:f:${j}`,
            kind: 'digit',
            digit: Number(fracPart[j]),
          });
        }
      }
      numIdx += 1;
    } else {
      tokens.push({ key: `s:${staticIdx}`, kind: 'static', text: seg });
      staticIdx += 1;
    }
  }
  return tokens;
}

function createOdometerDigitReel(initialDigit) {
  const cells = ODOMETER_DIGITS.map((d) => h('span', { className: 'wm-od-cell', text: d }));
  const trackEl = h('span', { className: 'wm-od-track' }, cells);
  patchStyleVar(trackEl, '--od-val', String(initialDigit));
  const digitEl = h('span', { className: 'wm-od-digit', 'aria-hidden': 'true' }, [trackEl]);
  return { el: digitEl, trackEl, kind: 'digit', digit: initialDigit };
}

/**
 * 在实验性新 UI (`[data-modern-ui="true"]`) 下将胶囊数字渲染为 0.15s 老虎机垂直滚轮；
 * 经典 UI 或无数字占位文本（如 `-- t/s`）严格退回原生纯文本 `patchText`，零多余 DOM 与动画。
 */
export function patchCapsuleOdometerText(
  el,
  nextValue,
  { resetKey = '', modernUi = undefined } = {}
) {
  if (!el) return false;
  const nextStr = String(nextValue ?? '');
  const isModern = typeof modernUi === 'boolean' ? modernUi : isModernUiActiveForElement(el);
  const prev = capsuleOdometerState.get(el);

  if (!isModern || !/\d/.test(nextStr)) {
    if (prev?.active) {
      el.textContent = '';
      while (el.firstChild) el.removeChild(el.firstChild);
      patchAttr(el, 'data-od-active', null);
      patchAttr(el, 'data-od-value', null);
      patchAttr(el, 'aria-label', null);
    }
    const changed = patchText(el, nextStr);
    capsuleOdometerState.set(el, { active: false, text: nextStr, resetKey, nodes: null });
    return changed;
  }

  if (prev?.active && prev.text === nextStr && prev.resetKey === resetKey) {
    return false;
  }

  let nodes;
  if (!prev?.active || prev.resetKey !== resetKey || !(prev.nodes instanceof Map)) {
    el.textContent = '';
    while (el.firstChild) el.removeChild(el.firstChild);
    nodes = new Map();
  } else {
    nodes = prev.nodes;
  }

  const tokens = tokenizeCapsuleOdometerText(nextStr);
  const nextKeys = new Set();
  const orderedEls = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    nextKeys.add(tok.key);
    let rec = nodes.get(tok.key);
    if (!rec || rec.kind !== tok.kind) {
      if (rec?.el?.parentNode === el) {
        el.removeChild(rec.el);
      }
      if (tok.kind === 'digit') {
        rec = createOdometerDigitReel(tok.digit);
      } else {
        rec = {
          el: h('span', { className: 'wm-od-static', 'aria-hidden': 'true', text: tok.text }),
          trackEl: null,
          kind: 'static',
          text: tok.text,
        };
      }
      nodes.set(tok.key, rec);
    } else if (tok.kind === 'digit') {
      if (rec.digit !== tok.digit) {
        patchStyleVar(rec.trackEl, '--od-val', String(tok.digit));
        rec.digit = tok.digit;
      }
    } else if (rec.text !== tok.text) {
      patchText(rec.el, tok.text);
      rec.text = tok.text;
    }
    orderedEls.push(rec.el);
  }

  for (const [oldKey, rec] of nodes.entries()) {
    if (!nextKeys.has(oldKey)) {
      if (rec.el?.parentNode === el) {
        el.removeChild(rec.el);
      }
      nodes.delete(oldKey);
    }
  }

  for (let i = 0; i < orderedEls.length; i += 1) {
    const targetNode = orderedEls[i];
    const currentNode = el.children[i] || null;
    if (currentNode !== targetNode) {
      el.insertBefore(targetNode, currentNode);
    }
  }

  patchAttr(el, 'data-od-active', '1');
  patchAttr(el, 'data-od-value', nextStr);
  patchAttr(el, 'aria-label', nextStr);
  capsuleOdometerState.set(el, { active: true, text: nextStr, resetKey, nodes });
  return true;
}

function isValidTtftSec(val) {
  return val != null && Number.isFinite(Number(val)) && Number(val) >= 0;
}

function findFallbackRecentStepTtft(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const firstIdx = Number(steps[0]?.stepIndex ?? 0);
  const lastIdx = Number(steps[steps.length - 1]?.stepIndex ?? 0);
  if (firstIdx >= lastIdx) {
    for (let i = 0; i < steps.length; i += 1) {
      const candidate = steps[i]?.ttftSec;
      if (isValidTtftSec(candidate)) return Number(candidate);
    }
    return null;
  }
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const candidate = steps[i]?.ttftSec;
    if (isValidTtftSec(candidate)) return Number(candidate);
  }
  return null;
}

/**
 * Compute shared context ring + 1..5 capsule slot metric payload from telemetry & scoped conversation.
 */
export function buildCapsuleSlotContext(
  data,
  { scopedConv = null, overviewConv = null, ctxAgent = null, aggregated = null } = {}
) {
  if (!data) return { hasTelemetry: false };
  const activeConv = data.activeConversation || {};
  const overviewActive = overviewConv || scopedConv || aggregated || activeConv;
  const capActive = scopedConv || aggregated || activeConv || {};
  const ctx = ctxAgent?.context || overviewActive.context || activeConv.context || {};
  const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
  const totalTokens = Number(ctx.totalTokens || 0);
  const usedPct =
    limitTokens > 0 ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1)) : 0;
  const dashOffset = +(
    RING_CIRCUMFERENCE *
    (1 - Math.max(0, Math.min(100, usedPct)) / 100)
  ).toFixed(2);

  const isRunning = Boolean(aggregated?.isRunning || activeConv.isRunning);
  const convId = String(capActive.cascadeId || activeConv.cascadeId || '')
    .trim()
    .toLowerCase();
  const scopeId = String(scopedConv?.agentId || aggregated?.agentId || 'main');
  const conversationKey = convId ? `${convId}::${scopeId}` : '';
  const stepCount = Math.max(0, Number(capActive.stepCount ?? activeConv.stepCount ?? 0));

  const rawTtft =
    scopedConv?.latestTtftSec ?? aggregated?.latestTtftSec ?? activeConv.latestTtftSec ?? null;
  const fallbackTtft = isValidTtftSec(rawTtft)
    ? Number(rawTtft)
    : scopedConv?.lastKnownTtftSec ??
      findFallbackRecentStepTtft(scopedConv?.recentSteps) ??
      aggregated?.lastKnownTtftSec ??
      activeConv.lastKnownTtftSec ??
      findFallbackRecentStepTtft(activeConv.recentSteps);
  const resolvedTtft = isValidTtftSec(fallbackTtft) ? Number(fallbackTtft) : null;

  const { latestTokPerSec, lastKnownTokPerSec } = capActive;
  const hasLatestTps = Number.isFinite(latestTokPerSec) && latestTokPerSec > 0;
  const tpsIsCarried = !hasLatestTps && Number.isFinite(lastKnownTokPerSec) && lastKnownTokPerSec > 0;

  const capInTok = Math.max(0, Number(capActive.inputTokens || 0));
  const capCacheTok = Math.max(0, Number(capActive.cacheReadTokens || 0));
  const capOutTok = Math.max(0, Number(capActive.outputTokens || 0));
  const sessionTokens =
    stepCount > 0 ||
    capActive.totalTokens != null ||
    capInTok + capCacheTok + capOutTok > 0
      ? Math.max(0, Number(capActive.totalTokens ?? capInTok + capCacheTok + capOutTok))
      : null;

  return {
    hasTelemetry: true,
    conversationKey,
    stepCount,
    usedPct,
    dashOffset,
    isRunning,
    tps: hasLatestTps ? latestTokPerSec : tpsIsCarried ? lastKnownTokPerSec : null,
    tpsIsCarried,
    avgTps: scopedConv?.avgTokPerSec ?? aggregated?.avgTokPerSec ?? activeConv.avgTokPerSec ?? null,
    ttft: resolvedTtft,
    stepCost:
      scopedConv?.latestStepCostUsd ??
      aggregated?.latestStepCostUsd ??
      activeConv.latestStepCostUsd ??
      null,
    sessionCost:
      scopedConv?.sessionCostUsd ?? aggregated?.sessionCostUsd ?? activeConv.sessionCostUsd ?? null,
    cacheHitPct:
      Number(capActive.stepCount || 0) > 0
        ? capActive.latestCacheHitPct ?? capActive.sessionCacheHitPct ?? null
        : null,
    latestPromptTokens: capActive.latestPromptTokens ?? null,
    sessionTokens,
  };
}

/**
 * Compute multi-session button state & normalized running conversation list.
 */
export function resolveMultiSessionCapsuleState(
  data,
  { agents = [], aggregated = null, latestTokPerSec = undefined, contextUsedPct = undefined } = {}
) {
  const rawRunningList = buildFallbackRunningConversations(data, {
    agents,
    aggregated,
    latestTokPerSec,
    contextUsedPct,
  });
  const runningCount = rawRunningList.length;
  const runningSubCount = rawRunningList.reduce(
    (acc, item) => acc + Number(item.runningSubagentCount || 0),
    0
  );
  const runningSwarmCount = rawRunningList.reduce(
    (acc, item) => acc + Number(item.runningSwarmCount || 0),
    0
  );
  const isPureSwarmSubs = runningSubCount > 0 && runningSwarmCount === runningSubCount;
  const hasWaiting = rawRunningList.some((item) => item.mainActivity?.phase === 'waiting');
  const multiBtnText =
    runningCount > 0
      ? runningSubCount > 0
        ? t(isPureSwarmSubs ? 'capsule.multiRunningWithSwarm' : 'capsule.multiRunningWithSubs', {
            count: runningCount,
            subs: runningSubCount,
          })
        : t('capsule.multiRunning', { count: runningCount })
      : t('capsule.multiZero');
  return {
    rawRunningList,
    runningCount,
    runningSubCount,
    runningSwarmCount,
    hasWaiting,
    multiBtnText,
  };
}

/**
 * Create a single reusable capsule metric slot node (`0..4`) with an optional SVG context ring.
 */
export function createCapsuleSlotNode(slotIndex, initialMetric) {
  const ringSvg = document.createElementNS(SVG_NS, 'svg');
  ringSvg.setAttribute('viewBox', '0 0 14 14');
  ringSvg.setAttribute('class', 'wm-ring-svg');
  ringSvg.setAttribute('aria-hidden', 'true');

  const ringTrack = document.createElementNS(SVG_NS, 'circle');
  ringTrack.setAttribute('cx', '7');
  ringTrack.setAttribute('cy', '7');
  ringTrack.setAttribute('r', String(RING_RADIUS));
  ringTrack.setAttribute('class', 'wm-ring-track');

  const ringFill = document.createElementNS(SVG_NS, 'circle');
  ringFill.setAttribute('cx', '7');
  ringFill.setAttribute('cy', '7');
  ringFill.setAttribute('r', String(RING_RADIUS));
  ringFill.setAttribute('class', 'wm-ring-fill');
  ringFill.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  ringFill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));

  ringSvg.appendChild(ringTrack);
  ringSvg.appendChild(ringFill);

  const isNone = initialMetric === 'none';
  const isCtx = initialMetric === 'context';
  const textSpan = h('span', {
    className: isCtx ? 'wm-slot-text wm-ctx-pct' : 'wm-slot-text',
    text: isNone
      ? ''
      : isCtx
        ? '--%'
        : initialMetric === 'tps'
          ? '-- t/s'
          : initialMetric === 'ttft'
            ? '--s'
            : '--%',
  });
  const el = h(
    'span',
    {
      className: isNone
        ? 'wm-cap-slot'
        : isCtx
          ? 'wm-cap-slot wm-ctx-seg'
          : initialMetric === 'tps'
            ? 'wm-cap-slot wm-seg-speed'
            : initialMetric === 'ttft'
              ? 'wm-cap-slot wm-seg-metric'
              : 'wm-cap-slot',
      hidden: isNone,
      'data-slot-idx': String(slotIndex),
      'data-metric': initialMetric,
      'data-vis-rank': isNone ? '' : String(slotIndex + 1),
    },
    isCtx ? [ringSvg, textSpan] : [textSpan]
  );

  return {
    el,
    ringSvg,
    ringFill,
    textSpan,
    ringMounted: isCtx,
    heldTtft: null,
  };
}

/**
 * Patch 5 pre-allocated capsule slots and 4 separators in-place via `metricRegistry`.
 */
export function syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, slotCtx) {
  let visRank = 0;
  const visRanks = [0, 0, 0, 0, 0];
  for (let i = 0; i < capsuleSlots.length; i += 1) {
    const slot = capsuleSlots[i];
    const metricKey = i < slotKeys.length ? slotKeys[i] : 'none';
    if (!slotCtx?.hasTelemetry || metricKey !== 'ttft') {
      slot.heldTtft = null;
    }
    let pres = resolveCapsuleMetricPresentation(metricKey, slotCtx, RING_CIRCUMFERENCE);
    if (metricKey === 'ttft' && slotCtx?.hasTelemetry) {
      const convKey = String(slotCtx.conversationKey || '');
      if (isValidTtftSec(slotCtx.ttft)) {
        slot.heldTtft = convKey ? { conversationKey: convKey, pres } : null;
      } else if (
        convKey &&
        slot.heldTtft &&
        slot.heldTtft.conversationKey === convKey &&
        (slotCtx.isRunning || Number(slotCtx.stepCount) > 0)
      ) {
        pres = { ...slot.heldTtft.pres, running: Boolean(slotCtx.isRunning) };
      } else {
        slot.heldTtft = null;
      }
    }
    if (pres.hidden) {
      patchAttr(slot.el, 'hidden', true);
      patchAttr(slot.el, 'data-metric', 'none');
      patchAttr(slot.el, 'data-vis-rank', '');
      continue;
    }
    visRank += 1;
    visRanks[i] = visRank;
    patchAttr(slot.el, 'hidden', false);
    patchAttr(slot.el, 'data-metric', pres.metric);
    patchAttr(slot.el, 'data-vis-rank', String(visRank));
    patchAttr(slot.el, 'title', pres.title || null);

    if (pres.showRing && !slot.ringMounted) {
      slot.el.insertBefore(slot.ringSvg, slot.el.firstChild || slot.textSpan);
      slot.ringMounted = true;
    } else if (!pres.showRing && slot.ringMounted) {
      slot.ringSvg.remove();
      slot.ringMounted = false;
    }

    const toneCls =
      pres.toneClass || (pres.danger ? 'tone-danger' : pres.warn ? 'tone-warn' : '');
    const fullSegClass = `${pres.segClass}${pres.running ? ' state-running' : ''}${toneCls ? ` ${toneCls}` : ''}`;
    patchAttr(slot.el, 'class', fullSegClass);
    const fullTextClass = `${pres.textClass}${toneCls ? ` ${toneCls}` : ''}`;
    patchAttr(slot.textSpan, 'class', fullTextClass);
    patchCapsuleOdometerText(slot.textSpan, pres.text, { resetKey: pres.metric });

    if (pres.showRing) {
      slot.ringFill.setAttribute('stroke-dashoffset', String(pres.dashOffset));
      patchClasses(slot.ringFill, {
        'is-empty': pres.ringEmpty === true,
        'tone-warn': pres.warn,
        'tone-danger': pres.danger,
      });
    }
  }

  for (let s = 0; s < capsuleSeps.length; s += 1) {
    const sepEl = capsuleSeps[s];
    const nextRank = visRanks[s + 1] || 0;
    const showSep = nextRank >= 2;
    patchAttr(sepEl, 'hidden', !showSep);
    patchAttr(sepEl, 'data-sep-for-rank', showSep ? String(nextRank) : '');
  }
}
