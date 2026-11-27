/**
 * @fileoverview 跨 Backend / Frontend / CLI 共用的纯展示阈值、紧凑格式化与精确整数缩放规则。
 */

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
