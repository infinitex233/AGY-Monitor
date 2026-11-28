/**
 * @fileoverview 跨 Backend / Frontend / CLI 共用的纯展示阈值、紧凑格式化与精确整数缩放规则。
 */

// Magpie's logarithmic bins place 1 tok/s in bin 400.
const SPEED_HIST_ZERO = 400;
const SPEED_HIST_LOG = Math.log(1.02);
const TPS_CARRY_WINDOW_MS = 120_000;

function normalizeCarryModelId(value) {
  return value && !/^(?:0|unknown|MODEL_(?:UNSPECIFIED|UNKNOWN)|模型未知)$/i.test(value) ? value : '';
}

function getTpsCarryModel(step) {
  return [step.responseModel, step.baseModelUpstream, step.modelKey, step.baseModelLabel, step.modelDisplayName]
    .map(normalizeCarryModelId)
    .find(Boolean) || '';
}

function isSameCarryModel(latest, candidate) {
  const latestModel = getTpsCarryModel(latest);
  const candModel = getTpsCarryModel(candidate);
  if (!latestModel || latestModel !== candModel) return false;
  const latestKey = normalizeCarryModelId(latest.modelKey);
  const candKey = normalizeCarryModelId(candidate.modelKey);
  return !latestKey || !candKey || latestKey === candKey;
}

/** Read decode speed from the latest step or a nearby step of the same model and agent. */
export function findRecentStepTokPerSec(steps, readSpeed, latestIndex = steps.length - 1) {
  const latest = steps[latestIndex];
  if (!latest) return null;
  const latestSpeed = readSpeed(latest);
  if (Number.isFinite(latestSpeed) && latestSpeed > 0) return latestSpeed;

  if (!getTpsCarryModel(latest) || !(latest.createdAtMs > 0)) return null;
  for (let i = latestIndex - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.isCompactionStep || step.isImageGenStep) continue;
    if (!isSameCarryModel(latest, step)) return null;
    if (!(step.createdAtMs > 0) || latest.createdAtMs - step.createdAtMs > TPS_CARRY_WINDOW_MS) {
      return null;
    }
    const speed = readSpeed(step);
    if (Number.isFinite(speed) && speed > 0) return speed;
  }
  return null;
}

export function speedRateBin(rate) {
  return Math.max(0, Math.floor(Math.log(rate) / SPEED_HIST_LOG) + SPEED_HIST_ZERO);
}

export function medianSpeed(rates) {
  if (rates.length < 2) return rates[0] ?? null;
  const sorted = [...rates].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[middle]) / 2;
}

function medianFromRateBins(rateBins) {
  const bins = Object.entries(rateBins);
  const count = bins.reduce((sum, [, samples]) => sum + samples, 0);
  const lowerRank = Math.floor((count - 1) / 2);
  const upperRank = Math.floor(count / 2);
  let seen = 0;
  let lowerRate = null;
  // Integer object keys are enumerated in ascending bin order.
  for (const [bin, samples] of bins) {
    seen += samples;
    if (seen <= lowerRank) continue;
    const midpoint = Math.exp((Number(bin) - SPEED_HIST_ZERO + 0.5) * SPEED_HIST_LOG);
    lowerRate ??= midpoint;
    if (seen > upperRank) return (lowerRate + midpoint) / 2;
  }
  return null;
}

/** Merge available speed histograms and preserve the exact median of a sole contributor. */
export function mergeSpeedRateBins(summaries) {
  let rateBins;
  let populatedSummaries = 0;
  let exactMedian;
  for (const summary of summaries) {
    if (!summary?.rateBins) continue;
    rateBins ??= {};
    const entries = Object.entries(summary.rateBins);
    if (entries.length === 0) continue;
    populatedSummaries++;
    exactMedian = summary.avgTokPerSec;
    for (const [bin, samples] of entries) {
      rateBins[bin] = (rateBins[bin] || 0) + samples;
    }
  }
  if (!rateBins) return null;
  return {
    rateBins,
    avgTokPerSec:
      populatedSummaries === 1 && Number.isFinite(exactMedian)
        ? exactMedian
        : medianFromRateBins(rateBins),
  };
}

/**
 * 输出速度四档语义色阶分类（`'muted'|'good'|'info'|'warn'|'danger'`）。
 */
export function classifySpeedTier(tokPerSec) {
  if (tokPerSec == null || !Number.isFinite(Number(tokPerSec)) || Number(tokPerSec) <= 0) {
    return 'muted';
  }
  const v = Number(tokPerSec);
  if (v >= 60) return 'good';
  if (v >= 35) return 'info';
  if (v >= 20) return 'warn';
  return 'danger';
}

/**
 * 缓存命中率四档语义色阶分类（`'muted'|'good'|'info'|'warn'|'danger'`）。
 */
export function classifyCacheTier(cacheHitPct, promptTokens = null) {
  if (cacheHitPct == null || !Number.isFinite(Number(cacheHitPct))) {
    return 'muted';
  }
  const v = Number(cacheHitPct);
  if (promptTokens != null && Number(promptTokens) <= 0 && v <= 0) {
    return 'muted';
  }
  if (v >= 85) return 'good';
  if (v >= 65) return 'info';
  if (v >= 30) return 'warn';
  return 'danger';
}

/**
 * 单步费用告警色阶分类（`''|'warn'|'danger'`）。
 */
export function classifyStepCostTier(costUsd) {
  if (costUsd == null || !Number.isFinite(Number(costUsd))) return '';
  const v = Number(costUsd);
  if (v >= 0.3) return 'danger';
  if (v >= 0.15) return 'warn';
  return '';
}

/**
 * 首字延迟告警色阶分类（`'muted'|''|'warn'|'danger'`）。
 */
export function classifyTtftTier(ttftSec) {
  if (ttftSec == null || !Number.isFinite(Number(ttftSec)) || Number(ttftSec) < 0) {
    return 'muted';
  }
  const v = Number(ttftSec);
  if (v >= 30) return 'danger';
  if (v >= 18) return 'warn';
  return '';
}

export function formatCompactTokens(num) {
  const n = Number(num || 0);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCompactCapsuleCost(costUsd) {
  if (costUsd == null || !Number.isFinite(Number(costUsd))) return '--';
  const val = Math.max(0, Number(costUsd));
  if (val === 0) return '$0.00';
  if (val < 0.001) return '<$0.001';
  if (val < 1) return `$${val.toFixed(3)}`;
  if (val < 100) return `$${val.toFixed(2)}`;
  return `$${Math.round(val)}`;
}

export function formatCompactCapsuleTtft(ttftSec) {
  if (ttftSec == null || !Number.isFinite(Number(ttftSec)) || Number(ttftSec) < 0) return '--s';
  const val = Number(ttftSec);
  if (val < 1) return `${val.toFixed(2)}s`;
  if (val < 100) return `${val.toFixed(1)}s`;
  return `${Math.round(val)}s`;
}

/**
 * 使用最大余数法（Hamilton 方法）将各非零分桶等比缩放至目标整数总和，
 * 保证 0 值通道绝不被凭空分配余数，且缩放后各分桶之和精确等于 `targetTotal`。
 *
 * @param {Record<string, number>} buckets
 * @param {readonly string[]} keys
 * @param {number} targetTotal
 * @returns {Record<string, number>}
 */
export function scaleBucketsExact(buckets, keys, targetTotal) {
  const safeTarget = Math.max(0, Math.round(Number(targetTotal || 0)));
  const out = {};
  let currentSum = 0;
  for (const k of keys) {
    const val = Math.max(0, Number(buckets[k] || 0));
    out[k] = val;
    currentSum += val;
  }
  if (safeTarget === 0 || currentSum <= 0) {
    for (const k of keys) out[k] = 0;
    return out;
  }
  if (currentSum === safeTarget) {
    for (const k of keys) out[k] = Math.round(out[k]);
    return out;
  }
  const remainders = [];
  let assigned = 0;
  for (const k of keys) {
    const rawVal = out[k];
    if (rawVal <= 0) {
      out[k] = 0;
      continue;
    }
    const exact = (rawVal * safeTarget) / currentSum;
    const floored = Math.floor(exact);
    out[k] = floored;
    assigned += floored;
    remainders.push({ key: k, rem: exact - floored, orig: rawVal });
  }
  const diff = safeTarget - assigned;
  if (diff > 0 && remainders.length > 0) {
    remainders.sort((a, b) => b.rem - a.rem || b.orig - a.orig);
    for (let i = 0; i < diff; i++) {
      out[remainders[i % remainders.length].key] += 1;
    }
  }
  return out;
}
