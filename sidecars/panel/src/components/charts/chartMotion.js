/**
 * @fileoverview Pointer-following tooltips, curve morphing, and transition arming
 * for the consumption trend chart and heatmap.
 */

import { patchAttr, patchClasses, patchStyleVar } from '../../core/domPatch.js';

export const CHART_CURVE_MORPH_MS = 240;

/**
 * Checks whether smooth `requestAnimationFrame` chart animations should run in the current
 * environment (browser runtime with `prefers-reduced-motion` not enabled).
 */
export function canAnimateChartInBrowser() {
  if (
    typeof window === 'undefined' ||
    typeof window.requestAnimationFrame !== 'function' ||
    typeof window.getComputedStyle !== 'function' ||
    typeof performance === 'undefined' ||
    typeof performance.now !== 'function'
  ) {
    return false;
  }
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    return false;
  }
  return true;
}

/**
 * Solves standard CSS `cubic-bezier(x1, y1, x2, y2)` at progress `t` (`0..1`)
 * so JS path morphing, peak-pill gliding, and CSS bar transitions stay in lockstep.
 */
export function evalCubicBezier(x1, y1, x2, y2, t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const s = (lo + hi) * 0.5;
    const inv = 1 - s;
    const bx = 3 * inv * inv * s * x1 + 3 * inv * s * s * x2 + s * s * s;
    if (bx < t) lo = s;
    else hi = s;
  }
  const s = (lo + hi) * 0.5;
  const inv = 1 - s;
  return 3 * inv * inv * s * y1 + 3 * inv * s * s * y2 + s * s * s;
}

/**
 * Arms a CSS transition readiness class (e.g. `.is-ready` on `.trend-peak-pill`) on the next
 * animation frame so initial placement snaps cleanly without sliding in from `50%`.
 */
export function createReadyClassArmer(el, readyClass = 'is-ready') {
  let armed = false;
  let rafId = 0;

  function cancel() {
    if (rafId && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(rafId);
    }
    rafId = 0;
  }

  function arm() {
    if (armed) return;
    armed = true;
    if (canAnimateChartInBrowser()) {
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        patchClasses(el, { [readyClass]: true });
      });
    } else {
      patchClasses(el, { [readyClass]: true });
    }
  }

  return { arm, cancel };
}

/**
 * Converts 2D SVG points into a normalized horizontal (`u` in `0..1`) cubic-Bezier chain
 * with horizontal endpoint tangents (`0.42` tension by default, zero vertical overshoot).
 * Supports both uniform slot spacing and arbitrary timestamp/x coordinates via `leftX` + `spanX`.
 *
 * @param {Array<{ x?: number, y: number }>} pts
 * @param {number} bottomY
 * @param {{ leftX?: number, spanX?: number, tension?: number }} [opts]
 */
export function pointsToNormalizedCubicSegs(
  pts,
  bottomY,
  { leftX = 0, spanX = 0, tension = 0.42 } = {}
) {
  const n = Array.isArray(pts) ? pts.length : 0;
  const invT = 1 - tension;
  if (n === 0) {
    return [
      {
        u0: 0,
        y0: bottomY,
        cu1: tension,
        cy1: bottomY,
        cu2: invT,
        cy2: bottomY,
        u3: 1,
        y3: bottomY,
      },
    ];
  }
  if (n === 1) {
    const py = pts[0].y;
    const uMid =
      spanX > 0 && Number.isFinite(pts[0].x)
        ? Math.max(0, Math.min(1, (pts[0].x - leftX) / spanX))
        : 0.5;
    if (Math.abs(py - bottomY) < 0.01) {
      return [
        {
          u0: 0,
          y0: bottomY,
          cu1: tension,
          cy1: bottomY,
          cu2: invT,
          cy2: bottomY,
          u3: 1,
          y3: bottomY,
        },
      ];
    }
    return [
      {
        u0: 0,
        y0: bottomY,
        cu1: uMid * tension,
        cy1: bottomY,
        cu2: uMid * invT,
        cy2: py,
        u3: uMid,
        y3: py,
      },
      {
        u0: uMid,
        y0: py,
        cu1: uMid + (1 - uMid) * tension,
        cy1: py,
        cu2: uMid + (1 - uMid) * invT,
        cy2: bottomY,
        u3: 1,
        y3: bottomY,
      },
    ];
  }

  const useCoordU = spanX > 0 && Number.isFinite(pts[0].x);
  const segs = [];
  let prevU = useCoordU ? Math.max(0, Math.min(1, (pts[0].x - leftX) / spanX)) : 0;
  let prevY = pts[0].y;

  for (let i = 1; i < n; i++) {
    const rawU = useCoordU
      ? Math.max(0, Math.min(1, (pts[i].x - leftX) / spanX))
      : i / (n - 1);
    const u3 = Math.max(prevU, rawU);
    const y3 = pts[i].y;
    if (u3 - prevU <= 1e-6 && i < n - 1 && Math.abs(y3 - prevY) < 0.05) {
      continue;
    }
    const safeU3 = u3 - prevU <= 1e-6 ? Math.min(1, prevU + 1e-5) : u3;
    const du = safeU3 - prevU;
    segs.push({
      u0: prevU,
      y0: prevY,
      cu1: prevU + du * tension,
      cy1: prevY,
      cu2: safeU3 - du * tension,
      cy2: y3,
      u3: safeU3,
      y3,
    });
    prevU = safeU3;
    prevY = y3;
  }

  if (segs.length === 0) {
    return [
      {
        u0: prevU,
        y0: prevY,
        cu1: prevU,
        cy1: prevY,
        cu2: prevU,
        cy2: prevY,
        u3: prevU,
        y3: prevY,
      },
    ];
  }
  return segs;
}

function solveCubicParamForU(seg, targetU) {
  if (targetU <= seg.u0) return 0;
  if (targetU >= seg.u3) return 1;
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 20; it++) {
    const s = (lo + hi) * 0.5;
    const inv = 1 - s;
    const u =
      inv * inv * inv * seg.u0 +
      3 * inv * inv * s * seg.cu1 +
      3 * inv * s * s * seg.cu2 +
      s * s * s * seg.u3;
    if (u < targetU) lo = s;
    else hi = s;
  }
  return (lo + hi) * 0.5;
}

function splitCubicAt(seg, s) {
  const u01 = seg.u0 + (seg.cu1 - seg.u0) * s;
  const y01 = seg.y0 + (seg.cy1 - seg.y0) * s;
  const u12 = seg.cu1 + (seg.cu2 - seg.cu1) * s;
  const y12 = seg.cy1 + (seg.cy2 - seg.cy1) * s;
  const u23 = seg.cu2 + (seg.u3 - seg.cu2) * s;
  const y23 = seg.cy2 + (seg.y3 - seg.cy2) * s;

  const u012 = u01 + (u12 - u01) * s;
  const y012 = y01 + (y12 - y01) * s;
  const u123 = u12 + (u23 - u12) * s;
  const y123 = y12 + (y23 - y12) * s;

  const u0123 = u012 + (u123 - u012) * s;
  const y0123 = y012 + (y123 - y012) * s;

  return [
    { u0: seg.u0, y0: seg.y0, cu1: u01, cy1: y01, cu2: u012, cy2: y012, u3: u0123, y3: y0123 },
    { u0: u0123, y0: y0123, cu1: u123, cy1: y123, cu2: u23, cy2: y23, u3: seg.u3, y3: seg.y3 },
  ];
}

function extractCubicSubsegment(seg, uStart, uEnd) {
  const s0 = solveCubicParamForU(seg, uStart);
  const s1 = solveCubicParamForU(seg, uEnd);
  if (s0 <= 1e-7 && s1 >= 1 - 1e-7) return { ...seg };
  const [, right] = s0 <= 1e-7 ? [null, seg] : splitCubicAt(seg, s0);
  const remSpan = 1 - s0;
  const localS1 = remSpan > 1e-9 ? Math.min(1, Math.max(0, (s1 - s0) / remSpan)) : 1;
  const [sub] = localS1 >= 1 - 1e-7 ? [right] : splitCubicAt(right, localS1);
  sub.u0 = uStart;
  sub.u3 = uEnd;
  return sub;
}

/**
 * Aligns two cubic-Bezier chains (`fromSegs` and `toSegs`, even when their horizontal `[uStart, uEnd]`
 * spans differ) onto a shared normalized `[0..1]` knot partition so every segment pair interpolates
 * smoothly without endpoint snapping.
 */
function alignCubicChainsForMorph(fromSegs, toSegs) {
  const fStart = fromSegs[0].u0;
  const fEnd = fromSegs[fromSegs.length - 1].u3;
  const fSpan = fEnd - fStart;

  const tStart = toSegs[0].u0;
  const tEnd = toSegs[toSegs.length - 1].u3;
  const tSpan = tEnd - tStart;

  const rawTau = [0, 1];
  const pushChainKnots = (segs, start, span) => {
    if (!(span > 1e-6)) return;
    for (let i = 0; i < segs.length; i++) {
      rawTau.push(Math.max(0, Math.min(1, (segs[i].u0 - start) / span)));
      rawTau.push(Math.max(0, Math.min(1, (segs[i].u3 - start) / span)));
    }
  };
  pushChainKnots(toSegs, tStart, tSpan);
  pushChainKnots(fromSegs, fStart, fSpan);

  rawTau.sort((a, b) => a - b);
  const tauKnots = [0];
  for (let i = 1; i < rawTau.length; i++) {
    if (rawTau[i] - tauKnots[tauKnots.length - 1] > 1e-5) {
      tauKnots.push(rawTau[i]);
    }
  }
  if (tauKnots.length === 1) tauKnots.push(1);
  else tauKnots[tauKnots.length - 1] = 1;

  const subdivideOnTau = (segs, start, span) => {
    const out = new Array(tauKnots.length - 1);
    let j = 0;
    for (let k = 0; k < tauKnots.length - 1; k++) {
      const ta = tauKnots[k];
      const tb = tauKnots[k + 1];
      if (!(span > 1e-6)) {
        const s0 = segs[0];
        out[k] = {
          u0: start,
          y0: s0.y0,
          cu1: start,
          cy1: s0.y0,
          cu2: start,
          cy2: s0.y3,
          u3: start,
          y3: s0.y3,
        };
        continue;
      }
      const ua = start + ta * span;
      const ub = start + tb * span;
      const umid = (ua + ub) * 0.5;
      while (j < segs.length - 1 && segs[j].u3 < umid) j++;
      out[k] = extractCubicSubsegment(segs[j], ua, ub);
    }
    return out;
  };

  return {
    alignedFrom: subdivideOnTau(fromSegs, fStart, fSpan),
    alignedTo: subdivideOnTau(toSegs, tStart, tSpan),
  };
}

export function buildPathFromNormalizedSegs(segs, leftX, spanX) {
  const xAt = (u) => (leftX + u * spanX).toFixed(1);
  let d = `M ${xAt(segs[0].u0)} ${segs[0].y0.toFixed(1)}`;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    d += ` C ${xAt(s.cu1)} ${s.cy1.toFixed(1)}, ${xAt(s.cu2)} ${s.cy2.toFixed(1)}, ${xAt(s.u3)} ${s.y3.toFixed(1)}`;
  }
  return d;
}

/**
 * Single-series cubic-Bezier curve + area fill morph controller (used by `TrendAreaChart` and
 * single-series `SessionStepCharts`).
 */
export function createCubicCurveMorphController({ durationMs = CHART_CURVE_MORPH_MS } = {}) {
  let morphRafId = 0;
  let committedSegs = [];
  let liveMorphSegs = null;
  let hasRenderedOnce = false;

  function cancel() {
    if (
      morphRafId &&
      typeof window !== 'undefined' &&
      typeof window.cancelAnimationFrame === 'function'
    ) {
      window.cancelAnimationFrame(morphRafId);
    }
    morphRafId = 0;
  }

  function reset() {
    cancel();
    committedSegs = [];
    liveMorphSegs = null;
    hasRenderedOnce = false;
  }

  function getCurrentSegs() {
    const src = liveMorphSegs || committedSegs;
    return hasRenderedOnce && src.length > 0 ? src.map((s) => ({ ...s })) : [];
  }

  function seedSegs(segs) {
    cancel();
    if (Array.isArray(segs) && segs.length > 0) {
      committedSegs = segs.map((s) => ({ ...s }));
      liveMorphSegs = null;
      hasRenderedOnce = true;
    }
  }

  function morphTo({
    nextSegs,
    leftX,
    spanX,
    bottomY,
    linePath,
    areaPath = null,
    finalLineD,
    finalAreaD = '',
    skipMorph = false,
  }) {
    const prevSegs = liveMorphSegs || committedSegs;
    committedSegs = nextSegs;

    if (
      skipMorph ||
      !hasRenderedOnce ||
      !canAnimateChartInBrowser() ||
      prevSegs.length === 0 ||
      nextSegs.length === 0
    ) {
      hasRenderedOnce = true;
      cancel();
      liveMorphSegs = null;
      patchAttr(linePath, 'd', finalLineD);
      if (areaPath) patchAttr(areaPath, 'd', finalAreaD);
      return;
    }
    hasRenderedOnce = true;
    cancel();

    const { alignedFrom, alignedTo } = alignCubicChainsForMorph(prevSegs, nextSegs);
    const segCount = alignedTo.length;
    let maxDelta = 0;
    for (let i = 0; i < segCount; i++) {
      const a = alignedFrom[i];
      const b = alignedTo[i];
      maxDelta = Math.max(
        maxDelta,
        Math.abs(b.y0 - a.y0),
        Math.abs(b.cy1 - a.cy1),
        Math.abs(b.cy2 - a.cy2),
        Math.abs(b.y3 - a.y3),
        Math.abs(b.u0 - a.u0) * spanX,
        Math.abs(b.u3 - a.u3) * spanX
      );
    }

    if (maxDelta < 0.25) {
      liveMorphSegs = null;
      patchAttr(linePath, 'd', finalLineD);
      if (areaPath) patchAttr(areaPath, 'd', finalAreaD);
      return;
    }

    const activeLive = alignedFrom.map((s) => ({ ...s }));
    liveMorphSegs = activeLive;
    const initialLineD = buildPathFromNormalizedSegs(activeLive, leftX, spanX);
    patchAttr(linePath, 'd', initialLineD);
    if (areaPath) {
      if (finalAreaD) {
        const firstX = (leftX + activeLive[0].u0 * spanX).toFixed(1);
        const lastX = (leftX + activeLive[segCount - 1].u3 * spanX).toFixed(1);
        patchAttr(areaPath, 'd', `${initialLineD} L ${lastX} ${bottomY} L ${firstX} ${bottomY} Z`);
      } else {
        patchAttr(areaPath, 'd', '');
      }
    }
    const startTs = performance.now();

    const step = (nowTs) => {
      const elapsed = Math.max(0, nowTs - startTs);
      const rawT = Math.min(1, elapsed / durationMs);
      if (rawT >= 1) {
        morphRafId = 0;
        liveMorphSegs = null;
        patchAttr(linePath, 'd', finalLineD);
        if (areaPath) patchAttr(areaPath, 'd', finalAreaD);
        return;
      }
      const ease = evalCubicBezier(0.22, 1, 0.36, 1, rawT);
      for (let i = 0; i < segCount; i++) {
        const a = alignedFrom[i];
        const b = alignedTo[i];
        const cur = activeLive[i];
        cur.u0 = a.u0 + (b.u0 - a.u0) * ease;
        cur.y0 = a.y0 + (b.y0 - a.y0) * ease;
        cur.cu1 = a.cu1 + (b.cu1 - a.cu1) * ease;
        cur.cy1 = a.cy1 + (b.cy1 - a.cy1) * ease;
        cur.cu2 = a.cu2 + (b.cu2 - a.cu2) * ease;
        cur.cy2 = a.cy2 + (b.cy2 - a.cy2) * ease;
        cur.u3 = a.u3 + (b.u3 - a.u3) * ease;
        cur.y3 = a.y3 + (b.y3 - a.y3) * ease;
      }
      const morphLineD = buildPathFromNormalizedSegs(activeLive, leftX, spanX);
      patchAttr(linePath, 'd', morphLineD);
      if (areaPath) {
        const firstX = (leftX + activeLive[0].u0 * spanX).toFixed(1);
        const lastX = (leftX + activeLive[segCount - 1].u3 * spanX).toFixed(1);
        patchAttr(areaPath, 'd', `${morphLineD} L ${lastX} ${bottomY} L ${firstX} ${bottomY} Z`);
      }
      morphRafId = window.requestAnimationFrame(step);
    };

    morphRafId = window.requestAnimationFrame(step);
  }

  return { morphTo, cancel, reset, getCurrentSegs, seedSegs };
}

/**
 * Shared 2D pointer-following floating tooltip & focus-dot tracking controller.
 * Positions `.trend-tooltip` smoothly around the pointer (`above -> right -> left -> below`),
 * clamps inside the nearest scrollable viewport container, and arms `.is-tracking` (`150ms`)
 * on both the tooltip and active SVG focus dots after the initial reveal frame.
 */
export function createFloatingChartTooltipController({
  containerEl,
  tooltipEl,
  defaultTipWidth = 216,
  defaultTipHeight = 96,
  defaultViewWidth = 460,
  defaultViewHeight = 184,
  clipSelector = '.view-pane, .cons-view-stage, .table-viewport',
  useFloatingClass = true,
}) {
  if (useFloatingClass) {
    tooltipEl.classList.add('is-floating-tip');
  }

  let cachedWrapRect = null;
  let cachedClipRect = undefined;
  let cachedTipW = 0;
  let cachedTipH = 0;
  let lastSizeKey = null;
  let tipTrackRaf = 0;
  let activeTrackedDots = [];

  function cancelTrackRaf() {
    if (
      tipTrackRaf &&
      typeof window !== 'undefined' &&
      typeof window.cancelAnimationFrame === 'function'
    ) {
      window.cancelAnimationFrame(tipTrackRaf);
    }
    tipTrackRaf = 0;
  }

  function invalidateRects() {
    cachedWrapRect = null;
    cachedClipRect = undefined;
    cachedTipW = 0;
    cachedTipH = 0;
    lastSizeKey = null;
  }

  function getWrapRect() {
    if (!cachedWrapRect) {
      cachedWrapRect = containerEl.getBoundingClientRect?.() || null;
    }
    return cachedWrapRect;
  }

  function syncTrackedDots(nextDots, isTrackingActive) {
    const nextList = Array.isArray(nextDots) ? nextDots.filter(Boolean) : [];
    for (let i = 0; i < activeTrackedDots.length; i++) {
      const prevDot = activeTrackedDots[i];
      if (!nextList.includes(prevDot)) {
        patchClasses(prevDot, { 'is-tracking': false });
      }
    }
    if (isTrackingActive) {
      for (let i = 0; i < nextList.length; i++) {
        patchClasses(nextList[i], { 'is-tracking': true });
      }
    }
    activeTrackedDots = nextList;
  }

  function armTracking(wasHidden, nextDots) {
    if (!wasHidden) {
      syncTrackedDots(nextDots, tooltipEl.classList.contains('is-tracking'));
      return;
    }
    patchClasses(tooltipEl, { 'is-tracking': false });
    const dotList = Array.isArray(nextDots) ? nextDots.filter(Boolean) : [];
    for (let i = 0; i < dotList.length; i++) {
      patchClasses(dotList[i], { 'is-tracking': false });
    }
    activeTrackedDots = dotList;
    void tooltipEl.offsetWidth;
    cancelTrackRaf();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      tipTrackRaf = window.requestAnimationFrame(() => {
        tipTrackRaf = 0;
        if (!tooltipEl.hasAttribute('hidden')) {
          patchClasses(tooltipEl, { 'is-tracking': true });
          for (let i = 0; i < activeTrackedDots.length; i++) {
            patchClasses(activeTrackedDots[i], { 'is-tracking': true });
          }
        }
      });
    } else {
      patchClasses(tooltipEl, { 'is-tracking': true });
      for (let i = 0; i < activeTrackedDots.length; i++) {
        patchClasses(activeTrackedDots[i], { 'is-tracking': true });
      }
    }
  }

  function positionNearAnchor({
    fallbackX,
    fallbackY,
    pointer = null,
    viewWidth = defaultViewWidth,
    viewHeight = defaultViewHeight,
    remeasureTip = false,
  }) {
    const wrapRect = getWrapRect();
    const wrapW =
      wrapRect && wrapRect.width > 0
        ? wrapRect.width
        : Number(containerEl.clientWidth || viewWidth || defaultViewWidth);
    const wrapH =
      wrapRect && wrapRect.height > 0
        ? wrapRect.height
        : Number(containerEl.offsetHeight || viewHeight || defaultViewHeight);

    if (remeasureTip || !(cachedTipW > 0) || !(cachedTipH > 0)) {
      cachedTipW = Number(tooltipEl.offsetWidth || 0) || defaultTipWidth;
      cachedTipH = Number(tooltipEl.offsetHeight || 0) || defaultTipHeight;
    }
    const tipW = cachedTipW;
    const tipH = cachedTipH;

    const hasPointer =
      pointer &&
      Number.isFinite(Number(pointer.clientX)) &&
      Number.isFinite(Number(pointer.clientY)) &&
      wrapRect &&
      wrapRect.width > 0 &&
      wrapRect.height > 0;

    const anchorX = hasPointer ? Number(pointer.clientX) - wrapRect.left : fallbackX;
    const anchorY = hasPointer ? Number(pointer.clientY) - wrapRect.top : fallbackY;

    if (cachedClipRect === undefined) {
      const clipEl = containerEl.closest?.(clipSelector) || null;
      cachedClipRect = clipEl?.getBoundingClientRect?.() || null;
    }
    const clipRect = cachedClipRect;
    const hasClip = Boolean(
      clipRect && clipRect.height > 0 && wrapRect && wrapRect.height > 0
    );
    const minY = hasClip ? clipRect.top - wrapRect.top + 6 : -tipH - 16;
    const maxY = hasClip ? clipRect.bottom - wrapRect.top - tipH - 6 : wrapH + 16;

    const maxLeft = Math.max(4, wrapW - tipW - 4);
    let leftPx = Math.max(4, Math.min(maxLeft, anchorX - tipW / 2));
    const aboveY = anchorY - tipH - 14;
    let topPx;

    if (aboveY >= minY) {
      topPx = Math.min(maxY, aboveY);
    } else if (anchorX + 16 + tipW <= wrapW - 4) {
      leftPx = anchorX + 16;
      topPx = Math.max(minY, Math.min(maxY, anchorY - tipH / 2));
    } else if (anchorX - 16 - tipW >= 4) {
      leftPx = anchorX - 16 - tipW;
      topPx = Math.max(minY, Math.min(maxY, anchorY - tipH / 2));
    } else {
      topPx = Math.max(minY, Math.min(maxY, anchorY + 18));
    }

    patchStyleVar(tooltipEl, '--tip-x', `${Math.round(leftPx)}px`);
    patchStyleVar(tooltipEl, '--tip-shift', '0px');
    patchStyleVar(tooltipEl, '--tip-y', `${Math.round(topPx)}px`);
  }

  function show({
    fallbackX,
    fallbackY,
    pointer = null,
    trackedDots = [],
    viewWidth = defaultViewWidth,
    viewHeight = defaultViewHeight,
    sizeKey = '',
  }) {
    const wasHidden = tooltipEl.hasAttribute('hidden');
    if (wasHidden) {
      patchAttr(tooltipEl, 'hidden', false);
    }
    const normalizedKey = String(sizeKey || '');
    const shouldRemeasure = wasHidden || normalizedKey !== lastSizeKey;
    lastSizeKey = normalizedKey;
    positionNearAnchor({
      fallbackX,
      fallbackY,
      pointer,
      viewWidth,
      viewHeight,
      remeasureTip: shouldRemeasure,
    });
    armTracking(wasHidden, trackedDots);
  }

  function hide() {
    invalidateRects();
    cancelTrackRaf();
    patchAttr(tooltipEl, 'hidden', true);
    patchClasses(tooltipEl, {
      'is-hm-bottom': false,
      'is-hm-top': false,
      'is-line-low': false,
      'is-tracking': false,
    });
    for (let i = 0; i < activeTrackedDots.length; i++) {
      patchClasses(activeTrackedDots[i], { 'is-tracking': false });
    }
    activeTrackedDots = [];
  }

  function destroy() {
    cancelTrackRaf();
    invalidateRects();
    activeTrackedDots = [];
  }

  return {
    show,
    hide,
    getWrapRect,
    invalidateRects,
    destroy,
  };
}
