/**
 * @fileoverview Long-tail model segment partitioner for ConsumptionView (`ConsumptionBreakdownRows.js`).
 */

import {
  formatPctNumber,
  formatTokensPrecise,
  getCanonicalModelColorSeed,
  resolveDeterministicModelColor,
} from '../../core/formatters.js';
import { t } from '../../i18n/index.js';

/**
 * Collapses long-tail model entries into primary segments + an aggregated "Other (N)" tail.
 */
export function partitionModelSegments(
  mergedModels,
  modelColorMap,
  { maxMain = 5, minSharePct = 1.5 } = {}
) {
  if (!Array.isArray(mergedModels) || mergedModels.length === 0) return [];
  const sumTok = mergedModels.reduce((sum, m) => sum + Number(m.totalTokens || 0), 0);
  const mainModels = [];
  const tailModels = [];

  for (let i = 0; i < mergedModels.length; i += 1) {
    const m = mergedModels[i];
    const mTok = Number(m.totalTokens || 0);
    const sharePct = sumTok > 0 ? (mTok / sumTok) * 100 : 0;
    if (i === 0 || (mainModels.length < maxMain && sharePct >= minSharePct)) {
      mainModels.push(m);
    } else {
      tailModels.push(m);
    }
  }

  if (tailModels.length === 1) {
    mainModels.push(tailModels.pop());
  }

  const out = mainModels.map((m) => {
    const seed = getCanonicalModelColorSeed(m);
    const color =
      modelColorMap?.get(seed) || resolveDeterministicModelColor(seed || m.displayText);
    const tok = Number(m.totalTokens || 0);
    const pct = sumTok > 0 ? (tok / sumTok) * 100 : 0;
    const label = m.displayText || m.label || m.shortName || '—';
    const inputTokens = Math.max(0, Number(m.inputTokens || 0));
    const cacheReadTokens = Math.max(0, Number(m.cacheReadTokens || 0));
    const thinkingTokens = Math.max(0, Number(m.thinkingTokens || 0));
    const responseTokens =
      m.responseTokens != null
        ? Math.max(0, Number(m.responseTokens))
        : Math.max(0, Number(m.outputTokens || 0) - thinkingTokens);
    return {
      key: label,
      label,
      tok,
      pct,
      inputTokens,
      cacheReadTokens,
      thinkingTokens,
      responseTokens,
      outputTokens: responseTokens + thinkingTokens,
      tokText: formatTokensPrecise(tok),
      pctText: formatPctNumber(pct, { withSymbol: true }),
      color,
      isOther: false,
    };
  });

  if (tailModels.length >= 2) {
    let otherTok = 0;
    let otherIn = 0;
    let otherCache = 0;
    let otherThink = 0;
    let otherResp = 0;
    for (const m of tailModels) {
      const mt = Math.max(0, Number(m.thinkingTokens || 0));
      const mr =
        m.responseTokens != null
          ? Math.max(0, Number(m.responseTokens))
          : Math.max(0, Number(m.outputTokens || 0) - mt);
      otherTok += Number(m.totalTokens || 0);
      otherIn += Math.max(0, Number(m.inputTokens || 0));
      otherCache += Math.max(0, Number(m.cacheReadTokens || 0));
      otherThink += mt;
      otherResp += mr;
    }
    const otherPct = sumTok > 0 ? (otherTok / sumTok) * 100 : 0;
    const otherLabel = t('cons.otherModelsCount', { count: tailModels.length });
    out.push({
      key: '__other__',
      label: otherLabel,
      tok: otherTok,
      pct: otherPct,
      inputTokens: otherIn,
      cacheReadTokens: otherCache,
      thinkingTokens: otherThink,
      responseTokens: otherResp,
      outputTokens: otherResp + otherThink,
      tokText: formatTokensPrecise(otherTok),
      pctText: formatPctNumber(otherPct, { withSymbol: true }),
      color: 'var(--cons-other-seg)',
      isOther: true,
    });
  }

  return out;
}
