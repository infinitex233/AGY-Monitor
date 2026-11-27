/**
 * @fileoverview 2x2 Synchronized 4-Metric Step Trend Chart (`StepTrendChart.js`).
 * Displays Decode TPS, TTFT, Cache Hit %, and Step Cost in a clean 2x2 quad grid
 * supporting Apple Pulse Dot-Matrix (`dots`) and Smooth Bezier Curve (`curve`) modes,
 * silent median-anchored P85 outlier soft-capping, dynamic cache floor scaling,
 * and synchronized 4-cell hover scrubbing with zero overlapping tooltips.
 */

import { defineComponent } from '../../core/component.js';
import { isLiquidGlassActiveForElement } from '../../core/appearance.js';
import { h, patchAttr, patchText } from '../../core/domPatch.js';
import {
  formatTokens,
  formatUsd,
  resolveModelDisplayInfo,
} from '../../core/formatters.js';
import { t } from '../../i18n/index.js';

const DOT_ROWS = 6;
const MAX_POINTS = 24;

const METRIC_KEYS = ['tps', 'ttft', 'cache', 'cost'];

const METRIC_DEFS = Object.freeze({
  tps: {
    key: 'tps',
    labelKey: 'steps.metricSpeed',
    dotClass: 'is-tps',
    colorVar: '--lg-accent',
    fallbackColor: '#007aff',
    formatParts: (v) =>
      v == null
        ? { num: '—', unit: '' }
        : { num: v >= 100 ? String(Math.round(v)) : v.toFixed(1), unit: 'tok/s' },
  },
  ttft: {
    key: 'ttft',
    labelKey: 'steps.metricTtft',
    dotClass: 'is-ttft',
    colorVar: '--lg-amber',
    fallbackColor: '#ff9500',
    formatParts: (v) =>
      v == null ? { num: '—', unit: '' } : { num: v.toFixed(1), unit: 's' },
  },
  cache: {
    key: 'cache',
    labelKey: 'steps.metricCache',
    dotClass: 'is-cache',
    colorVar: '--lg-green',
    fallbackColor: '#34c759',
    formatParts: (v) =>
      v == null ? { num: '—', unit: '' } : { num: v.toFixed(1), unit: '%' },
  },
  cost: {
    key: 'cost',
    labelKey: 'steps.metricCost',
    dotClass: 'is-cost',
    colorVar: '--lg-purple',
    fallbackColor: '#af52de',
    formatParts: (v) =>
      v == null ? { num: '—', unit: '' } : { num: formatUsd(v, { precise: true }), unit: '' },
  },
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = clamp(Math.floor((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[idx];
}

function toFinitePositive(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toFiniteNonNegative(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function resolveStepCachePct(st) {
  const direct = toFiniteNonNegative(st?.cacheHitPct);
  if (direct != null) return direct;
  const inTok = Math.max(0, Number(st?.inputTokens || 0));
  const cacheTok = Math.max(0, Number(st?.cacheReadTokens || 0));
  const promptTok = inTok + cacheTok;
  return promptTok > 0 ? (cacheTok / promptTok) * 100 : null;
}

function normalizeRecentSeries(rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return [];
  const valid = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const st = rawSteps[i];
    if (!st || typeof st !== 'object') continue;
    const tps = toFinitePositive(st.tokPerSec);
    const ttft = toFiniteNonNegative(st.ttftSec);
    const cache = resolveStepCachePct(st);
    const cost = toFiniteNonNegative(st.costUsd);
    if (tps == null && ttft == null && cache == null && cost == null) continue;
    valid.push({
      step: st,
      stepIndex: Number(st.stepIndex) || 0,
      createdAtMs: Number(st.createdAtMs) || 0,
      order: i,
      tps,
      ttft,
      cache,
      cost,
      outputTokens: Math.max(0, Number(st.outputTokens || 0)),
    });
  }
  if (valid.length === 0) return [];

  valid.sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs && a.createdAtMs > 0 && b.createdAtMs > 0) {
      return a.createdAtMs - b.createdAtMs;
    }
    if (a.stepIndex !== b.stepIndex) return a.stepIndex - b.stepIndex;
    return b.order - a.order;
  });

  return valid.length > MAX_POINTS ? valid.slice(valid.length - MAX_POINTS) : valid;
}

export function computeStepTrendScales(series) {
  const tpsVals = [];
  const ttftVals = [];
  const cacheVals = [];
  const costVals = [];

  for (let i = 0; i < series.length; i++) {
    const item = series[i];
    if (item.tps != null) tpsVals.push(item.tps);
    if (item.ttft != null) ttftVals.push(item.ttft);
    if (item.cache != null) cacheVals.push(item.cache);
    if (item.cost != null) costVals.push(item.cost);
  }

  const maxTpsRaw = tpsVals.length > 0 ? Math.max(...tpsVals) : 0;
  const maxTtftRaw = ttftVals.length > 0 ? Math.max(...ttftVals) : 0;
  const maxCostRaw = costVals.length > 0 ? Math.max(...costVals) : 0;

  // Median-anchored P85 soft-cap resists multiple 1500+ tok/s short-decode spikes
  let tpsCap = 60;
  if (tpsVals.length >= 4) {
    const med = percentile(tpsVals, 0.5);
    const p85 = percentile(tpsVals, 0.85);
    tpsCap = Math.max(Math.min(p85 * 1.18, med * 1.85), med * 1.35, 60);
  } else if (maxTpsRaw > 0) {
    tpsCap = Math.max(maxTpsRaw * 1.12, 60);
  }

  let ttftCap = 2.5;
  if (ttftVals.length >= 4) {
    const med = percentile(ttftVals, 0.5);
    const p90 = percentile(ttftVals, 0.9);
    ttftCap = Math.max(Math.min(p90 * 1.15, med * 2.1), med * 1.35, 2.5);
  } else if (maxTtftRaw > 0) {
    ttftCap = Math.max(maxTtftRaw * 1.12, 2.5);
  }

  let cacheMin = 0;
  const cacheMax = 100;
  if (cacheVals.length > 0) {
    const lo = Math.min(...cacheVals);
    if (lo >= 80) {
      cacheMin = Math.max(0, Math.floor((lo - 3) / 5) * 5);
    }
  }

  let costCap = 0.01;
  if (costVals.length >= 4) {
    const med = percentile(costVals, 0.5);
    const p90 = percentile(costVals, 0.9);
    costCap = Math.max(Math.min(p90 * 1.18, med * 2.2), med * 1.35, 0.005);
  } else if (maxCostRaw > 0) {
    costCap = Math.max(maxCostRaw * 1.15, 0.005);
  }

  const hasOutlier =
    tpsVals.some((v) => v > tpsCap) ||
    ttftVals.some((v) => v > ttftCap) ||
    costVals.some((v) => v > costCap);

  return {
    tpsCap,
    ttftCap,
    cacheMin,
    cacheMax,
    costCap,
    maxTpsRaw,
    maxTtftRaw,
    maxCostRaw,
    hasOutlier,
  };
}

function getMetricRange(metricKey, scales) {
  switch (metricKey) {
    case 'tps':
      return { min: 0, max: scales.tpsCap };
    case 'ttft':
      return { min: 0, max: scales.ttftCap };
    case 'cache':
      return { min: scales.cacheMin, max: scales.cacheMax };
    case 'cost':
    default:
      return { min: 0, max: scales.costCap };
  }
}

function hslToRgb(hDeg, sPct, lPct) {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const s = clamp(sPct / 100, 0, 1);
  const l = clamp(lPct / 100, 0, 1);
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    let u = t;
    if (u < 0) u += 1;
    if (u > 1) u -= 1;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [
    Math.round(hue2rgb(h + 1 / 3) * 255),
    Math.round(hue2rgb(h) * 255),
    Math.round(hue2rgb(h - 1 / 3) * 255),
  ];
}

function parseHueDegrees(rawToken) {
  const t = String(rawToken || '').trim().toLowerCase();
  const num = parseFloat(t);
  if (!Number.isFinite(num)) return NaN;
  if (t.endsWith('grad')) return num * 0.9;
  if (t.endsWith('rad')) return (num * 180) / Math.PI;
  if (t.endsWith('turn')) return num * 360;
  return num;
}

function parseCssAlpha(rawToken) {
  if (rawToken == null || rawToken === '') return 1;
  const t = String(rawToken).trim();
  const val = parseFloat(t);
  if (!Number.isFinite(val)) return NaN;
  return clamp(t.endsWith('%') ? val / 100 : val, 0, 1);
}

function parseUnitFloat(tok) {
  const t = String(tok || '').trim();
  const val = parseFloat(t);
  if (!Number.isFinite(val)) return NaN;
  return t.endsWith('%') ? val / 100 : val;
}

function parseDirectColorComponents(colorStr) {
  const s = String(colorStr || '').trim();
  if (!s) return null;

  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (!/^[0-9a-f]+$/i.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const srcAlpha = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return { r, g, b, srcAlpha };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const srcAlpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, srcAlpha };
    }
    return null;
  }

  const rgbMatch = s.match(/^rgba?\(\s*([^)]+)\)$/i);
  if (rgbMatch) {
    const [colorPart, alphaPart] = rgbMatch[1].split('/');
    const parts = colorPart.trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length >= 3) {
      const parseChan = (tok) => {
        const val = parseFloat(tok);
        if (!Number.isFinite(val)) return NaN;
        return tok.endsWith('%')
          ? clamp(Math.round((val / 100) * 255), 0, 255)
          : clamp(Math.round(val), 0, 255);
      };
      const r = parseChan(parts[0]);
      const g = parseChan(parts[1]);
      const b = parseChan(parts[2]);
      const srcAlpha =
        alphaPart != null ? parseCssAlpha(alphaPart) : parts.length >= 4 ? parseCssAlpha(parts[3]) : 1;
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(srcAlpha)) {
        return { r, g, b, srcAlpha };
      }
    }
    return null;
  }

  const hslMatch = s.match(/^hsla?\(\s*([^)]+)\)$/i);
  if (hslMatch) {
    const [colorPart, alphaPart] = hslMatch[1].split('/');
    const parts = colorPart.trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length >= 3) {
      const hDeg = parseHueDegrees(parts[0]);
      const sPct = parseFloat(parts[1]);
      const lPct = parseFloat(parts[2]);
      const srcAlpha =
        alphaPart != null ? parseCssAlpha(alphaPart) : parts.length >= 4 ? parseCssAlpha(parts[3]) : 1;
      if (
        Number.isFinite(hDeg) &&
        Number.isFinite(sPct) &&
        Number.isFinite(lPct) &&
        Number.isFinite(srcAlpha)
      ) {
        const [r, g, b] = hslToRgb(hDeg, sPct, lPct);
        return { r, g, b, srcAlpha };
      }
    }
    return null;
  }

  const srgbMatch = s.match(/^color\(\s*srgb\s+([^)]+)\)$/i);
  if (srgbMatch) {
    const [colorPart, alphaPart] = srgbMatch[1].split('/');
    const parts = colorPart.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 3) {
      const rUnit = parseUnitFloat(parts[0]);
      const gUnit = parseUnitFloat(parts[1]);
      const bUnit = parseUnitFloat(parts[2]);
      const srcAlpha = alphaPart != null ? parseCssAlpha(alphaPart) : 1;
      if (
        Number.isFinite(rUnit) &&
        Number.isFinite(gUnit) &&
        Number.isFinite(bUnit) &&
        Number.isFinite(srcAlpha)
      ) {
        return {
          r: clamp(Math.round(rUnit * 255), 0, 255),
          g: clamp(Math.round(gUnit * 255), 0, 255),
          b: clamp(Math.round(bUnit * 255), 0, 255),
          srcAlpha,
        };
      }
    }
    return null;
  }

  return null;
}

function probeCanvasColor(colorStr, ctx) {
  if (!ctx || typeof ctx !== 'object' || !('fillStyle' in ctx)) return null;
  const s = String(colorStr || '').trim();
  if (!s) return null;
  const prev = ctx.fillStyle;
  try {
    ctx.fillStyle = '#010203';
    ctx.fillStyle = s;
    const r1 = String(ctx.fillStyle || '');
    if (r1 && r1 !== '#010203') return r1;

    ctx.fillStyle = '#040506';
    ctx.fillStyle = s;
    const r2 = String(ctx.fillStyle || '');
    if (r2 && r2 !== '#040506') return r2;

    return null;
  } catch {
    return null;
  } finally {
    ctx.fillStyle = prev;
  }
}

function resolveCanvasColor(colorStr, fallbackColor, ctx = null) {
  const s = String(colorStr || '').trim();
  const fallback = String(fallbackColor || '#007aff');
  if (!s) return fallback;
  if (parseDirectColorComponents(s)) return s;
  if (ctx && typeof ctx === 'object' && 'fillStyle' in ctx) {
    return probeCanvasColor(s, ctx) || fallback;
  }
  return s;
}

export function parseColorWithAlpha(colorStr, alpha, ctx = null, fallbackColor = '#007aff') {
  const a = clamp(Number(alpha) || 0, 0, 1);
  const s = String(colorStr || '').trim();
  const fallback = String(fallbackColor || '#007aff');
  if (!s) return parseColorWithAlpha(fallback, a, null, '#007aff');

  const direct = parseDirectColorComponents(s);
  if (direct) {
    const outA = +clamp(a * direct.srcAlpha, 0, 1).toFixed(4);
    return `rgba(${direct.r}, ${direct.g}, ${direct.b}, ${outA})`;
  }

  if (ctx && typeof ctx === 'object' && 'fillStyle' in ctx) {
    const probed = probeCanvasColor(s, ctx);
    if (!probed) {
      return parseColorWithAlpha(fallback, a, null, '#007aff');
    }
    const directProbed = parseDirectColorComponents(probed);
    if (directProbed) {
      const outA = +clamp(a * directProbed.srcAlpha, 0, 1).toFixed(4);
      return `rgba(${directProbed.r}, ${directProbed.g}, ${directProbed.b}, ${outA})`;
    }
    if (a <= 0) return 'rgba(0, 0, 0, 0)';
    return `color-mix(in srgb, ${probed} ${+(a * 100).toFixed(2)}%, transparent)`;
  }

  if (a <= 0) return 'rgba(0, 0, 0, 0)';
  return `color-mix(in srgb, ${s} ${+(a * 100).toFixed(2)}%, transparent)`;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export const StepTrendChart = defineComponent({
  name: 'StepTrendChart',
  setup({ props, onCleanup }) {
    const onHoverChange = typeof props?.onHoverChange === 'function' ? props.onHoverChange : null;

    let mode = 'dots'; // 'dots' | 'curve'
    let series = [];
    let scales = computeStepTrendScales([]);
    let displaySettings = {};
    let hoverIdx = -1;
    let rafId = null;
    let resizeObserver = null;

    const animLevels = { tps: [], ttft: [], cache: [], cost: [] };
    const targetLevels = { tps: [], ttft: [], cache: [], cost: [] };

    const cellMap = {};
    const cells = METRIC_KEYS.map((key) => {
      const def = METRIC_DEFS[key];
      const labelTextEl = h('span', { text: t(def.labelKey) });
      const numEl = h('span', { className: 'step-quad-num', text: '—' });
      const unitEl = h('span', { className: 'step-quad-unit', text: '' });
      const canvasEl = h('canvas', { className: 'step-quad-canvas', 'data-metric': key });
      const canvasBoxEl = h('div', { className: 'step-quad-canvas-box' }, [canvasEl]);
      const cellEl = h(
        'div',
        { className: 'step-quad-cell', 'data-metric': key },
        [
          h('div', { className: 'step-quad-head' }, [
            h('span', { className: 'step-quad-label' }, [
              h('span', { className: `step-trend-dot ${def.dotClass}` }),
              labelTextEl,
            ]),
            h('span', { className: 'step-quad-val text-mono' }, [numEl, unitEl]),
          ]),
          canvasBoxEl,
        ]
      );
      const entry = { key, def, cellEl, canvasBoxEl, canvasEl, labelTextEl, numEl, unitEl };
      cellMap[key] = entry;
      return entry;
    });

    const quadGridEl = h(
      'div',
      { className: 'step-quad-grid' },
      cells.map((c) => c.cellEl)
    );
    const emptyEl = h('div', {
      className: 'step-trend-empty',
      text: t('steps.trendEmpty'),
      hidden: true,
    });
    const rootEl = h('div', { className: 'step-trend-wrap' }, [quadGridEl, emptyEl]);

    function readPalette() {
      const isGlass = isLiquidGlassActiveForElement(rootEl);
      const fallback = isGlass
        ? {
            tps: '#007aff',
            ttft: '#ff9500',
            cache: '#34c759',
            cost: '#af52de',
            ink3: 'rgba(17, 17, 19, 0.58)',
            dotIdle: 'rgba(17, 17, 19, 0.075)',
            gridLine: 'rgba(17, 17, 19, 0.065)',
          }
        : {
            tps: '#2563eb',
            ttft: '#d97706',
            cache: '#059669',
            cost: '#8b5cf6',
            ink3: 'rgba(71, 85, 105, 0.72)',
            dotIdle: 'rgba(15, 23, 42, 0.08)',
            gridLine: 'rgba(15, 23, 42, 0.08)',
          };
      if (typeof globalThis.getComputedStyle !== 'function') return fallback;
      try {
        const cs = globalThis.getComputedStyle(rootEl);
        const pick = (v, fb) => {
          const val = cs.getPropertyValue(v)?.trim();
          return val || fb;
        };
        if (isGlass) {
          return {
            tps: pick('--lg-accent', pick('--accent-primary', fallback.tps)),
            ttft: pick('--lg-amber', pick('--metric-warn', fallback.ttft)),
            cache: pick('--lg-green', pick('--metric-ok', fallback.cache)),
            cost: pick('--lg-purple', pick('--ctx-subagent-msg', fallback.cost)),
            ink3: pick('--lg-ink-3', pick('--text-muted', fallback.ink3)),
            dotIdle: pick('--lg-dot-idle', pick('--lg-seg-bg', fallback.dotIdle)),
            gridLine: pick('--lg-divider', fallback.gridLine),
          };
        }
        return {
          tps: pick('--accent-primary', fallback.tps),
          ttft: pick('--metric-warn', fallback.ttft),
          cache: pick('--metric-ok', fallback.cache),
          cost: pick('--ctx-subagent-msg', fallback.cost),
          ink3: pick('--text-muted', fallback.ink3),
          dotIdle: pick('--surface-track', fallback.dotIdle),
          gridLine: pick('--border-hairline', fallback.gridLine),
        };
      } catch {
        return fallback;
      }
    }

    function stopAnim() {
      if (rafId != null && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(rafId);
      }
      rafId = null;
    }

    function prefersReducedMotion() {
      try {
        return Boolean(
          globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
        );
      } catch {
        return false;
      }
    }

    function syncReadouts() {
      const hasData = series.length > 0;
      const isHover = hasData && hoverIdx >= 0 && hoverIdx < series.length;
      const activeItem = isHover ? series[hoverIdx] : hasData ? series[series.length - 1] : null;

      for (const entry of cells) {
        const val = activeItem ? activeItem[entry.key] : null;
        const parts = entry.def.formatParts(val);
        patchText(entry.numEl, parts.num);
        patchText(entry.unitEl, parts.unit);
        patchAttr(entry.unitEl, 'hidden', !parts.unit);
      }

      if (onHoverChange) {
        if (isHover && activeItem) {
          const modelInfo = resolveModelDisplayInfo(activeItem.step, displaySettings, {
            fallback: t('fmt.unknownModel'),
          });
          onHoverChange({
            step: activeItem.step,
            stepIndex: activeItem.stepIndex,
            modelText: modelInfo.text || modelInfo.baseText || '',
            outputTokensText:
              activeItem.outputTokens > 0 ? `${formatTokens(activeItem.outputTokens)} tok` : '',
          });
        } else {
          onHoverChange(null);
        }
      }
    }

    function syncAnimationTargets(immediate = false) {
      let lengthMismatch = false;
      for (const key of METRIC_KEYS) {
        const range = getMetricRange(key, scales);
        const span = Math.max(1e-6, range.max - range.min);
        const next = new Array(series.length);
        for (let i = 0; i < series.length; i++) {
          const v = series[i][key];
          next[i] = v == null ? 0 : clamp(((v - range.min) / span) * DOT_ROWS, 0.75, DOT_ROWS);
        }
        if (animLevels[key].length !== next.length) lengthMismatch = true;
        targetLevels[key] = next;
      }

      const noRaf = typeof globalThis.requestAnimationFrame !== 'function';
      if (immediate || noRaf || prefersReducedMotion() || lengthMismatch) {
        for (const key of METRIC_KEYS) {
          animLevels[key] = targetLevels[key].slice();
        }
        stopAnim();
        draw();
        return;
      }

      if (rafId == null) {
        const tick = () => {
          let moving = false;
          const k = 0.24;
          for (const key of METRIC_KEYS) {
            const cur = animLevels[key];
            const tgt = targetLevels[key];
            for (let i = 0; i < tgt.length; i++) {
              const d = tgt[i] - cur[i];
              if (Math.abs(d) > 0.025) {
                cur[i] += d * k;
                moving = true;
              } else {
                cur[i] = tgt[i];
              }
            }
          }
          draw();
          if (moving) {
            rafId = globalThis.requestAnimationFrame(tick);
          } else {
            rafId = null;
          }
        };
        rafId = globalThis.requestAnimationFrame(tick);
      }
    }

    function paintMetricCanvas(entry, pal) {
      const canvasEl = entry.canvasEl;
      if (typeof canvasEl.getContext !== 'function') return;
      const rect = entry.canvasBoxEl.getBoundingClientRect?.();
      const w = Math.round(rect?.width || 0);
      const h = Math.round(rect?.height || 0);
      if (w <= 0 || h <= 0) return;

      const dpr = Math.min(Number(globalThis.window?.devicePixelRatio) || 1, 2);
      const pxW = Math.max(1, Math.round(w * dpr));
      const pxH = Math.max(1, Math.round(h * dpr));
      if (canvasEl.width !== pxW || canvasEl.height !== pxH) {
        canvasEl.width = pxW;
        canvasEl.height = pxH;
      }

      const ctx = canvasEl.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const n = series.length;
      if (n === 0) return;

      const key = entry.key;
      const color = resolveCanvasColor(pal[key], entry.def.fallbackColor, ctx);
      const range = getMetricRange(key, scales);
      const span = Math.max(1e-6, range.max - range.min);

      if (mode === 'dots') {
        const padX = 1;
        const padY = 2;
        const usableW = Math.max(1, w - padX * 2);
        const usableH = Math.max(1, h - padY * 2);
        const gapX = usableW / n;
        const gapY = usableH / DOT_ROWS;
        const baseRad = Math.max(1.5, Math.min(gapX, gapY) * 0.31);
        const lvls = animLevels[key];

        for (let c = 0; c < n; c++) {
          const level = Math.round(lvls[c] ?? 0);
          const isHover = c === hoverIdx;

          if (isHover) {
            ctx.fillStyle = parseColorWithAlpha(color, 0.14, ctx, entry.def.fallbackColor);
            drawRoundedRect(ctx, padX + c * gapX + 0.5, 0, Math.max(2, gapX - 1), h, 4);
            ctx.fill();
          }

          const rad = isHover ? baseRad * 1.22 : baseRad;
          for (let r = 0; r < DOT_ROWS; r++) {
            const fromBot = DOT_ROWS - 1 - r;
            ctx.fillStyle = fromBot < level ? color : pal.dotIdle;
            const cx = padX + c * gapX + gapX / 2;
            const cy = padY + r * gapY + gapY / 2;
            ctx.beginPath();
            ctx.arc(cx, cy, rad, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else {
        const padX = 4;
        const padTop = 7;
        const padBot = 5;
        const usableW = Math.max(1, w - padX * 2);
        const usableH = Math.max(1, h - padTop - padBot);

        ctx.strokeStyle = pal.gridLine;
        ctx.lineWidth = 1;
        for (let i = 0; i <= 1; i++) {
          const y = Math.round(padTop + usableH * i) + 0.5;
          ctx.beginPath();
          ctx.moveTo(padX, y);
          ctx.lineTo(w - padX, y);
          ctx.stroke();
        }

        const pts = series.map((item, i) => {
          const v = item[key];
          if (v == null) return null;
          return {
            x: padX + (n <= 1 ? usableW / 2 : (i / (n - 1)) * usableW),
            y: padTop + usableH * (1 - clamp((v - range.min) / span, 0, 1)),
          };
        });
        const validPts = pts.filter((p) => p != null);
        if (validPts.length === 1) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(validPts[0].x, validPts[0].y, 3, 0, Math.PI * 2);
          ctx.fill();
        } else if (validPts.length >= 2) {
          const baseY = padTop + usableH;
          const buildPath = () => {
            ctx.beginPath();
            ctx.moveTo(validPts[0].x, validPts[0].y);
            for (let i = 0; i < validPts.length - 1; i++) {
              const p0 = validPts[Math.max(0, i - 1)];
              const p1 = validPts[i];
              const p2 = validPts[i + 1];
              const p3 = validPts[Math.min(validPts.length - 1, i + 2)];
              const cp1x = p1.x + (p2.x - p0.x) / 6;
              const cp1y = clamp(p1.y + (p2.y - p0.y) / 6, padTop - 2, baseY);
              const cp2x = p2.x - (p3.x - p1.x) / 6;
              const cp2y = clamp(p2.y - (p3.y - p1.y) / 6, padTop - 2, baseY);
              ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
            }
          };

          const grad = ctx.createLinearGradient(0, padTop, 0, baseY);
          try {
            grad.addColorStop(0, parseColorWithAlpha(color, 0.24, ctx, entry.def.fallbackColor));
            grad.addColorStop(1, parseColorWithAlpha(color, 0, ctx, entry.def.fallbackColor));
          } catch {
            grad.addColorStop(0, parseColorWithAlpha(entry.def.fallbackColor, 0.24));
            grad.addColorStop(1, parseColorWithAlpha(entry.def.fallbackColor, 0));
          }
          buildPath();
          ctx.lineTo(validPts[validPts.length - 1].x, baseY);
          ctx.lineTo(validPts[0].x, baseY);
          ctx.closePath();
          ctx.fillStyle = grad;
          ctx.fill();

          buildPath();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.8;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();
        }

        if (hoverIdx >= 0 && hoverIdx < n && pts[hoverIdx]) {
          const pt = pts[hoverIdx];
          ctx.save();
          ctx.strokeStyle = pal.ink3;
          ctx.lineWidth = 1;
          ctx.setLineDash([2.5, 2.5]);
          ctx.beginPath();
          ctx.moveTo(pt.x, padTop - 3);
          ctx.lineTo(pt.x, h - padBot + 2);
          ctx.stroke();
          ctx.restore();

          ctx.save();
          ctx.fillStyle = parseColorWithAlpha(color, 0.25, ctx, entry.def.fallbackColor);
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 5.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3.1, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.3;
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    function draw() {
      const hasData = series.length > 0;
      patchAttr(emptyEl, 'hidden', hasData);
      patchAttr(quadGridEl, 'hidden', !hasData);
      syncReadouts();
      if (!hasData) return;

      const pal = readPalette();
      for (const entry of cells) {
        paintMetricCanvas(entry, pal);
      }
    }

    function clearHover() {
      if (hoverIdx !== -1) {
        hoverIdx = -1;
        draw();
      } else if (onHoverChange) {
        onHoverChange(null);
      }
    }

    const pointerCleanups = [];
    for (const entry of cells) {
      const onMove = (e) => {
        if (series.length === 0) return;
        const rect = entry.canvasBoxEl.getBoundingClientRect?.();
        if (!rect || rect.width <= 0) return;
        const padX = mode === 'curve' ? 4 : 1;
        const usableW = Math.max(1, rect.width - padX * 2);
        const x = clamp((e.clientX ?? 0) - rect.left - padX, 0, Math.max(0, usableW - 0.01));
        const idx =
          mode === 'curve' && series.length > 1
            ? clamp(Math.round((x / usableW) * (series.length - 1)), 0, series.length - 1)
            : clamp(Math.floor((x / usableW) * series.length), 0, series.length - 1);
        if (idx !== hoverIdx) {
          hoverIdx = idx;
          draw();
        }
      };
      entry.cellEl.addEventListener?.('pointermove', onMove);
      entry.cellEl.addEventListener?.('pointerleave', clearHover);
      pointerCleanups.push(() => {
        entry.cellEl.removeEventListener?.('pointermove', onMove);
        entry.cellEl.removeEventListener?.('pointerleave', clearHover);
      });
    }

    if (typeof globalThis.ResizeObserver === 'function') {
      resizeObserver = new globalThis.ResizeObserver(() => {
        if (!rootEl.hasAttribute('hidden')) draw();
      });
      resizeObserver.observe(quadGridEl);
    }

    function refreshLabels() {
      for (const entry of cells) {
        patchText(entry.labelTextEl, t(entry.def.labelKey));
      }
      patchText(emptyEl, t('steps.trendEmpty'));
      draw();
    }

    function update({
      steps = [],
      mode: nextMode = mode,
      displaySettings: nextDisplaySettings = {},
      immediate = false,
    } = {}) {
      const modeChanged = nextMode !== mode;
      mode = nextMode === 'curve' ? 'curve' : 'dots';
      displaySettings = nextDisplaySettings || {};
      series = normalizeRecentSeries(steps);
      scales = computeStepTrendScales(series);
      if (hoverIdx >= series.length) {
        hoverIdx = -1;
      }
      syncAnimationTargets(immediate || modeChanged);
    }

    onCleanup(() => {
      stopAnim();
      resizeObserver?.disconnect();
      for (const fn of pointerCleanups) fn();
    });

    return {
      el: rootEl,
      refs: {
        quadGridEl,
        cellMap,
        update,
        draw,
        hideTooltip: clearHover,
        refreshLabels,
        readPalette,
        getPointCount: () => series.length,
        setHoverIndexForTest: (idx) => {
          hoverIdx = idx;
          draw();
        },
      },
    };
  },
});
