/**
 * @fileoverview 原生多工作表 Excel (`.xlsx`)、RFC-4180 防公式注入 CSV 及双语 Markdown 诊断报告生成纯函数模块 (`reportExporter.js`)。
 * 零外部依赖，供「按步查看」和「用量统计」视图复用。
 */

import { medianSpeed, mergeSpeedRateBins } from '../../shared/telemetry-display-rules.mjs';
import { isEnglishLocale } from '../i18n/index.js';
import {
  formatAnomalyKindLabel,
  formatCompactDateTime,
  formatMetric,
  formatPctNumber,
  formatSpeedMetric,
  formatTokensPrecise,
  formatTrendSlotFullLabel,
  formatUsd,
  mergeModelsByDisplayName,
  resolveModelDisplayInfo,
} from './formatters.js';
import { buildXlsxWorkbookBytes } from './xlsxBuilder.js';

const PLAIN_SIGNED_NUMBER_RE = /^[+-]?\d+(\.\d+)?$/;

const RANGE_LABELS_ZH = Object.freeze({
  '5h': '近5小时',
  today: '今日',
  '24h': '近24小时',
  week: '本周',
  '7d': '近7天',
  '14d': '近14天',
  '30d': '近30天',
  all: '全部时间',
  cycle: '当前周期',
  custom: '自定义区间',
});

const RANGE_LABELS_EN = Object.freeze({
  '5h': 'Last 5 Hours',
  today: 'Today',
  '24h': 'Last 24 Hours',
  week: 'This Week',
  '7d': 'Last 7 Days',
  '14d': 'Last 14 Days',
  '30d': 'Last 30 Days',
  all: 'All Time',
  cycle: 'Current Cycle',
  custom: 'Custom Range',
});

const ANOMALY_LABELS_ZH = Object.freeze({
  timeout: '流空闲 / 连接超时',
  rate_limit: '429 限流 / 配额耗尽',
  capacity: '503 上游算力不足',
  disconnect: '连接中断 / 断流',
  upstream: '上游 5xx 内部错误',
  model_output: '模型输出 / 工具参数无效',
  safety: '内容安全过滤',
  auth_or_model: '请求受限 / 模型不可用',
  error: '调用异常',
  canceled: '用户取消',
});

const ANOMALY_LABELS_EN = Object.freeze({
  timeout: 'Stream Idle / Connect Timeout',
  rate_limit: '429 Rate Limit / Quota Reached',
  capacity: '503 No Capacity Available',
  disconnect: 'Connection Reset / Stream Interrupted',
  upstream: 'Upstream 5xx Internal Error',
  model_output: 'Invalid Model Output / Tool Call',
  safety: 'Content Safety Filter',
  auth_or_model: 'Request / Model Rejected',
  error: 'Call Error',
  canceled: 'Canceled by User',
});

function resolveExportEnglish(locale) {
  if (typeof locale === 'string' && locale.trim()) {
    return locale.trim().toLowerCase().startsWith('en');
  }
  return isEnglishLocale();
}

function formatExportDateTime(ms, includeSeconds = true) {
  const n = Number(ms);
  if (!(n > 0) || !Number.isFinite(n)) return '';
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return includeSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

function formatExportDate(ms) {
  const n = Number(ms);
  if (!(n > 0) || !Number.isFinite(n)) return '';
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function resolveLocalizedRangeLabel(range, en) {
  const r = range || {};
  const key = String(r.key || '').trim().toLowerCase();
  const poolSuffix =
    key === 'cycle' && r.pool && r.pool !== 'all' ? ` · ${r.poolLabel || r.pool}` : '';
  if (en) {
    const baseEn =
      key === 'cycle' && r.isFallbackWeek
        ? 'This Week'
        : RANGE_LABELS_EN[key] || r.label || key || 'All Time';
    return `${baseEn}${poolSuffix}`;
  }
  if (r.label) return r.label;
  const baseZh = RANGE_LABELS_ZH[key] || key || '全部时间';
  return `${baseZh}${poolSuffix}`;
}

function resolveRangeSpanNote(range) {
  const startMs = Number(range?.startMs || 0);
  const endMs = Number(range?.endMs || 0);
  if (startMs > 0 && endMs > 0) {
    return `${formatExportDate(startMs)} ~ ${formatExportDate(endMs)}`;
  }
  return '';
}

function computeCacheHitRatio(inTok, cacheTok, fallbackPct = null) {
  const safeIn = Math.max(0, Number(inTok || 0));
  const safeCache = Math.max(0, Number(cacheTok || 0));
  const promptTok = safeIn + safeCache;
  if (promptTok > 0) {
    return Math.max(0, Math.min(1, safeCache / promptTok));
  }
  if (fallbackPct != null && Number.isFinite(Number(fallbackPct))) {
    return Math.max(0, Math.min(1, Number(fallbackPct) / 100));
  }
  return 0;
}

function formatLocalizedAnomalyKind(kind, en, explicitLocale) {
  const k = String(kind || 'error').trim();
  if (explicitLocale) {
    const dict = en ? ANOMALY_LABELS_EN : ANOMALY_LABELS_ZH;
    if (dict[k]) return dict[k];
  }
  return formatAnomalyKindLabel(k);
}

function formatStepAnomaliesText(st, en, explicitLocale) {
  const anom = st?.anomaly;
  const count = Number(anom?.count || 0);
  if (!(count > 0)) return '';
  const kinds = anom?.kinds && typeof anom.kinds === 'object' ? Object.entries(anom.kinds) : [];
  if (kinds.length > 0) {
    return kinds
      .filter(([, v]) => Number(v || 0) > 0)
      .map(([k, v]) => `${formatLocalizedAnomalyKind(k, en, explicitLocale)} ×${Number(v)}`)
      .join('；');
  }
  return formatLocalizedAnomalyKind(anom?.primaryKind || 'error', en, explicitLocale);
}

function formatStepAgentLabel(st, en) {
  const explicit = String(st?.agentLabel || st?.agentBadge || '').trim();
  if (explicit) return explicit;
  if (st?.isSubagent) {
    return st?.agentId ? String(st.agentId) : en ? 'Subagent' : '子代理';
  }
  return en ? 'Main' : '主会话';
}

function formatTrendWindowLabel(slot, isHourly) {
  if (Number(slot?.startMs) > 0) {
    return isHourly
      ? formatExportDateTime(slot.startMs, false)
      : formatExportDate(slot.startMs);
  }
  return String(slot?.fullLabel || slot?.label || '');
}

function roundExportSpeed(rate) {
  return rate === null ? null : +rate.toFixed(1);
}

function summarizeStepsForExport(list, displaySettings) {
  let sumIn = 0;
  let sumCache = 0;
  let sumOut = 0;
  let sumThink = 0;
  let sumReply = 0;
  let sumCost = 0;
  let sumDuration = 0;
  let maxContext = 0;
  const rates = [];
  let ttftSum = 0;
  let ttftCnt = 0;
  let anomSteps = 0;
  let anomTotal = 0;
  let compactionCount = 0;
  const byModel = new Map();

  for (let i = 0; i < list.length; i += 1) {
    const st = list[i];
    if (!st) continue;
    const inTok = Math.max(0, Number(st.inputTokens || 0));
    const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(st.outputTokens || 0));
    const thinkTok = Math.max(0, Number(st.thinkingTokens || 0));
    const replyTok =
      st.responseTokens != null
        ? Math.max(0, Number(st.responseTokens))
        : Math.max(0, outTok - thinkTok);
    const ctxTok = Math.max(0, Number(st.contextTokens || inTok + cacheTok + outTok));
    const cost = Number(st.costUsd || 0);
    const rawDur = st.totalDurationSec ?? st.durationSec;
    const dur = rawDur != null && Number.isFinite(Number(rawDur)) ? Number(rawDur) : 0;

    sumIn += inTok;
    sumCache += cacheTok;
    sumOut += outTok;
    sumThink += thinkTok;
    sumReply += replyTok;
    if (ctxTok > maxContext) maxContext = ctxTok;
    if (Number.isFinite(cost) && cost > 0) sumCost += cost;
    if (Number.isFinite(dur) && dur > 0) sumDuration += dur;

    const rate = Number(st.totalTokPerSec ?? st.tokPerSec);
    const validTps =
      !st.isCompactionStep &&
      !st.isImageGenStep &&
      st.speedSampleEligible !== false &&
      outTok >= 50 &&
      !(st.selectedSpeedReason ?? st.speedReason) &&
      Number.isFinite(rate) &&
      rate > 0;
    const validTtft =
      !st.isCompactionStep &&
      !st.isImageGenStep &&
      st.ttftSec != null &&
      Number.isFinite(Number(st.ttftSec)) &&
      Number(st.ttftSec) >= 0;
    if (validTps) rates.push(rate);
    if (validTtft) {
      ttftSum += Number(st.ttftSec);
      ttftCnt += 1;
    }
    if (st.isCompactionStep) compactionCount += 1;
    const ac = Number(st.anomaly?.count || 0);
    if (ac > 0) {
      anomSteps += 1;
      anomTotal += ac;
    }

    const mInfo = resolveModelDisplayInfo(st, displaySettings);
    const mKey = mInfo.text || 'Unknown';
    let mAcc = byModel.get(mKey);
    if (!mAcc) {
      mAcc = {
        label: mKey,
        calls: 0,
        inTok: 0,
        cacheTok: 0,
        outTok: 0,
        cost: 0,
        rates: [],
        ttftSum: 0,
        ttftCnt: 0,
      };
      byModel.set(mKey, mAcc);
    }
    mAcc.calls += 1;
    mAcc.inTok += inTok;
    mAcc.cacheTok += cacheTok;
    mAcc.outTok += outTok;
    if (Number.isFinite(cost) && cost > 0) mAcc.cost += cost;
    if (validTps) mAcc.rates.push(rate);
    if (validTtft) {
      mAcc.ttftSum += Number(st.ttftSec);
      mAcc.ttftCnt += 1;
    }
  }

  const sortedModels = Array.from(byModel.values()).sort(
    (a, b) =>
      b.cost - a.cost ||
      b.inTok + b.cacheTok + b.outTok - (a.inTok + a.cacheTok + a.outTok)
  );

  return {
    sumIn,
    sumCache,
    sumOut,
    sumThink,
    sumReply,
    sumCost,
    sumDuration,
    maxContext,
    avgTokPerSec: medianSpeed(rates),
    ttftSum,
    ttftCnt,
    anomSteps,
    anomTotal,
    compactionCount,
    sortedModels,
  };
}

/**
 * RFC-4180 安全转义单个 CSV 单元格，并防御电子表格公式注入（`=`, `+`, `-`, `@`, `\t`, `\r`）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (str.length > 0) {
    const first = str[0];
    if (
      first === '=' ||
      first === '@' ||
      first === '\t' ||
      first === '\r' ||
      ((first === '+' || first === '-') && !PLAIN_SIGNED_NUMBER_RE.test(str.trim()))
    ) {
      str = `'${str}`;
    }
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(cells) {
  return cells.map(escapeCsvCell).join(',');
}

/**
 * 生成安全跨平台导出文件名（剔除非法路径字符并附加 `YYYYMMDD-HHmm` 时间戳）。
 *
 * @param {string} baseName
 * @param {string} ext
 * @param {number} [nowMs]
 * @returns {string}
 */
export function sanitizeExportFilename(baseName, ext = 'xlsx', nowMs = Date.now()) {
  const cleanBase =
    String(baseName || 'usage-report')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'usage-report';
  const d = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const cleanExt = String(ext || 'xlsx').replace(/^\.+/, '');
  return `${cleanBase}-${stamp}.${cleanExt}`;
}

/**
 * 生成按当前界面语言本地化的用量统计导出文件前缀。
 *
 * @param {object} consumption
 * @param {string} [fallbackRange='all']
 * @param {{ locale?: string }} [opts]
 * @returns {string}
 */
export function buildConsumptionExportBaseName(
  consumption,
  fallbackRange = 'all',
  { locale } = {}
) {
  const en = resolveExportEnglish(locale);
  const range = consumption?.selectedRange || { key: fallbackRange };
  const rKey = range.key || fallbackRange || 'all';
  if (en) {
    return `usage-${rKey}`;
  }
  const zhLabel = resolveLocalizedRangeLabel(range, false);
  return `用量统计-${zhLabel}`;
}

/**
 * 生成按当前界面语言本地化的调用明细导出文件前缀。
 *
 * @param {string} [title='']
 * @param {string} [cascadeId='']
 * @param {{ locale?: string }} [opts]
 * @returns {string}
 */
export function buildStepsExportBaseName(title = '', cascadeId = '', { locale } = {}) {
  const en = resolveExportEnglish(locale);
  const name = String(title || cascadeId || '').trim();
  if (en) {
    return `steps-${name || 'session'}`;
  }
  return `调用明细-${name || '当前会话'}`;
}

function escapeMdCell(value) {
  return String(value ?? '—')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * 将当前步骤列表导出为带 UTF-8 BOM 的 RFC-4180 安全 CSV 字符串（向后兼容保留）。
 *
 * @param {Array<object>} steps
 * @param {{ displaySettings?: object, includeBom?: boolean }} [opts]
 * @returns {string}
 */
export function buildStepsCsv(steps, { displaySettings = {}, includeBom = true } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const header = csvRow([
    'step',
    'timestamp',
    'agent',
    'model',
    'raw_model_id',
    'tok_per_sec',
    'ttft_sec',
    'duration_sec',
    'input_tokens',
    'cache_read_tokens',
    'output_tokens',
    'thinking_tokens',
    'response_tokens',
    'context_tokens',
    'cache_hit_pct',
    'cost_usd',
    'compaction',
    'anomaly_count',
    'anomalies',
    'prompt',
  ]);

  const rows = [header];
  for (let i = 0; i < list.length; i += 1) {
    const st = list[i];
    if (!st) continue;
    const mInfo = resolveModelDisplayInfo(st, displaySettings);
    const inTok = Number(st.inputTokens || 0);
    const cacheTok = Number(st.cacheReadTokens || 0);
    const outTok = Number(st.outputTokens || 0);
    const thinkTok = Number(st.thinkingTokens || 0);
    const replyTok =
      st.responseTokens != null ? Number(st.responseTokens) : Math.max(0, outTok - thinkTok);
    const promptTok = inTok + cacheTok;
    const cachePct =
      st.cacheHitPct != null && Number.isFinite(Number(st.cacheHitPct))
        ? formatPctNumber(st.cacheHitPct)
        : promptTok > 0
          ? formatPctNumber((cacheTok / promptTok) * 100)
          : '0';
    const ctxTok = Number(st.contextTokens || promptTok + outTok);
    const anomCount = Number(st.anomaly?.count || 0);
    const anomDesc =
      anomCount > 0
        ? Object.entries(st.anomaly?.kinds || {})
            .map(([k, v]) => `${k}:${v}`)
            .join(';') || String(st.anomaly?.primaryKind || 'error')
        : '';
    rows.push(
      csvRow([
        st.stepIndex ?? '',
        st.createdAtMs ? new Date(st.createdAtMs).toISOString() : '',
        st.agentLabel || st.agentBadge || (st.isSubagent ? st.agentId || 'subagent' : 'main'),
        mInfo.text,
        st.rawModelId || st.modelKey || '',
        st.tokPerSec != null && Number.isFinite(Number(st.tokPerSec))
          ? Number(st.tokPerSec).toFixed(2)
          : '',
        st.ttftSec != null && Number.isFinite(Number(st.ttftSec))
          ? Number(st.ttftSec).toFixed(3)
          : '',
        (st.totalDurationSec ?? st.durationSec) != null &&
        Number.isFinite(Number(st.totalDurationSec ?? st.durationSec))
          ? Number(st.totalDurationSec ?? st.durationSec).toFixed(3)
          : '',
        inTok,
        cacheTok,
        outTok,
        thinkTok,
        replyTok,
        ctxTok,
        cachePct,
        st.costUsd != null && Number.isFinite(Number(st.costUsd))
          ? Number(st.costUsd).toFixed(6)
          : '',
        st.isCompactionStep ? 'true' : 'false',
        anomCount,
        anomDesc,
        String(st.turnPrompt || st.rootTurnPrompt || '').replace(/\r?\n/g, ' ').trim(),
      ])
    );
  }
  return `${includeBom ? '\uFEFF' : ''}${rows.join('\r\n')}\r\n`;
}

/**
 * 将当前步骤列表导出为精排版、多工作表、双语本地化原生 Excel (`.xlsx`) 二进制工作簿。
 * 包含「步骤明细 / Steps」（带异常红底标亮、压缩蓝底提示、自动列宽及数字格式）和「模型汇总 / Model Summary」。
 *
 * @param {Array<object>} steps
 * @param {{ title?: string, cascadeId?: string, displaySettings?: object, locale?: string }} [opts]
 * @returns {Uint8Array}
 */
export function buildStepsXlsx(
  steps,
  { displaySettings = {}, locale } = {}
) {
  const en = resolveExportEnglish(locale);
  const explicitLocale = typeof locale === 'string' && locale.trim().length > 0;
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const agg = summarizeStepsForExport(list, displaySettings);

  const stepRows = [];
  for (let i = 0; i < list.length; i += 1) {
    const st = list[i];
    const mInfo = resolveModelDisplayInfo(st, displaySettings);
    const inTok = Math.max(0, Number(st.inputTokens || 0));
    const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(st.outputTokens || 0));
    const thinkTok = Math.max(0, Number(st.thinkingTokens || 0));
    const replyTok =
      st.responseTokens != null
        ? Math.max(0, Number(st.responseTokens))
        : Math.max(0, outTok - thinkTok);
    const ctxTok = Math.max(0, Number(st.contextTokens || inTok + cacheTok + outTok));
    const cacheRatio = computeCacheHitRatio(inTok, cacheTok, st.cacheHitPct);
    const anomCount = Number(st.anomaly?.count || 0);
    const anomText = formatStepAnomaliesText(st, en, explicitLocale);
    const promptText = String(st.turnPrompt || st.rootTurnPrompt || '')
      .replace(/\r?\n/g, ' ')
      .trim();
    const stepNum = Number.isFinite(Number(st.stepIndex)) ? Number(st.stepIndex) : i + 1;
    const tpsVal =
      !st.isCompactionStep && st.tokPerSec != null && Number.isFinite(Number(st.tokPerSec))
        ? Number(st.tokPerSec)
        : null;
    const ttftVal =
      !st.isCompactionStep && st.ttftSec != null && Number.isFinite(Number(st.ttftSec))
        ? Number(st.ttftSec)
        : null;
    const rawDurVal = st.totalDurationSec ?? st.durationSec;
    const durVal =
      rawDurVal != null && Number.isFinite(Number(rawDurVal))
        ? Number(rawDurVal)
        : null;
    const costVal =
      st.costUsd != null && Number.isFinite(Number(st.costUsd)) ? Number(st.costUsd) : null;
    const typeLabel = st.isCompactionStep
      ? en
        ? 'Compaction'
        : '自动压缩'
      : st.isImageGenStep
        ? en
          ? 'Image Gen'
          : '生成图片'
        : en
          ? 'Normal'
          : '常规';
    const tone = anomCount > 0 ? 'danger' : st.isCompactionStep ? 'info' : '';

    stepRows.push({
      tone,
      values: [
        stepNum,
        formatExportDateTime(st.createdAtMs, true),
        formatStepAgentLabel(st, en),
        mInfo.text || '—',
        typeLabel,
        tpsVal,
        ttftVal,
        durVal,
        inTok,
        cacheTok,
        thinkTok,
        replyTok,
        outTok,
        ctxTok,
        cacheRatio,
        costVal,
        anomText,
        promptText,
      ],
    });
  }

  if (list.length > 0) {
    const overallCacheRatio = computeCacheHitRatio(agg.sumIn, agg.sumCache);
    stepRows.push({
      tone: 'summary',
      values: [
        '',
        '',
        '',
        en ? `Total (${list.length} steps)` : `合计（共 ${list.length} 步）`,
        agg.compactionCount > 0
          ? en
            ? `${agg.compactionCount} compact`
            : `含 ${agg.compactionCount} 次压缩`
          : '',
        roundExportSpeed(agg.avgTokPerSec),
        agg.ttftCnt > 0 ? +(agg.ttftSum / agg.ttftCnt).toFixed(2) : null,
        agg.sumDuration > 0 ? +agg.sumDuration.toFixed(2) : null,
        agg.sumIn,
        agg.sumCache,
        agg.sumThink,
        agg.sumReply,
        agg.sumOut,
        agg.maxContext,
        overallCacheRatio,
        agg.sumCost,
        agg.anomTotal > 0
          ? en
            ? `${agg.anomTotal} events (${agg.anomSteps} steps)`
            : `共 ${agg.anomTotal} 次（${agg.anomSteps} 步）`
          : '',
        '',
      ],
    });
  }

  const sheets = [
    {
      name: en ? 'Steps' : '步骤明细',
      columns: [
        { header: en ? 'Step' : '步骤', type: 'int', minWidth: 9 },
        { header: en ? 'Time' : '时间', type: 'center', minWidth: 21 },
        { header: en ? 'Agent' : '执行体', type: 'center', minWidth: 11 },
        { header: en ? 'Model' : '模型', type: 'text', minWidth: 18, maxWidth: 38 },
        { header: en ? 'Type' : '类型', type: 'center', minWidth: 11 },
        { header: en ? 'Speed (tok/s)' : '速率 (tok/s)', type: 'dec1', minWidth: 14 },
        { header: en ? 'TTFT (s)' : '首字延迟 (s)', type: 'dec2', minWidth: 13 },
        { header: en ? 'Duration (s)' : '总耗时 (s)', type: 'dec2', minWidth: 13 },
        { header: en ? 'Fresh Input' : '新输入', type: 'int', minWidth: 13 },
        { header: en ? 'Cache Read' : '缓存读取', type: 'int', minWidth: 14 },
        { header: en ? 'Thinking' : '思考', type: 'int', minWidth: 11 },
        { header: en ? 'Reply' : '回复', type: 'int', minWidth: 11 },
        { header: en ? 'Output' : '总输出', type: 'int', minWidth: 12 },
        { header: en ? 'Context' : '上下文', type: 'int', minWidth: 14 },
        { header: en ? 'Cache Hit %' : '缓存命中率', type: 'pct', minWidth: 13 },
        { header: en ? 'Cost (USD)' : '费用 (USD)', type: 'usd4', minWidth: 14 },
        { header: en ? 'Anomalies' : '异常诊断', type: 'text', minWidth: 14, maxWidth: 38 },
        { header: en ? 'Turn Prompt' : '用户指令', type: 'text', minWidth: 24, maxWidth: 52 },
      ],
      rows: stepRows,
    },
  ];

  if (agg.sortedModels.length > 0) {
    const modelRows = agg.sortedModels.map((m) => {
      const mTotal = m.inTok + m.cacheTok + m.outTok;
      return [
        m.label,
        m.calls,
        m.inTok,
        m.cacheTok,
        m.outTok,
        mTotal,
        computeCacheHitRatio(m.inTok, m.cacheTok),
        roundExportSpeed(medianSpeed(m.rates)),
        m.ttftCnt > 0 ? +(m.ttftSum / m.ttftCnt).toFixed(2) : null,
        m.cost,
      ];
    });
    modelRows.push({
      tone: 'summary',
      values: [
        en ? 'Total' : '合计',
        list.length,
        agg.sumIn,
        agg.sumCache,
        agg.sumOut,
        agg.sumIn + agg.sumCache + agg.sumOut,
        computeCacheHitRatio(agg.sumIn, agg.sumCache),
        roundExportSpeed(agg.avgTokPerSec),
        agg.ttftCnt > 0 ? +(agg.ttftSum / agg.ttftCnt).toFixed(2) : null,
        agg.sumCost,
      ],
    });
    sheets.push({
      name: en ? 'Model Summary' : '模型汇总',
      columns: [
        { header: en ? 'Model' : '模型', type: 'text', minWidth: 20, maxWidth: 42 },
        { header: en ? 'Steps' : '步数', type: 'int', minWidth: 10 },
        { header: en ? 'Fresh Input' : '新输入', type: 'int', minWidth: 14 },
        { header: en ? 'Cache Read' : '缓存读取', type: 'int', minWidth: 15 },
        { header: en ? 'Output' : '总输出', type: 'int', minWidth: 13 },
        { header: en ? 'Total Tokens' : '总 Token', type: 'int', minWidth: 15 },
        { header: en ? 'Cache Hit %' : '缓存命中率', type: 'pct', minWidth: 13 },
        { header: en ? 'Avg Speed (tok/s)' : '平均速率 (tok/s)', type: 'dec1', minWidth: 16 },
        { header: en ? 'Avg TTFT (s)' : '平均首字 (s)', type: 'dec2', minWidth: 14 },
        { header: en ? 'Est. Cost (USD)' : '预估费用 (USD)', type: 'usd4', minWidth: 16 },
      ],
      rows: modelRows,
    });
  }

  return buildXlsxWorkbookBytes(sheets);
}

/**
 * 生成当前会话（或筛选后步骤子集）的可分享双语 Markdown 诊断报告。
 *
 * @param {Array<object>} steps
 * @param {{ title?: string, cascadeId?: string, displaySettings?: object, filterNote?: string, locale?: string }} [opts]
 * @returns {string}
 */
export function buildStepsMarkdownReport(
  steps,
  { title = '', cascadeId = '', displaySettings = {}, filterNote = '', locale } = {}
) {
  const en = resolveExportEnglish(locale);
  const explicitLocale = typeof locale === 'string' && locale.trim().length > 0;
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const agg = summarizeStepsForExport(list, displaySettings);

  const totalTok = agg.sumIn + agg.sumCache + agg.sumOut;
  const cacheHitPct = formatPctNumber(computeCacheHitRatio(agg.sumIn, agg.sumCache) * 100);
  const avgTps = formatSpeedMetric(agg.avgTokPerSec, ' tok/s');
  const avgTtft = agg.ttftCnt > 0 ? formatMetric(agg.ttftSum / agg.ttftCnt, 's') : '—';
  const heading = title
    ? `# ${title}`
    : en
      ? '# Session Telemetry Report'
      : '# 会话遥测诊断报告';

  const lines = en
    ? [
        heading,
        '',
        ...(cascadeId ? [`- **Session ID**: \`${cascadeId}\``] : []),
        ...(filterNote ? [`- **Scope**: ${filterNote}`] : []),
        `- **Steps**: ${list.length}${agg.compactionCount > 0 ? ` (${agg.compactionCount} compaction)` : ''}${agg.anomTotal > 0 ? ` · **Anomalies**: ${agg.anomTotal} across ${agg.anomSteps} steps` : ''}`,
        `- **Total Tokens**: ${formatTokensPrecise(totalTok)} (Input ${formatTokensPrecise(agg.sumIn)} / Cache ${formatTokensPrecise(agg.sumCache)} · ${cacheHitPct}% / Output ${formatTokensPrecise(agg.sumOut)})`,
        `- **Est. Cost**: ${formatUsd(agg.sumCost, { precise: agg.sumCost > 0 && agg.sumCost < 0.1 })} · **Avg Speed**: ${avgTps} · **Avg TTFT**: ${avgTtft}`,
      ]
    : [
        heading,
        '',
        ...(cascadeId ? [`- **会话 ID**: \`${cascadeId}\``] : []),
        ...(filterNote ? [`- **筛选范围**: ${filterNote}`] : []),
        `- **调用步数**: ${list.length}${agg.compactionCount > 0 ? `（含 ${agg.compactionCount} 次自动压缩）` : ''}${agg.anomTotal > 0 ? ` · **异常事件**: ${agg.anomTotal} 次（涉及 ${agg.anomSteps} 步）` : ''}`,
        `- **总 Token**: ${formatTokensPrecise(totalTok)}（新输入 ${formatTokensPrecise(agg.sumIn)} / 缓存读取 ${formatTokensPrecise(agg.sumCache)} · ${cacheHitPct}% / 输出 ${formatTokensPrecise(agg.sumOut)}）`,
        `- **预估费用**: ${formatUsd(agg.sumCost, { precise: agg.sumCost > 0 && agg.sumCost < 0.1 })} · **平均速率**: ${avgTps} · **平均首字**: ${avgTtft}`,
      ];

  if (agg.sortedModels.length > 0) {
    lines.push(
      '',
      en ? '## Model Breakdown' : '## 模型分布',
      '',
      en
        ? '| Model | Calls | Total Tokens | Cache Hit | Avg Speed | Est. Cost |'
        : '| 模型 | 调用次数 | 总 Token | 缓存命中率 | 平均速率 | 预估费用 |',
      '| --- | ---: | ---: | ---: | ---: | ---: |'
    );
    for (const m of agg.sortedModels) {
      const mTotal = m.inTok + m.cacheTok + m.outTok;
      const mCache = formatPctNumber(computeCacheHitRatio(m.inTok, m.cacheTok) * 100, {
        withSymbol: true,
      });
      const mTps = formatSpeedMetric(medianSpeed(m.rates), ' tok/s');
      lines.push(
        `| ${escapeMdCell(m.label)} | ${m.calls} | ${formatTokensPrecise(mTotal)} | ${mCache} | ${mTps} | ${formatUsd(m.cost, { precise: m.cost > 0 && m.cost < 0.1 })} |`
      );
    }
  }

  const topCostly = list
    .filter((st) => Number(st?.costUsd || 0) > 0)
    .slice()
    .sort((a, b) => Number(b.costUsd || 0) - Number(a.costUsd || 0))
    .slice(0, 5);
  if (topCostly.length > 0) {
    lines.push(
      '',
      en ? '## Top Costliest Steps' : '## 高成本步骤 Top 5',
      '',
      en
        ? '| Step | Time | Model | Speed | TTFT | Context | Cost |'
        : '| 步骤 | 时间 | 模型 | 速率 | 首字延迟 | 上下文 | 费用 |',
      '| ---: | --- | --- | ---: | ---: | ---: | ---: |'
    );
    for (const st of topCostly) {
      const mInfo = resolveModelDisplayInfo(st, displaySettings);
      const timeStr = st.createdAtMs ? formatCompactDateTime(st.createdAtMs) : '—';
      const ctxTok = Number(
        st.contextTokens ||
          Number(st.inputTokens || 0) + Number(st.cacheReadTokens || 0) + Number(st.outputTokens || 0)
      );
      lines.push(
        `| #${st.stepIndex ?? '—'} | ${timeStr} | ${escapeMdCell(mInfo.text)} | ${formatSpeedMetric(st.tokPerSec, ' tok/s')} | ${formatMetric(st.ttftSec, 's')} | ${formatTokensPrecise(ctxTok)} | ${formatUsd(st.costUsd, { precise: true })} |`
      );
    }
  }

  if (agg.anomTotal > 0) {
    const anomKindTotals = new Map();
    for (const st of list) {
      if (!st?.anomaly?.kinds) continue;
      for (const [k, v] of Object.entries(st.anomaly.kinds)) {
        const n = Number(v || 0);
        if (n > 0) anomKindTotals.set(k, (anomKindTotals.get(k) || 0) + n);
      }
    }
    if (anomKindTotals.size > 0) {
      const summary = Array.from(anomKindTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${formatLocalizedAnomalyKind(k, en, explicitLocale)} ×${v}`)
        .join(en ? ', ' : '、');
      lines.push('', en ? `**Anomaly Summary**: ${summary}` : `**异常汇总**: ${summary}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * 将历史用量统计视图当前区间数据导出为结构化 CSV（向后兼容保留）。
 *
 * @param {object} consumption
 * @param {Array<object>} modelBreakdown
 * @param {{ displaySettings?: object, includeBom?: boolean }} [opts]
 * @returns {string}
 */
export function buildConsumptionCsv(
  consumption,
  modelBreakdown = [],
  { displaySettings = {}, includeBom = true, locale } = {}
) {
  const en = resolveExportEnglish(locale);
  const effectiveLocale = en ? 'en-US' : 'zh-CN';
  const cons = consumption || {};
  const acc = cons.account || {};
  const range = cons.selectedRange || {};
  const models = mergeModelsByDisplayName(modelBreakdown || [], displaySettings, {
    preferLabelInShort: true,
  });
  const workspaces = Array.isArray(cons.topWorkspaces) ? cons.topWorkspaces : [];
  const sessions = Array.isArray(cons.topConversations) ? cons.topConversations : [];
  const trend = Array.isArray(cons.trendSeries) ? cons.trendSeries : [];

  const rows = [
    csvRow([
      'section',
      'name',
      'calls',
      'input_tokens',
      'cache_read_tokens',
      'output_tokens',
      'total_tokens',
      'cache_hit_pct',
      'cost_usd',
      'extra',
    ]),
    csvRow([
      'summary',
      resolveLocalizedRangeLabel(range, en),
      Number(acc.calls || 0),
      Number(acc.inputTokens || 0),
      Number(acc.cacheReadTokens || 0),
      Number(acc.outputTokens || 0),
      Number(acc.totalTokens || 0),
      formatPctNumber(acc.cacheHitPct || 0),
      Number(acc.costUsd || 0).toFixed(4),
      `saved_usd=${Number(acc.savedCostUsd || 0).toFixed(4)}`,
    ]),
  ];

  for (const m of models) {
    rows.push(
      csvRow([
        'model',
        m.displayText || m.label || m.shortName || '—',
        Number(m.calls || 0),
        Number(m.inputTokens || 0),
        Number(m.cacheReadTokens || 0),
        Number(m.outputTokens || 0),
        Number(m.totalTokens || 0),
        formatPctNumber(m.cacheHitPct || 0),
        Number(m.costUsd || 0).toFixed(4),
        m.avgTokPerSec != null ? `avg_tps=${Number(m.avgTokPerSec).toFixed(1)}` : '',
      ])
    );
  }

  for (const w of workspaces) {
    rows.push(
      csvRow([
        'project',
        w.label || w.workspacePath || 'unbound',
        Number(w.calls || 0),
        Number(w.inputTokens || 0),
        Number(w.cacheReadTokens || 0),
        Number(w.responseTokens || 0) + Number(w.thinkingTokens || 0),
        Number(w.totalTokens || 0),
        formatPctNumber(w.cacheHitPct || 0),
        Number(w.costUsd || 0).toFixed(4),
        `sessions=${Number(w.sessionCount || 0)}`,
      ])
    );
  }

  for (const c of sessions) {
    rows.push(
      csvRow([
        'session',
        c.title || c.cascadeId || '—',
        Number(c.calls || 0),
        Number(c.inputTokens || 0),
        Number(c.cacheReadTokens || 0),
        Number(c.responseTokens || 0) + Number(c.thinkingTokens || 0),
        Number(c.totalTokens || 0),
        formatPctNumber(c.cacheHitPct || 0),
        Number(c.costUsd || 0).toFixed(4),
        c.sourceName || c.appSource || '',
      ])
    );
  }

  for (const slot of trend) {
    if (!slot || !(Number(slot.tokens || 0) > 0 || Number(slot.calls || 0) > 0)) continue;
    rows.push(
      csvRow([
        'trend',
        formatTrendSlotFullLabel(slot, { locale: effectiveLocale }) || slot.label || '',
        Number(slot.calls || 0),
        Number(slot.inputTokens || 0),
        Number(slot.cacheReadTokens || 0),
        Number(slot.outputTokens || 0),
        Number(slot.tokens || 0),
        '',
        Number(slot.costUsd || 0).toFixed(4),
        slot.granularity || '',
      ])
    );
  }

  return `${includeBom ? '\uFEFF' : ''}${rows.join('\r\n')}\r\n`;
}

/**
 * 将历史用量统计视图当前区间数据导出为多工作表、全自动列宽及双语本地化原生 Excel (`.xlsx`) 工作簿。
 * 自动拆分为「用量总览 / 模型排行 / 项目排行 / 会话排行 / 时间趋势 / 客户端来源」独立分页。
 *
 * @param {object} consumption
 * @param {Array<object>} modelBreakdown
 * @param {{ displaySettings?: object, locale?: string, nowMs?: number }} [opts]
 * @returns {Uint8Array}
 */
export function buildConsumptionXlsx(
  consumption,
  modelBreakdown = [],
  { displaySettings = {}, locale, nowMs = Date.now() } = {}
) {
  const en = resolveExportEnglish(locale);
  const cons = consumption || {};
  const acc = cons.account || {};
  const range = cons.selectedRange || {};
  const models = mergeModelsByDisplayName(modelBreakdown || [], displaySettings, {
    preferLabelInShort: true,
  });
  const workspaces = Array.isArray(cons.topWorkspaces) ? cons.topWorkspaces : [];
  const sessions = Array.isArray(cons.topConversations) ? cons.topConversations : [];
  const sources = Array.isArray(cons.sourcesBreakdown) ? cons.sourcesBreakdown : [];
  const trend = (Array.isArray(cons.trendSeries) ? cons.trendSeries : []).filter(
    (slot) => slot && (Number(slot.tokens || 0) > 0 || Number(slot.calls || 0) > 0)
  );

  const rangeLabel = resolveLocalizedRangeLabel(range, en);
  const spanNote = resolveRangeSpanNote(range);
  const accIn = Math.max(0, Number(acc.inputTokens || 0));
  const accCache = Math.max(0, Number(acc.cacheReadTokens || 0));
  const accOut = Math.max(0, Number(acc.outputTokens || 0));
  const accThink = Math.max(0, Number(acc.thinkingTokens || 0));
  const accReply =
    acc.responseTokens != null
      ? Math.max(0, Number(acc.responseTokens))
      : Math.max(0, accOut - accThink);
  const accTotal = Math.max(0, Number(acc.totalTokens ?? accIn + accCache + accOut));
  const accCalls = Math.max(0, Number(acc.calls || 0));
  const accCacheRatio = computeCacheHitRatio(accIn, accCache, acc.cacheHitPct);
  const accCost = Math.max(0, Number(acc.costUsd || 0));
  const accSaved = Math.max(0, Number(acc.savedCostUsd || 0));

  const overviewRows = [
    [en ? 'Time Range' : '统计周期', { value: rangeLabel, type: 'text_right' }, spanNote],
    [en ? 'Exported At' : '导出时间', { value: formatExportDateTime(nowMs, true), type: 'text_right' }, ''],
    [
      en ? 'Total Calls' : '调用次数',
      { value: accCalls, type: 'int' },
      en ? 'Completed model requests' : '有效模型请求步数',
    ],
    [
      en ? 'Total Tokens' : '总 Token',
      { value: accTotal, type: 'int' },
      en ? 'Fresh input + Cache read + Output' : '新输入 + 缓存读取 + 总输出',
    ],
    [
      en ? 'Fresh Input Tokens' : '新输入 Token',
      { value: accIn, type: 'int' },
      en ? 'Uncached prompt tokens' : '未命中缓存的新增提示词',
    ],
    [
      en ? 'Cache Read Tokens' : '缓存读取 Token',
      { value: accCache, type: 'int' },
      en ? 'Prompt cache hit tokens' : '命中 Prompt Cache 的复用输入',
    ],
    [
      en ? 'Total Output Tokens' : '总输出 Token',
      { value: accOut, type: 'int' },
      accThink > 0
        ? en
          ? `Thinking ${accThink.toLocaleString('en-US')} / Reply ${accReply.toLocaleString('en-US')}`
          : `思考 ${accThink.toLocaleString('en-US')} / 回复 ${accReply.toLocaleString('en-US')}`
        : en
          ? 'Generated completion tokens'
          : '模型生成输出总量',
    ],
  ];

  if (accThink > 0 || accReply > 0) {
    overviewRows.push(
      [
        en ? 'Thinking Tokens' : '思考 Token',
        { value: accThink, type: 'int' },
        en ? 'Reasoning output tokens' : '内部推理过程消耗',
      ],
      [
        en ? 'Reply Tokens' : '回复 Token',
        { value: accReply, type: 'int' },
        en ? 'Visible response tokens' : '正文可见回复消耗',
      ]
    );
  }

  overviewRows.push(
    [
      en ? 'Cache Hit Rate' : '缓存命中率',
      { value: accCacheRatio, type: 'pct' },
      en ? 'Cache read / (Fresh input + Cache read)' : '缓存读取 / (新输入 + 缓存读取)',
    ],
    [
      en ? 'Cache Saved (USD)' : '缓存节省 (USD)',
      { value: accSaved, type: 'usd2' },
      en ? 'Estimated savings from prompt caching' : '相比全量未缓存输入估算节省的费用',
    ],
    {
      tone: 'summary',
      values: [
        en ? 'Est. Cost (USD)' : '预估费用 (USD)',
        { value: accCost, type: 'usd2' },
        en ? 'Estimated from official model list pricing' : '按模型官方阶梯定价汇总估算',
      ],
    }
  );

  const sheets = [
    {
      name: en ? 'Overview' : '用量总览',
      autoFilter: false,
      columns: [
        { header: en ? 'Metric' : '指标项', type: 'text', minWidth: 20 },
        { header: en ? 'Value' : '数值', type: 'text_right', align: 'right', minWidth: 22 },
        { header: en ? 'Notes' : '说明', type: 'text', minWidth: 32, maxWidth: 56 },
      ],
      rows: overviewRows,
    },
  ];

  // Sheet 2: Models
  if (models.length > 0) {
    let mCalls = 0;
    let mIn = 0;
    let mCache = 0;
    let mOut = 0;
    let mTot = 0;
    let mCost = 0;
    const allSpeedHaveBins = models.every(
      (m) => !(Number(m?.avgTokPerSec) > 0) || Boolean(m?.speedSummary?.rateBins)
    );
    const mergedRates = allSpeedHaveBins
      ? mergeSpeedRateBins(models.map((m) => m.speedSummary))
      : null;
    let tpsTokSum = 0;
    let tpsSecSum = 0;
    const modelRows = models.map((m, idx) => {
      const calls = Math.max(0, Number(m.calls || 0));
      const inTok = Math.max(0, Number(m.inputTokens || 0));
      const cacheTok = Math.max(0, Number(m.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(m.outputTokens || 0));
      const totTok = Math.max(0, Number(m.totalTokens ?? inTok + cacheTok + outTok));
      const cost = Math.max(0, Number(m.costUsd || 0));
      const tps =
        m.avgTokPerSec != null && Number.isFinite(Number(m.avgTokPerSec)) && Number(m.avgTokPerSec) > 0
          ? Number(m.avgTokPerSec)
          : null;
      mCalls += calls;
      mIn += inTok;
      mCache += cacheTok;
      mOut += outTok;
      mTot += totTok;
      mCost += cost;
      const rawSpeedTok = Number(m.speedSummary?.tokens);
      const rawSpeedSec = Number(m.speedSummary?.seconds);
      if (
        Number.isFinite(rawSpeedTok) &&
        Number.isFinite(rawSpeedSec) &&
        rawSpeedSec > 0 &&
        rawSpeedTok >= 0
      ) {
        tpsTokSum += rawSpeedTok;
        tpsSecSum += rawSpeedSec;
      } else if (tps != null) {
        const fallbackTok = outTok > 0 ? outTok : Math.max(1, calls);
        tpsTokSum += fallbackTok;
        tpsSecSum += fallbackTok / tps;
      }
      return [
        idx + 1,
        m.displayText || m.label || m.shortName || '—',
        calls,
        inTok,
        cacheTok,
        outTok,
        totTok,
        computeCacheHitRatio(inTok, cacheTok, m.cacheHitPct),
        tps,
        cost,
      ];
    });
    const directAccountTps =
      acc.avgTokPerSec != null && Number.isFinite(Number(acc.avgTokPerSec)) && Number(acc.avgTokPerSec) > 0
        ? Number(acc.avgTokPerSec)
        : null;
    modelRows.push({
      tone: 'summary',
      values: [
        '',
        en ? 'Total' : '合计',
        mCalls,
        mIn,
        mCache,
        mOut,
        mTot,
        computeCacheHitRatio(mIn, mCache),
        roundExportSpeed(
          directAccountTps ??
            (mergedRates
              ? mergedRates.avgTokPerSec
              : tpsSecSum > 0
                ? tpsTokSum / tpsSecSum
                : null)
        ),
        mCost,
      ],
    });
    sheets.push({
      name: en ? 'Models' : '模型排行',
      columns: [
        { header: en ? 'Rank' : '排名', type: 'center', minWidth: 8 },
        { header: en ? 'Model' : '模型', type: 'text', minWidth: 20, maxWidth: 42 },
        { header: en ? 'Calls' : '调用次数', type: 'int', minWidth: 11 },
        { header: en ? 'Fresh Input' : '新输入', type: 'int', minWidth: 14 },
        { header: en ? 'Cache Read' : '缓存读取', type: 'int', minWidth: 15 },
        { header: en ? 'Output' : '输出', type: 'int', minWidth: 13 },
        { header: en ? 'Total Tokens' : '总 Token', type: 'int', minWidth: 15 },
        { header: en ? 'Cache Hit %' : '缓存命中率', type: 'pct', minWidth: 13 },
        { header: en ? 'Avg Speed (tok/s)' : '平均速率 (tok/s)', type: 'dec1', minWidth: 17 },
        { header: en ? 'Est. Cost (USD)' : '预估费用 (USD)', type: 'usd2', minWidth: 16 },
      ],
      rows: modelRows,
    });
  }

  // Sheet 3: Projects
  if (workspaces.length > 0) {
    let wSess = 0;
    let wCalls = 0;
    let wIn = 0;
    let wCache = 0;
    let wOut = 0;
    let wTot = 0;
    let wCost = 0;
    const wsRows = workspaces.map((w, idx) => {
      const sess = Math.max(0, Number(w.sessionCount || 0));
      const calls = Math.max(0, Number(w.calls || 0));
      const inTok = Math.max(0, Number(w.inputTokens || 0));
      const cacheTok = Math.max(0, Number(w.cacheReadTokens || 0));
      const outTok =
        w.outputTokens != null
          ? Math.max(0, Number(w.outputTokens))
          : Math.max(0, Number(w.responseTokens || 0)) + Math.max(0, Number(w.thinkingTokens || 0));
      const totTok = Math.max(0, Number(w.totalTokens ?? inTok + cacheTok + outTok));
      const cost = Math.max(0, Number(w.costUsd || 0));
      wSess += sess;
      wCalls += calls;
      wIn += inTok;
      wCache += cacheTok;
      wOut += outTok;
      wTot += totTok;
      wCost += cost;
      return [
        idx + 1,
        w.label || w.workspacePath || (en ? 'Unbound' : '未绑定工作区'),
        w.workspacePath || '',
        sess,
        calls,
        inTok,
        cacheTok,
        outTok,
        totTok,
        computeCacheHitRatio(inTok, cacheTok, w.cacheHitPct),
        cost,
      ];
    });
    wsRows.push({
      tone: 'summary',
      values: [
        '',
        en ? 'Total' : '合计',
        '',
        wSess,
        wCalls,
        wIn,
        wCache,
        wOut,
        wTot,
        computeCacheHitRatio(wIn, wCache),
        wCost,
      ],
    });
    sheets.push({
      name: en ? 'Projects' : '项目排行',
      columns: [
        { header: en ? 'Rank' : '排名', type: 'center', minWidth: 8 },
        { header: en ? 'Project' : '项目名称', type: 'text', minWidth: 18, maxWidth: 36 },
        { header: en ? 'Workspace Path' : '工作区路径', type: 'text', minWidth: 22, maxWidth: 52 },
        { header: en ? 'Sessions' : '会话数', type: 'int', minWidth: 10 },
        { header: en ? 'Calls' : '调用次数', type: 'int', minWidth: 11 },
        { header: en ? 'Fresh Input' : '新输入', type: 'int', minWidth: 14 },
        { header: en ? 'Cache Read' : '缓存读取', type: 'int', minWidth: 15 },
        { header: en ? 'Output' : '输出', type: 'int', minWidth: 13 },
        { header: en ? 'Total Tokens' : '总 Token', type: 'int', minWidth: 15 },
        { header: en ? 'Cache Hit %' : '缓存命中率', type: 'pct', minWidth: 13 },
        { header: en ? 'Est. Cost (USD)' : '预估费用 (USD)', type: 'usd2', minWidth: 16 },
      ],
      rows: wsRows,
    });
  }

  // Sheet 4: Sessions
  if (sessions.length > 0) {
    let sCalls = 0;
    let sIn = 0;
    let sCache = 0;
    let sOut = 0;
    let sTot = 0;
    let sCost = 0;
    const sessRows = sessions.map((c, idx) => {
      const calls = Math.max(0, Number(c.calls || 0));
      const inTok = Math.max(0, Number(c.inputTokens || 0));
      const cacheTok = Math.max(0, Number(c.cacheReadTokens || 0));
      const outTok =
        c.outputTokens != null
          ? Math.max(0, Number(c.outputTokens))
          : Math.max(0, Number(c.responseTokens || 0)) + Math.max(0, Number(c.thinkingTokens || 0));
      const totTok = Math.max(0, Number(c.totalTokens ?? inTok + cacheTok + outTok));
      const cost = Math.max(0, Number(c.costUsd || 0));
      sCalls += calls;
      sIn += inTok;
      sCache += cacheTok;
      sOut += outTok;
      sTot += totTok;
      sCost += cost;
      return [
        idx + 1,
        c.title || c.cascadeId || '—',
        c.sourceName || c.appSource || '',
        calls,
        inTok,
        cacheTok,
        outTok,
        totTok,
        computeCacheHitRatio(inTok, cacheTok, c.cacheHitPct),
        cost,
      ];
    });
    sessRows.push({
      tone: 'summary',
      values: [
        '',
        en ? 'Total' : '合计',
        '',
        sCalls,
        sIn,
        sCache,
        sOut,
        sTot,
        computeCacheHitRatio(sIn, sCache),
        sCost,
      ],
    });
    sheets.push({
      name: en ? 'Sessions' : '会话排行',
      columns: [
        { header: en ? 'Rank' : '排名', type: 'center', minWidth: 8 },
        { header: en ? 'Session Title' : '会话标题', type: 'text', minWidth: 24, maxWidth: 48 },
        { header: en ? 'Client Source' : '客户端来源', type: 'text', minWidth: 16 },
        { header: en ? 'Calls' : '调用次数', type: 'int', minWidth: 11 },
        { header: en ? 'Fresh Input' : '新输入', type: 'int', minWidth: 14 },
        { header: en ? 'Cache Read' : '缓存读取', type: 'int', minWidth: 15 },
        { header: en ? 'Output' : '输出', type: 'int', minWidth: 13 },
        { header: en ? 'Total Tokens' : '总 Token', type: 'int', minWidth: 15 },
        { header: en ? 'Cache Hit %' : '缓存命中率', type: 'pct', minWidth: 13 },
        { header: en ? 'Est. Cost (USD)' : '预估费用 (USD)', type: 'usd2', minWidth: 16 },
      ],
      rows: sessRows,
    });
  }

  // Sheet 5: Trend
  if (trend.length > 0) {
    let tCalls = 0;
    let tIn = 0;
    let tCache = 0;
    let tOut = 0;
    let tTot = 0;
    let tCost = 0;
    const trendRows = trend.map((slot) => {
      const isMinute = slot.granularity === 'minute';
      const isHourly =
        isMinute ||
        slot.granularity === 'hour' ||
        String(slot.label || '').includes(':');
      const calls = Math.max(0, Number(slot.calls || 0));
      const inTok = Math.max(0, Number(slot.inputTokens || 0));
      const cacheTok = Math.max(0, Number(slot.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(slot.outputTokens || 0));
      const totTok = Math.max(0, Number(slot.tokens ?? inTok + cacheTok + outTok));
      const cost = Math.max(0, Number(slot.costUsd || 0));
      tCalls += calls;
      tIn += inTok;
      tCache += cacheTok;
      tOut += outTok;
      tTot += totTok;
      tCost += cost;
      const stepMins = Math.max(1, Number(slot.stepMinutes) || 5);
      const granLabel = isMinute
        ? en
          ? `${stepMins}m`
          : `按 ${stepMins} 分钟`
        : isHourly
          ? en
            ? 'Hourly'
            : '按小时'
          : en
            ? 'Daily'
            : '按天';
      return [
        formatTrendWindowLabel(slot, isHourly),
        granLabel,
        calls,
        inTok,
        cacheTok,
        outTok,
        totTok,
        cost,
      ];
    });
    trendRows.push({
      tone: 'summary',
      values: [
        en ? 'Total' : '合计',
        '',
        tCalls,
        tIn,
        tCache,
        tOut,
        tTot,
        tCost,
      ],
    });
    sheets.push({
      name: en ? 'Trend' : '时间趋势',
      columns: [
        { header: en ? 'Time Window' : '时间段', type: 'text', minWidth: 19 },
        { header: en ? 'Granularity' : '粒度', type: 'center', minWidth: 11 },
        { header: en ? 'Calls' : '调用次数', type: 'int', minWidth: 11 },
        { header: en ? 'Fresh Input' : '新输入', type: 'int', minWidth: 14 },
        { header: en ? 'Cache Read' : '缓存读取', type: 'int', minWidth: 15 },
        { header: en ? 'Output' : '输出', type: 'int', minWidth: 13 },
        { header: en ? 'Total Tokens' : '总 Token', type: 'int', minWidth: 15 },
        { header: en ? 'Est. Cost (USD)' : '预估费用 (USD)', type: 'usd2', minWidth: 16 },
      ],
      rows: trendRows,
    });
  }

  // Sheet 6: Client Sources
  if (sources.length > 0) {
    let srcCalls = 0;
    let srcIn = 0;
    let srcCache = 0;
    let srcOut = 0;
    let srcTot = 0;
    let srcCost = 0;
    const srcRows = sources.map((s) => {
      const calls = Math.max(0, Number(s.calls || 0));
      const inTok = Math.max(0, Number(s.inputTokens || 0));
      const cacheTok = Math.max(0, Number(s.cacheReadTokens || 0));
      const outTok =
        s.outputTokens != null
          ? Math.max(0, Number(s.outputTokens))
          : Math.max(0, Number(s.responseTokens || 0)) + Math.max(0, Number(s.thinkingTokens || 0));
      const totTok = Math.max(0, Number(s.totalTokens ?? inTok + cacheTok + outTok));
      const cost = Math.max(0, Number(s.costUsd || 0));
      srcCalls += calls;
      srcIn += inTok;
      srcCache += cacheTok;
      srcOut += outTok;
      srcTot += totTok;
      srcCost += cost;
      return [
        s.name || '—',
        calls,
        inTok,
        cacheTok,
        outTok,
        totTok,
        computeCacheHitRatio(inTok, cacheTok, s.cacheHitPct),
        cost,
      ];
    });
    srcRows.push({
      tone: 'summary',
      values: [
        en ? 'Total' : '合计',
        srcCalls,
        srcIn,
        srcCache,
        srcOut,
        srcTot,
        computeCacheHitRatio(srcIn, srcCache),
        srcCost,
      ],
    });
    sheets.push({
      name: en ? 'Client Sources' : '客户端来源',
      columns: [
        { header: en ? 'Client Source' : '客户端来源', type: 'text', minWidth: 18 },
        { header: en ? 'Calls' : '调用次数', type: 'int', minWidth: 11 },
        { header: en ? 'Fresh Input' : '新输入', type: 'int', minWidth: 14 },
        { header: en ? 'Cache Read' : '缓存读取', type: 'int', minWidth: 15 },
        { header: en ? 'Output' : '输出', type: 'int', minWidth: 13 },
        { header: en ? 'Total Tokens' : '总 Token', type: 'int', minWidth: 15 },
        { header: en ? 'Cache Hit %' : '缓存命中率', type: 'pct', minWidth: 13 },
        { header: en ? 'Est. Cost (USD)' : '预估费用 (USD)', type: 'usd2', minWidth: 16 },
      ],
      rows: srcRows,
    });
  }

  return buildXlsxWorkbookBytes(sheets);
}

/**
 * 生成历史用量统计当前区间的双语 Markdown 汇总报告。
 *
 * @param {object} consumption
 * @param {Array<object>} modelBreakdown
 * @param {{ displaySettings?: object, locale?: string }} [opts]
 * @returns {string}
 */
export function buildConsumptionMarkdownReport(
  consumption,
  modelBreakdown = [],
  { displaySettings = {}, locale } = {}
) {
  const en = resolveExportEnglish(locale);
  const cons = consumption || {};
  const acc = cons.account || {};
  const range = cons.selectedRange || {};
  const models = mergeModelsByDisplayName(modelBreakdown || [], displaySettings, {
    preferLabelInShort: true,
  });
  const workspaces = Array.isArray(cons.topWorkspaces) ? cons.topWorkspaces : [];
  const sessions = Array.isArray(cons.topConversations) ? cons.topConversations : [];

  const rangeLabel = resolveLocalizedRangeLabel(range, en);
  const lines = en
    ? [
        `# Usage Report · ${rangeLabel}`,
        '',
        `- **Total Tokens**: ${formatTokensPrecise(acc.totalTokens || 0)} (${Number(acc.calls || 0)} calls)`,
        `- **Est. Cost**: ${formatUsd(acc.costUsd || 0)} (Cache Saved ${formatUsd(acc.savedCostUsd || 0)})`,
        `- **Cache Hit Rate**: ${formatPctNumber(acc.cacheHitPct || 0, { withSymbol: true })} (Input ${formatTokensPrecise(acc.inputTokens || 0)} / Cache ${formatTokensPrecise(acc.cacheReadTokens || 0)} / Output ${formatTokensPrecise(acc.outputTokens || 0)})`,
      ]
    : [
        `# 用量统计报告 · ${rangeLabel}`,
        '',
        `- **总 Token**: ${formatTokensPrecise(acc.totalTokens || 0)}（共 ${Number(acc.calls || 0)} 次调用）`,
        `- **预估费用**: ${formatUsd(acc.costUsd || 0)}（缓存节省 ${formatUsd(acc.savedCostUsd || 0)}）`,
        `- **缓存命中率**: ${formatPctNumber(acc.cacheHitPct || 0, { withSymbol: true })}（新输入 ${formatTokensPrecise(acc.inputTokens || 0)} / 缓存读取 ${formatTokensPrecise(acc.cacheReadTokens || 0)} / 输出 ${formatTokensPrecise(acc.outputTokens || 0)}）`,
      ];

  if (models.length > 0) {
    lines.push(
      '',
      en ? '## Models' : '## 模型排行',
      '',
      en
        ? '| Model | Calls | Tokens | Cache Hit | Avg Speed | Est. Cost |'
        : '| 模型 | 调用次数 | 总 Token | 缓存命中率 | 平均速率 | 预估费用 |',
      '| --- | ---: | ---: | ---: | ---: | ---: |'
    );
    for (const m of models) {
      lines.push(
        `| ${escapeMdCell(m.displayText || m.label || m.shortName)} | ${Number(m.calls || 0)} | ${formatTokensPrecise(m.totalTokens || 0)} | ${formatPctNumber(m.cacheHitPct || 0, { withSymbol: true })} | ${m.avgTokPerSec != null ? formatSpeedMetric(m.avgTokPerSec, ' tok/s') : '—'} | ${formatUsd(m.costUsd || 0)} |`
      );
    }
  }

  if (workspaces.length > 0) {
    lines.push(
      '',
      en ? '## Projects' : '## 项目排行',
      '',
      en
        ? '| Project | Sessions | Calls | Tokens | Cache Hit | Est. Cost |'
        : '| 项目 | 会话数 | 调用次数 | 总 Token | 缓存命中率 | 预估费用 |',
      '| --- | ---: | ---: | ---: | ---: | ---: |'
    );
    for (const w of workspaces) {
      lines.push(
        `| ${escapeMdCell(w.label || w.workspacePath || (en ? 'Unbound' : '未绑定工作区'))} | ${Number(w.sessionCount || 0)} | ${Number(w.calls || 0)} | ${formatTokensPrecise(w.totalTokens || 0)} | ${formatPctNumber(w.cacheHitPct || 0, { withSymbol: true })} | ${formatUsd(w.costUsd || 0)} |`
      );
    }
  }

  if (sessions.length > 0) {
    lines.push(
      '',
      en ? '## Top Sessions' : '## 热门会话',
      '',
      en
        ? '| Session | Calls | Tokens | Cache Hit | Est. Cost |'
        : '| 会话 | 调用次数 | 总 Token | 缓存命中率 | 预估费用 |',
      '| --- | ---: | ---: | ---: | ---: |'
    );
    for (const c of sessions.slice(0, 8)) {
      lines.push(
        `| ${escapeMdCell(c.title || c.cascadeId)} | ${Number(c.calls || 0)} | ${formatTokensPrecise(c.totalTokens || 0)} | ${formatPctNumber(c.cacheHitPct || 0, { withSymbol: true })} | ${formatUsd(c.costUsd || 0)} |`
      );
    }
  }

  return `${lines.join('\n')}\n`;
}
