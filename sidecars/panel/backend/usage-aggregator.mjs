/**
 * @fileoverview 多时间窗口解析、用量桶累加、趋势序列、月度序列与分模型/分来源聚合引擎。
 *
 * 负责将内存缓存 (`trajectoryCache`) 与外部深层统计缓存 (`loadExternalDeepStatsCache`)
 * 中的所有步骤按预设窗口（`all`, `5h`, `today`, `24h`, `week`, `7d`, `14d`, `30d`）与当前选定窗口
 * 进行去重遍历聚合，输出前端消费分析与模型明细所需的完整统计结构。
 */

import { isDeepStrictEqual } from 'node:util';
import { decodeWorkspaceFileUriToPath } from '../shared/workspace-uri.mjs';
import {
  MEASUREMENT_VERSION,
  accumulateSpeed,
  createSpeedAccumulator,
  finishSpeed,
} from '../trajectory-metrics.mjs';
import { roundMetric } from './config.mjs';
import { getEndpointCacheStore } from './endpoint-registry.mjs';
import { loadExternalDeepStatsCache } from './local-scanner.mjs';
import {
  computeStepCost,
  formatUpstreamModelId,
} from './model-pricing.mjs';

/** @typedef {ReturnType<import('./model-pricing.mjs').createStepModelResolver>} StepModelResolver */

function safeTok(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 获取本地当日 00:00:00.000 的毫秒时间戳。
 *
 * @param {Date|number} [now=new Date()]
 * @returns {number}
 */
function getStartOfLocalDayMs(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getStartOfLocalOffsetDaysMs(nowMs, offsetDays) {
  const d = new Date(nowMs);
  d.setDate(d.getDate() - offsetDays);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 获取本地本周一 00:00:00.000 的毫秒时间戳。
 *
 * @param {Date|number} [now=new Date()]
 * @returns {number}
 */
function getStartOfCurrentWeekMs(now = new Date()) {
  const d = new Date(now);
  const day = d.getDay(); // 0 = Sun, 1 = Mon
  const diffToMon = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMon);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 根据时间范围键名 (`rangeKey`) 解析起止毫秒时间戳。
 *
 * @param {string} [rangeKey='all']
 * @param {number} [customStartMs=0]
 * @param {number} [customEndMs=0]
 * @param {number} [nowMs=Date.now()]
 * @returns {{ key: string, label: string, startMs: number, endMs: number }}
 */
function resolveTimeWindow(
  rangeKey = 'all',
  customStartMs = 0,
  customEndMs = 0,
  nowMs = Date.now()
) {
  const now = new Date(nowMs);
  switch (rangeKey) {
    case '5h':
      return {
        key: '5h',
        label: '近 5 小时',
        startMs: nowMs - 5 * 3600 * 1000,
        endMs: nowMs,
      };
    case 'today':
      return { key: 'today', label: '今日', startMs: getStartOfLocalDayMs(now), endMs: nowMs };
    case '24h':
      return { key: '24h', label: '近 24 小时', startMs: nowMs - 24 * 3600 * 1000, endMs: nowMs };
    case 'cycle':
    case 'week':
      return {
        key: 'week',
        label: '本周',
        startMs: getStartOfCurrentWeekMs(now),
        endMs: nowMs,
      };
    case '7d':
      return {
        key: '7d',
        label: '近 7 天',
        startMs: getStartOfLocalOffsetDaysMs(nowMs, 7),
        endMs: nowMs,
      };
    case '14d':
      return {
        key: '14d',
        label: '近 14 天',
        startMs: getStartOfLocalOffsetDaysMs(nowMs, 14),
        endMs: nowMs,
      };
    case '30d':
      return {
        key: '30d',
        label: '近 30 天',
        startMs: getStartOfLocalOffsetDaysMs(nowMs, 30),
        endMs: nowMs,
      };
    case 'custom': {
      const s = Number(customStartMs) > 0 ? Number(customStartMs) : 0;
      const e = Number(customEndMs) > 0 ? Number(customEndMs) : nowMs;
      return {
        key: 'custom',
        label: '自定义时段',
        startMs: Math.min(s, e),
        endMs: Math.max(s, e),
      };
    }
    case 'all':
    default:
      return { key: 'all', label: '全部时间', startMs: 0, endMs: Infinity };
  }
}

const LOCAL_TIMEZONE_TTL_MS = 30_000;
let cachedLocalTimeZone = '';
let cachedLocalTimeZoneAtMs = 0;

function resolveCachedLocalTimeZone() {
  const nowMs = Date.now();
  if (cachedLocalTimeZone && nowMs - cachedLocalTimeZoneAtMs < LOCAL_TIMEZONE_TTL_MS) {
    return cachedLocalTimeZone;
  }
  cachedLocalTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  cachedLocalTimeZoneAtMs = nowMs;
  return cachedLocalTimeZone;
}

/**
 * 创建一个空的用量统计累加桶。
 */
function createUsageBucket() {
  return {
    calls: 0,
    conversationsSet: new Set(),
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    savedCostUsd: 0,
    speedAccumulator: createSpeedAccumulator(),
  };
}

/**
 * 将单个模型步骤的 Token 与成本累加至目标统计桶。
 *
 * @param {ReturnType<typeof createUsageBucket>} bucket
 * @param {object} usage 已归一化的单步用量
 * @param {string} cascadeId 会话标识
 * @param {object|null} [step=null] 原始步骤对象（用于累计总平均输出速度）
 */
function accumulateStepIntoBucket(bucket, usage, cascadeId, step = null) {
  const { inTok, cacheTok, outTok, thinkTok, respTok, stepTotalTokens,
    resolvedCost, savedCost, unpriced } = usage;
  if (unpriced) bucket.unpricedCalls = (bucket.unpricedCalls || 0) + 1;
  bucket.calls += 1;
  if (cascadeId) bucket.conversationsSet.add(cascadeId);
  bucket.inputTokens += inTok;
  bucket.cacheReadTokens += cacheTok;
  bucket.outputTokens += outTok;
  bucket.thinkingTokens += thinkTok;
  bucket.responseTokens += respTok;
  bucket.totalTokens += stepTotalTokens;
  bucket.costUsd += resolvedCost;
  bucket.savedCostUsd += savedCost;
  if (step && typeof step === 'object') {
    accumulateSpeed(bucket.speedAccumulator, step);
  }
}

/**
 * 将累加完成的用量桶定型为可序列化的前端统计结构（计算缓存命中率并舍入金额）。
 *
 * @param {ReturnType<typeof createUsageBucket>} bucket
 */
function finalizeUsageBucket(bucket) {
  const promptTokens = bucket.inputTokens + bucket.cacheReadTokens;
  const cacheHitPct =
    promptTokens > 0 ? +((bucket.cacheReadTokens / promptTokens) * 100).toFixed(1) : 0;
  const finishedSpeed = finishSpeed(bucket.speedAccumulator);
  return {
    calls: bucket.calls,
    conversationsCount: bucket.conversationsSet.size,
    inputTokens: bucket.inputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    outputTokens: bucket.outputTokens,
    thinkingTokens: bucket.thinkingTokens,
    responseTokens: bucket.responseTokens,
    totalTokens: bucket.totalTokens,
    costUsd: +bucket.costUsd.toFixed(2),
    unpricedCalls: bucket.unpricedCalls || 0,
    savedCostUsd: +bucket.savedCostUsd.toFixed(2),
    cacheHitPct,
    avgTokPerSec: roundMetric(finishedSpeed.avgTokPerSec),
  };
}

/**
 * 将单步统计数据累加至按模型分组的映射表中（供单代理、主+子汇总与全局时间范围共用）。
 *
 * @param {Map<string, object>} perModelStats
 * @param {object} st
 * @param {object} mInfo
 * @param {number|null} stepCost
 */
function accumulateStepIntoModelMap(perModelStats, st, mInfo, stepCost) {
  const inTok = safeTok(st?.inputTokens);
  const cacheTok = safeTok(st?.cacheReadTokens);
  const outTok = safeTok(st?.outputTokens);
  const thinkTok = safeTok(st?.thinkingTokens);
  const respTok =
    st?.responseTokens !== undefined && st?.responseTokens !== null
      ? safeTok(st.responseTokens)
      : Math.max(0, outTok - thinkTok);
  const stepTotalTokens = inTok + cacheTok + outTok;
  const unpriced = stepCost === null ? 1 : 0;
  const modelGroupKey = mInfo.baseLabel || mInfo.label;

  if (!perModelStats.has(modelGroupKey)) {
    perModelStats.set(modelGroupKey, {
      label: modelGroupKey,
      shortName: mInfo.shortName,
      fallbackModelId:
        mInfo.modelId && mInfo.modelId !== 'unknown'
          ? formatUpstreamModelId(mInfo.modelId, mInfo)
          : '',
      upstreamModelCounts: new Map(),
      family: mInfo.family,
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      responseTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      ttftSumSec: 0,
      ttftSampleCount: 0,
      speedAccumulator: createSpeedAccumulator(),
      anomalySteps: 0,
      anomalyCount: 0,
      anomalyDangerCount: 0,
      anomalyTotalDelaySec: 0,
      anomalyByKind: {},
    });
  }
  const agg = perModelStats.get(modelGroupKey);
  if (st.responseModel) {
    const formattedResp = formatUpstreamModelId(st.responseModel, mInfo);
    agg.upstreamModelCounts.set(
      formattedResp,
      (agg.upstreamModelCounts.get(formattedResp) || 0) + 1
    );
  }
  accumulateSpeed(agg.speedAccumulator, st);
  if (
    !st.isCompactionStep &&
    !st.isImageGenStep &&
    st.measurementVersion === MEASUREMENT_VERSION &&
    st.isComplete &&
    Number.isFinite(st.totalDurationSec) &&
    Number.isFinite(st.nativeTtftSec) &&
    st.nativeTtftSec >= 0 &&
    st.nativeTtftSec <= st.totalDurationSec + 0.01
  ) {
    agg.ttftSumSec += st.nativeTtftSec;
    agg.ttftSampleCount += 1;
  }

  if (st?.anomaly && Number(st.anomaly.count) > 0) {
    agg.anomalySteps += 1;
    agg.anomalyCount += Number(st.anomaly.count);
    if (st.anomaly.severity === 'danger') {
      agg.anomalyDangerCount += 1;
    }
    if (Number(st.anomaly.totalDelaySec) > 0) {
      agg.anomalyTotalDelaySec += Number(st.anomaly.totalDelaySec);
    }
    if (st.anomaly.kinds && typeof st.anomaly.kinds === 'object') {
      for (const [k, v] of Object.entries(st.anomaly.kinds)) {
        const cnt = Number(v || 0);
        if (cnt > 0) {
          agg.anomalyByKind[k] = (agg.anomalyByKind[k] || 0) + cnt;
        }
      }
    } else if (st.anomaly.primaryKind) {
      agg.anomalyByKind[st.anomaly.primaryKind] =
        (agg.anomalyByKind[st.anomaly.primaryKind] || 0) + Number(st.anomaly.count);
    }
  }

  agg.calls += 1;
  agg.inputTokens += inTok;
  agg.cacheReadTokens += cacheTok;
  agg.outputTokens += outTok;
  agg.thinkingTokens += thinkTok;
  agg.responseTokens += respTok;
  agg.totalTokens += stepTotalTokens;
  agg.costUsd += Number.isFinite(stepCost) ? stepCost : 0;
  agg.unpricedCalls = (agg.unpricedCalls || 0) + unpriced;
}

/**
 * 将按模型分组的统计映射表定型并排序为前端可渲染数组。
 *
 * @param {Map<string, object>} perModelStats
 * @returns {object[]}
 */
function finalizeModelBreakdownMap(perModelStats) {
  return Array.from(perModelStats.values())
    .sort((a, b) => b.calls - a.calls || String(a.label).localeCompare(String(b.label)))
    .map(
      ({
        speedAccumulator,
        upstreamModelCounts,
        fallbackModelId,
        ttftSumSec,
        ttftSampleCount,
        anomalySteps,
        anomalyCount,
        anomalyDangerCount,
        anomalyTotalDelaySec,
        anomalyByKind,
        ...m
      }) => {
        const sortedUpstream = Array.from((upstreamModelCounts || new Map()).entries())
          .sort((a, b) => b[1] - a[1])
          .map(([name]) => name);
        const primaryUpstream =
          sortedUpstream.length > 0 ? sortedUpstream[0] : fallbackModelId || m.shortName || m.label;
        const finishedSpeed = finishSpeed(speedAccumulator);
        const promptTokens = m.inputTokens + m.cacheReadTokens;
        const cacheHitPct =
          promptTokens > 0 ? +((m.cacheReadTokens / promptTokens) * 100).toFixed(1) : 0;
        const avgTtftSec =
          ttftSampleCount > 0 ? roundMetric(ttftSumSec / ttftSampleCount) : null;
        const hasAnomalies = Number(anomalyCount || 0) > 0;
        return {
          ...m,
          upstreamName: primaryUpstream,
          upstreamModels: sortedUpstream,
          costUsd: +m.costUsd.toFixed(6),
          cacheHitPct,
          avgTtftSec,
          ttftSampleCount,
          avgTokPerSec: roundMetric(finishedSpeed.avgTokPerSec),
          speedSummary: finishedSpeed,
          ...(hasAnomalies
            ? {
                anomalySteps: Number(anomalySteps || 0),
                anomalyCount: Number(anomalyCount || 0),
                anomalyDangerCount: Number(anomalyDangerCount || 0),
                anomalyTotalDelaySec: +(Number(anomalyTotalDelaySec || 0)).toFixed(1),
                anomalyByKind: anomalyByKind || {},
              }
            : {}),
        };
      }
    );
}

/**
 * 针对给定步骤数组构建按模型聚合的统计列表（供单代理、主+子汇总及全局时间范围复用）。
 *
 * @param {object[]} [steps=[]]
 * @param {StepModelResolver} resolveStepModel
 * @returns {object[]}
 */
export function buildScopedModelBreakdown(steps, resolveStepModel) {
  const perModelStats = new Map();
  for (const st of steps) {
    if (!st || typeof st !== 'object') continue;
    const mInfo = resolveStepModel(st);
    const stepCost = computeStepCost(st, mInfo.pricing);
    accumulateStepIntoModelMap(perModelStats, st, mInfo, stepCost);
  }
  return finalizeModelBreakdownMap(perModelStats);
}

const MAX_USAGE_SNAPSHOT_ENDPOINTS = 8;
const lastUsageSnapshotsByEndpoint = new Map();
let usageSnapshotRevisionSeq = 0;
const stepsTimeBoundsCache = new WeakMap();
const MAX_TREND_TIMESTAMP_MS = 8_640_000_000_000_000;
export const CONSUMPTION_PRESET_RANGE_KEYS = ['today', '24h', '7d', '14d', '30d', 'all'];
const USAGE_SOURCE_LABELS = {
  standalone: 'Antigravity App',
  ide: 'Antigravity IDE',
  cli: 'Antigravity CLI',
  ssh: 'Antigravity SSH',
};

export function clearUsageAggregatorMemo(endpointId = null) {
  if (endpointId) {
    lastUsageSnapshotsByEndpoint.delete(String(endpointId));
  } else {
    lastUsageSnapshotsByEndpoint.clear();
  }
  usageSnapshotRevisionSeq += 1;
}

function getStepsTimeBounds(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { minMs: Infinity, maxMs: 0 };
  }
  const cached = stepsTimeBoundsCache.get(steps);
  if (cached) return cached;
  let minMs = Infinity;
  let maxMs = 0;
  for (let i = 0; i < steps.length; i++) {
    const tMs = Number(steps[i]?.createdAtMs);
    if (tMs > 0) {
      if (tMs < minMs) minMs = tMs;
      if (tMs > maxMs) maxMs = tMs;
    }
  }
  const bounds = { minMs, maxMs };
  stepsTimeBoundsCache.set(steps, bounds);
  return bounds;
}

function collectUsageEntriesToAggregate(familySet, endpoint = null) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const cacheStore = getEndpointCacheStore(endpoint);
  const externalConvos = isRemote ? new Map() : loadExternalDeepStatsCache();

  // 构建大小写归一化的内存缓存与跨端深层缓存索引，彻底杜绝 `${appSource}:${cascadeId}` 键不匹配导致的双倍重复计费
  const allLiveByLower = new Map();
  for (const [rawId, entry] of cacheStore.listCachedTrajectoryEntries()) {
    const cidLower = String(rawId || '').toLowerCase();
    if (!cidLower || !entry || typeof entry !== 'object') continue;
    const prev = allLiveByLower.get(cidLower);
    if (!prev || (entry.steps?.length || 0) > (prev.steps?.length || 0)) {
      allLiveByLower.set(cidLower, entry);
    }
  }

  const externalByCid = new Map();
  for (const ext of externalConvos.values()) {
    const extCidLower = String(ext?.cascadeId || '').toLowerCase();
    if (!extCidLower) continue;
    const prevExt = externalByCid.get(extCidLower);
    if (!prevExt || (ext.steps?.length || 0) > (prevExt.steps?.length || 0)) {
      externalByCid.set(extCidLower, ext);
    }
  }

  const allEntriesToAggregate = [];

  for (const [cidLower, entry] of allLiveByLower.entries()) {
    const extMatch = externalByCid.get(cidLower);
    if (extMatch && (extMatch.steps?.length || 0) > (entry?.steps?.length || 0)) {
      continue;
    }
    const groupCascadeId = String(
      entry?.rootConversationId || entry?.parentConversationId || cidLower
    ).toLowerCase();
    const rootLive = allLiveByLower.get(groupCascadeId);
    const entryTitle = String(
      rootLive?.title || entry?.title || extMatch?.title || ''
    ).trim();
    const entryWorkspaceUri = String(
      rootLive?.workspaceUri || entry?.workspaceUri || extMatch?.workspaceUri || ''
    ).trim();
    allEntriesToAggregate.push({
      cascadeId: groupCascadeId,
      title: entryTitle,
      appSource: isRemote ? 'ssh' : entry?.appSource || 'standalone',
      accountName: entry?.accountName || extMatch?.accountName || '',
      workspaceUri: entryWorkspaceUri,
      steps: entry?.steps || [],
      isCurrentConv: familySet.has(cidLower),
    });
  }

  for (const [extCidLower, ext] of externalByCid.entries()) {
    const liveEntry = allLiveByLower.get(extCidLower);
    if (liveEntry && (liveEntry.steps?.length || 0) >= (ext.steps?.length || 0)) {
      continue;
    }
    allEntriesToAggregate.push({
      cascadeId: extCidLower,
      title: String(ext.title || liveEntry?.title || '').trim(),
      appSource: ext.appSource || 'ide',
      accountName: ext.accountName || liveEntry?.accountName || '',
      workspaceUri: String(ext.workspaceUri || liveEntry?.workspaceUri || '').trim(),
      steps: ext.steps || [],
      isCurrentConv: familySet.has(extCidLower),
    });
  }

  return allEntriesToAggregate;
}

const MAX_TOP_CONVERSATIONS_LIMIT = 10;
const MAX_TOP_WORKSPACES_LIMIT = 12;
const UNBOUND_WORKSPACE_KEY = '__unbound__';

/**
 * 将 `file://` URI 或本地文件系统路径归一化为稳定的工作区聚合键、项目短名及可读路径。
 *
 * @param {string} rawUri
 * @returns {{ workspaceKey: string, label: string, workspacePath: string }|null}
 */
export function normalizeWorkspaceBucket(rawUri) {
  const decoded = decodeWorkspaceFileUriToPath(rawUri);
  if (!decoded) return null;
  const parts = decoded.split('/').filter(Boolean);
  const label = parts.length > 0 ? parts[parts.length - 1] : decoded;
  return {
    workspaceKey: decoded.toLowerCase(),
    label,
    workspacePath: decoded,
  };
}

function accumulateStepIntoWorkspaceMap(
  perWorkspaceMap,
  entry,
  stepUsage,
  tMs,
  st = null,
  mInfo = null,
  stepCost = null
) {
  const norm = normalizeWorkspaceBucket(entry?.workspaceUri);
  const key = norm ? norm.workspaceKey : UNBOUND_WORKSPACE_KEY;
  let acc = perWorkspaceMap.get(key);
  if (!acc) {
    acc = {
      workspaceKey: key,
      label: norm ? norm.label : '',
      workspacePath: norm ? norm.workspacePath : '',
      isUnbound: !norm,
      sessionIds: new Set(),
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      responseTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unpricedCalls: 0,
      lastTimestampMs: 0,
      latestCascadeId: '',
      perModelStats: new Map(),
    };
    perWorkspaceMap.set(key, acc);
  }
  const cid = String(entry?.cascadeId || '').trim();
  if (cid) acc.sessionIds.add(cid);
  acc.calls += 1;
  acc.inputTokens += stepUsage.inTok;
  acc.cacheReadTokens += stepUsage.cacheTok;
  acc.responseTokens += stepUsage.respTok;
  acc.thinkingTokens += stepUsage.thinkTok;
  acc.totalTokens += stepUsage.stepTotalTokens;
  acc.costUsd += stepUsage.resolvedCost;
  acc.unpricedCalls += stepUsage.unpriced;
  if (tMs >= acc.lastTimestampMs) {
    acc.lastTimestampMs = tMs;
    if (cid) acc.latestCascadeId = cid;
  }
  if (st && mInfo) {
    accumulateStepIntoModelMap(acc.perModelStats, st, mInfo, stepCost);
  }
}

function finalizeTopWorkspacesMap(perWorkspaceMap, maxItems = MAX_TOP_WORKSPACES_LIMIT) {
  let hasRealWorkspace = false;
  for (const w of perWorkspaceMap.values()) {
    if (!w.isUnbound && (w.totalTokens > 0 || w.calls > 0)) {
      hasRealWorkspace = true;
      break;
    }
  }
  if (!hasRealWorkspace) return [];
  return Array.from(perWorkspaceMap.values())
    .filter((w) => w.totalTokens > 0 || w.calls > 0)
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens || b.calls - a.calls)
    .slice(0, maxItems)
    .map((w) => {
      const promptTokens = w.inputTokens + w.cacheReadTokens;
      return {
        workspaceKey: w.workspaceKey,
        label: w.label,
        workspacePath: w.workspacePath,
        isUnbound: w.isUnbound,
        sessionCount: w.sessionIds.size,
        calls: w.calls,
        inputTokens: w.inputTokens,
        cacheReadTokens: w.cacheReadTokens,
        responseTokens: w.responseTokens,
        thinkingTokens: w.thinkingTokens,
        totalTokens: w.totalTokens,
        costUsd: +w.costUsd.toFixed(6),
        unpricedCalls: w.unpricedCalls,
        cacheHitPct: promptTokens > 0 ? +((w.cacheReadTokens / promptTokens) * 100).toFixed(1) : 0,
        lastTimestampMs: w.lastTimestampMs,
        latestCascadeId: w.latestCascadeId,
        models: finalizeModelBreakdownMap(w.perModelStats),
      };
    });
}

function accumulateStepIntoConversationMap(
  perConvMap,
  entry,
  srcKey,
  srcName,
  stepUsage,
  tMs,
  st = null,
  mInfo = null,
  stepCost = null
) {
  const cid = String(entry?.cascadeId || '').trim();
  if (!cid) return;
  let acc = perConvMap.get(cid);
  if (!acc) {
    acc = {
      cascadeId: cid,
      title: String(entry?.title || '').trim(),
      appSource: srcKey,
      sourceName: srcName,
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      responseTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unpricedCalls: 0,
      lastTimestampMs: 0,
      perModelStats: new Map(),
    };
    perConvMap.set(cid, acc);
  }
  if (!acc.title && entry?.title) {
    acc.title = String(entry.title).trim();
  }
  acc.calls += 1;
  acc.inputTokens += stepUsage.inTok;
  acc.cacheReadTokens += stepUsage.cacheTok;
  acc.responseTokens += stepUsage.respTok;
  acc.thinkingTokens += stepUsage.thinkTok;
  acc.totalTokens += stepUsage.stepTotalTokens;
  acc.costUsd += stepUsage.resolvedCost;
  acc.unpricedCalls += stepUsage.unpriced;
  if (tMs > acc.lastTimestampMs) {
    acc.lastTimestampMs = tMs;
  }
  if (st && mInfo) {
    accumulateStepIntoModelMap(acc.perModelStats, st, mInfo, stepCost);
  }
}

function finalizeTopConversationsMap(perConvMap, maxItems = MAX_TOP_CONVERSATIONS_LIMIT) {
  return Array.from(perConvMap.values())
    .filter((c) => c.totalTokens > 0 || c.calls > 0)
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens || b.calls - a.calls)
    .slice(0, maxItems)
    .map((c) => {
      const promptTokens = c.inputTokens + c.cacheReadTokens;
      return {
        cascadeId: c.cascadeId,
        title: c.title,
        appSource: c.appSource,
        sourceName: c.sourceName,
        calls: c.calls,
        inputTokens: c.inputTokens,
        cacheReadTokens: c.cacheReadTokens,
        responseTokens: c.responseTokens,
        thinkingTokens: c.thinkingTokens,
        totalTokens: c.totalTokens,
        costUsd: +c.costUsd.toFixed(6),
        unpricedCalls: c.unpricedCalls,
        cacheHitPct: promptTokens > 0 ? +((c.cacheReadTokens / promptTokens) * 100).toFixed(1) : 0,
        lastTimestampMs: c.lastTimestampMs,
        models: finalizeModelBreakdownMap(c.perModelStats),
      };
    });
}

function buildUsageTrendSeries(
  selectedWindow,
  effectiveSelectedWindow,
  selectedWindowSteps,
  nowMs,
  earliestSelectedStepMs,
  latestSelectedStepMs
) {
  const trend = planUsageTrend(
    effectiveSelectedWindow,
    nowMs,
    earliestSelectedStepMs,
    latestSelectedStepMs
  );
  const { start: trendStartMs, end: trendEndMs, hourly: useHourly, stepMs: plannedStepMs } = trend;
  const pad2 = (n) => String(n).padStart(2, '0');
  const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const trendSeries = [];
  if (useHourly) {
    const firstSlotMs = trend.first;
    const lastSlotMs = trend.last;
    const slotMs = Math.max(60 * 1000, Number(plannedStepMs) || 3600 * 1000);
    const stepMinutes = Math.max(1, Math.round(slotMs / (60 * 1000)));
    const isSubHour = stepMinutes < 60;
    const slotCount = Math.max(1, Math.floor((lastSlotMs - firstSlotMs) / slotMs) + 1);

    const firstD = new Date(firstSlotMs);
    const lastD = new Date(firstSlotMs + (slotCount - 1) * slotMs);
    const isSameDay =
      firstD.getFullYear() === lastD.getFullYear() &&
      firstD.getMonth() === lastD.getMonth() &&
      firstD.getDate() === lastD.getDate();

    for (let idx = 0; idx < slotCount; idx++) {
      const sMs = firstSlotMs + idx * slotMs;
      const eMs = sMs + slotMs;
      const sd = new Date(sMs);
      const ed = new Date(eMs);
      if (Number.isNaN(sd.getTime())) continue;
      const hh = `${pad2(sd.getHours())}:${pad2(sd.getMinutes())}`;
      const endHh = `${pad2(ed.getHours())}:${pad2(ed.getMinutes())}`;
      const dateStr = `${sd.getMonth() + 1}/${pad2(sd.getDate())}`;
      const axisLabel = isSameDay ? hh : `${dateStr} ${hh}`;
      const fullLabel = `${sd.getMonth() + 1}月${sd.getDate()}日 ${hh} - ${endHh}`;
      trendSeries.push({
        index: idx,
        startMs: sMs,
        endMs: eMs,
        granularity: isSubHour ? 'minute' : 'hour',
        ...(isSubHour ? { stepMinutes } : {}),
        label: axisLabel,
        fullLabel,
        tokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        responseTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
        calls: 0,
      });
    }
  } else {
    const firstDayMs = trend.first;
    const lastDayMs = trend.last;
    const dayStarts = [];
    const cursor = new Date(firstDayMs);
    cursor.setHours(0, 0, 0, 0);
    let safety = 0;
    while (cursor.getTime() <= lastDayMs && safety < 3660) {
      dayStarts.push(cursor.getTime());
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      safety++;
    }
    if (dayStarts.length === 0) {
      const fallbackDay = new Date(firstDayMs);
      fallbackDay.setHours(0, 0, 0, 0);
      dayStarts.push(fallbackDay.getTime());
    }

    const firstYear = new Date(dayStarts[0]).getFullYear();
    const lastYear = new Date(dayStarts[dayStarts.length - 1]).getFullYear();
    const showFullYear = firstYear !== lastYear || dayStarts.length > 90;

    for (let i = 0; i < dayStarts.length; i++) {
      const sMs = dayStarts[i];
      const endCursor = new Date(sMs);
      endCursor.setDate(endCursor.getDate() + 1);
      endCursor.setHours(0, 0, 0, 0);
      const eMs = endCursor.getTime();

      const sd = new Date(sMs);
      const axisLabel = `${sd.getMonth() + 1}/${pad2(sd.getDate())}`;
      const datePrefix = showFullYear ? `${sd.getFullYear()}年` : '';
      const fullLabel = `${datePrefix}${sd.getMonth() + 1}月${sd.getDate()}日 (${WEEKDAY_NAMES[sd.getDay()]})`;

      trendSeries.push({
        index: i,
        startMs: sMs,
        endMs: eMs,
        granularity: 'day',
        label: axisLabel,
        fullLabel,
        tokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        responseTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
        calls: 0,
      });
    }
  }

  if (trendSeries.length > 0) {
    const firstBucketStart = trendSeries[0].startMs;
    const lastIdx = trendSeries.length - 1;
    let previousBucketIndex = 0;
    for (const item of selectedWindowSteps) {
      let targetIdx = lastIdx;
      const previousBucket = trendSeries[previousBucketIndex];
      if (item.tMs <= firstBucketStart) {
        targetIdx = 0;
      } else if (item.tMs >= previousBucket.startMs && item.tMs < previousBucket.endMs) {
        targetIdx = previousBucketIndex;
      } else {
        // 二分查找匹配的时间桶 [startMs, endMs)
        let lo = 0;
        let hi = lastIdx;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const b = trendSeries[mid];
          if (item.tMs < b.startMs) {
            hi = mid - 1;
          } else if (item.tMs >= b.endMs && mid < lastIdx) {
            lo = mid + 1;
          } else {
            targetIdx = mid;
            break;
          }
        }
      }
      previousBucketIndex = targetIdx;
      const bucket = trendSeries[targetIdx];
      bucket.tokens += item.tokens;
      bucket.inputTokens += item.inputTokens || 0;
      bucket.cacheReadTokens += item.cacheReadTokens || 0;
      bucket.outputTokens += item.outputTokens || 0;
      bucket.thinkingTokens += item.thinkingTokens || 0;
      bucket.responseTokens += item.responseTokens || 0;
      bucket.costUsd += item.costUsd;
      bucket.unpricedCalls = (bucket.unpricedCalls || 0) + item.unpricedCalls;
      bucket.calls += 1;

      if (item.mInfo && item.tokens > 0) {
        bucket.perModelStats ??= new Map();
        const mInfo = item.mInfo;
        const modelGroupKey = mInfo.baseLabel || mInfo.label;
        let bModel = bucket.perModelStats.get(modelGroupKey);
        if (!bModel) {
          bModel = {
            label: modelGroupKey,
            shortName: mInfo.shortName,
            fallbackModelId:
              mInfo.modelId && mInfo.modelId !== 'unknown'
                ? formatUpstreamModelId(mInfo.modelId, mInfo)
                : '',
            upstreamModelCounts: new Map(),
            family: mInfo.family,
            calls: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            thinkingTokens: 0,
            responseTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            unpricedCalls: 0,
          };
          bucket.perModelStats.set(modelGroupKey, bModel);
        }
        if (item.responseModel) {
          const formattedResp = formatUpstreamModelId(item.responseModel, mInfo);
          bModel.upstreamModelCounts.set(
            formattedResp,
            (bModel.upstreamModelCounts.get(formattedResp) || 0) + 1
          );
        }
        bModel.calls += 1;
        bModel.inputTokens += item.inputTokens || 0;
        bModel.cacheReadTokens += item.cacheReadTokens || 0;
        bModel.outputTokens += item.outputTokens || 0;
        bModel.thinkingTokens += item.thinkingTokens || 0;
        bModel.responseTokens += item.responseTokens || 0;
        bModel.totalTokens += item.tokens;
        bModel.costUsd += item.costUsd;
        bModel.unpricedCalls += item.unpricedCalls || 0;
      }
    }
    for (const b of trendSeries) {
      b.costUsd = +b.costUsd.toFixed(4);
      if (b.perModelStats) {
        b.models = Array.from(b.perModelStats.values())
          .sort((a, c) => c.totalTokens - a.totalTokens || c.calls - a.calls)
          .map(({ upstreamModelCounts, fallbackModelId, ...m }) => {
            const sortedUpstream = Array.from(upstreamModelCounts.entries())
              .sort((a, c) => c[1] - a[1])
              .map(([name]) => name);
            const primaryUpstream =
              sortedUpstream.length > 0 ? sortedUpstream[0] : fallbackModelId || m.shortName || m.label;
            return {
              ...m,
              upstreamName: primaryUpstream,
              upstreamModels: sortedUpstream,
              costUsd: +m.costUsd.toFixed(6),
            };
          });
        delete b.perModelStats;
      }
    }
  }

  return { trend, trendStartMs, trendEndMs, trendSeries };
}

function resolveIntradayStepMinutes(spanMs, windowKey = '') {
  if (windowKey !== 'all') {
    if (spanMs < 15 * 60 * 1000) return 1;
    if (spanMs < 60 * 60 * 1000) return 5;
    if (spanMs < 2 * 3600 * 1000) return 15;
  }
  const totalHours = Math.max(2, Math.floor(spanMs / (3600 * 1000)) + 1);
  return totalHours > 72 ? Math.ceil(totalHours / 48) * 60 : 60;
}

function floorToLocalTrendSlotMs(ms, stepMinutes) {
  const d = new Date(ms);
  if (stepMinutes < 60) {
    const alignedMin = Math.floor(d.getMinutes() / stepMinutes) * stepMinutes;
    d.setMinutes(alignedMin, 0, 0);
  } else {
    d.setMinutes(0, 0, 0);
  }
  return d.getTime();
}

function planUsageTrend(window, nowMs, earliest, latest) {
  const safeMs = (value, fallback) =>
    Number.isFinite(value) && value > 0 && value <= MAX_TREND_TIMESTAMP_MS ? value : fallback;
  const end = Math.max(safeMs(window.endMs, Math.max(nowMs, latest || nowMs)), latest);
  const defaultStart = end - 24 * 3600 * 1000;
  let start;
  if (window.key === 'all') {
    const curWeekMonMs = getStartOfCurrentWeekMs(end);
    const halfYearStart = new Date(curWeekMonMs);
    halfYearStart.setDate(halfYearStart.getDate() - 25 * 7);
    halfYearStart.setHours(0, 0, 0, 0);
    const halfYearFloorMs = halfYearStart.getTime();
    start = Math.min(safeMs(earliest, halfYearFloorMs), halfYearFloorMs);
  } else {
    start = Math.min(safeMs(window.startMs, defaultStart), end);
  }
  const spanMs = Math.max(0, end - start);
  const hourly =
    window.key === 'today' ||
    window.key === '24h' ||
    window.key === '5h' ||
    spanMs <= 72 * 3600 * 1000;
  if (hourly) {
    const stepMinutes = resolveIntradayStepMinutes(spanMs, window.key);
    const stepMs = stepMinutes * 60 * 1000;
    const first = floorToLocalTrendSlotMs(start, stepMinutes);
    const last = floorToLocalTrendSlotMs(end, stepMinutes);
    return { start, end, hourly, stepMs, first, last };
  }
  const first = new Date(start);
  const last = new Date(end);
  first.setHours(0, 0, 0, 0);
  last.setHours(0, 0, 0, 0);
  return {
    start,
    end,
    hourly,
    stepMs: 24 * 3600 * 1000,
    first: first.getTime(),
    last: last.getTime(),
  };
}

function sameUsageEntries(previous, current) {
  return previous.length === current.length && current.every((entry, index) => {
    const before = previous[index];
    return entry.steps === before.steps && entry.cascadeId === before.cascadeId &&
      entry.appSource === before.appSource && entry.accountName === before.accountName &&
      entry.workspaceUri === before.workspaceUri;
  });
}

function buildFamilySig(familySet) {
  if (!(familySet instanceof Set) || familySet.size === 0) return '';
  return Array.from(familySet).sort().join(',');
}

function computeFamilySessionBuckets({
  entries,
  familySet,
  presetKeys = [],
  presetWindows = {},
  selectedWindow,
  resolveStepModel,
}) {
  const sessionBuckets = {};
  for (const k of presetKeys) {
    sessionBuckets[k] = createUsageBucket();
  }
  const selectedSessionBucket =
    selectedWindow?.key && sessionBuckets[selectedWindow.key]
      ? sessionBuckets[selectedWindow.key]
      : createUsageBucket();
  if (!(familySet instanceof Set) || familySet.size === 0) {
    const sessionPresets = {};
    for (const k of presetKeys) {
      sessionPresets[k] = finalizeUsageBucket(sessionBuckets[k]);
    }
    return {
      finalizedSelectedSession: finalizeUsageBucket(selectedSessionBucket),
      sessionPresets,
    };
  }

  for (const entry of entries || []) {
    const cidLower = String(entry?.cascadeId || '').toLowerCase();
    if (!cidLower || !familySet.has(cidLower)) continue;
    const entrySteps = entry.steps || [];
    for (let sIdx = 0; sIdx < entrySteps.length; sIdx++) {
      const st = entrySteps[sIdx];
      if (!st || typeof st !== 'object') continue;
      const mInfo = resolveStepModel(st);
      const inTok = safeTok(st.inputTokens);
      const cacheTok = safeTok(st.cacheReadTokens);
      const outTok = safeTok(st.outputTokens);
      const thinkTok = safeTok(st.thinkingTokens);
      const respTok =
        st.responseTokens !== undefined && st.responseTokens !== null
          ? safeTok(st.responseTokens)
          : Math.max(0, outTok - thinkTok);
      const stepTotalTokens = inTok + cacheTok + outTok;
      const stepCost = computeStepCost(st, mInfo.pricing);
      const resolvedCost = Number.isFinite(stepCost) ? stepCost : 0;
      const unpriced = stepCost === null ? 1 : 0;
      const tMs = Number(st.createdAtMs) > 0 ? Number(st.createdAtMs) : 0;
      const savedCost = mInfo.pricing
        ? (cacheTok / 1_000_000) * Math.max(0, mInfo.pricing.input - mInfo.pricing.cache)
        : 0;
      const stepUsage = {
        inTok,
        cacheTok,
        outTok,
        thinkTok,
        respTok,
        stepTotalTokens,
        resolvedCost,
        savedCost,
        unpriced,
      };

      for (const k of presetKeys) {
        const w = presetWindows[k];
        const matchesPreset =
          k === 'all' ? true : tMs > 0 && tMs >= w.startMs && tMs <= w.endMs;
        if (matchesPreset) {
          accumulateStepIntoBucket(sessionBuckets[k], stepUsage, entry.cascadeId, st);
        }
      }

      if (selectedWindow && (!sessionBuckets[selectedWindow.key] || selectedWindow.key === 'custom')) {
        const inSelectedWindow =
          selectedWindow.key === 'all'
            ? true
            : tMs > 0 && tMs >= selectedWindow.startMs && tMs <= selectedWindow.endMs;
        if (inSelectedWindow) {
          accumulateStepIntoBucket(selectedSessionBucket, stepUsage, entry.cascadeId, st);
        }
      }
    }
  }

  const sessionPresets = {};
  for (const k of presetKeys) {
    sessionPresets[k] = finalizeUsageBucket(sessionBuckets[k]);
  }
  return {
    finalizedSelectedSession: finalizeUsageBucket(selectedSessionBucket),
    sessionPresets,
  };
}

function sortedUsageTimestamps(entries) {
  const dates = new Float64Array(entries.reduce((sum, entry) => sum + entry.steps.length, 0));
  let count = 0;
  for (const { steps } of entries) {
    for (const step of steps) {
      const date = Number(step?.createdAtMs);
      if (date > 0) dates[count++] = date;
    }
  }
  return dates.subarray(0, count).sort();
}

function usageTimestampBoundary(dates, value, inclusive) {
  let start = 0;
  let end = dates.length;
  while (start < end) {
    const i = (start + end) >>> 1;
    if (dates[i] < value || (inclusive && dates[i] === value)) start = i + 1;
    else end = i;
  }
  return start;
}

function sameUsageWindows(previous, current, dates) {
  return previous.length === current.length && current.every((window, index) => {
    const before = previous[index];
    return before.key === window.key && before.label === window.label &&
      (before.startMs === window.startMs ||
        usageTimestampBoundary(dates, before.startMs, false) ===
          usageTimestampBoundary(dates, window.startMs, false)) &&
      (before.endMs === window.endMs ||
        usageTimestampBoundary(dates, before.endMs, true) ===
          usageTimestampBoundary(dates, window.endMs, true));
  });
}

/**
 * 聚合所有预设时间窗口、当前选定窗口、趋势图、年度月序列、来源占比与分模型统计。
 *
 * @param {{
 *   filterOpts?: { range?: string, startMs?: number, endMs?: number },
 *   activeCascadeId?: string|null,
 *   activeFamilyCascadeIds?: Set<string>|null,
 *   resolveStepModel: StepModelResolver,
 *   modelInputs?: { catalogRevision: number, dynamicModelMap: Map },
 *   endpoint?: object|null,
 * }} params
 */
export function aggregateMultiWindowUsage({
  filterOpts = {},
  activeCascadeId = null,
  activeFamilyCascadeIds = null,
  resolveStepModel,
  modelInputs = null,
  endpoint = null,
}) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const endpointKey = isRemote ? String(endpoint.id || 'remote') : 'local';
  const rawFamilyIds =
    activeFamilyCascadeIds instanceof Set
      ? Array.from(activeFamilyCascadeIds)
      : activeCascadeId
        ? [activeCascadeId]
        : [];
  const familySet = new Set(rawFamilyIds.map((id) => String(id || '').toLowerCase()));
  const nowMs = Date.now();
  const selectedWindow = resolveTimeWindow(
    filterOpts.range || 'all',
    filterOpts.startMs,
    filterOpts.endMs,
    nowMs
  );

  const presetKeys = ['all', '5h', 'today', '24h', 'week', '7d', '14d', '30d'];
  const presetWindows = {};
  const accountBuckets = {};
  const sessionBuckets = {};

  for (const k of presetKeys) {
    presetWindows[k] = resolveTimeWindow(k, 0, 0, nowMs);
    accountBuckets[k] = createUsageBucket();
    sessionBuckets[k] = createUsageBucket();
  }

  const selectedRangeCacheKey = selectedWindow.key;
  const selectedAccountBucket = accountBuckets[selectedWindow.key] || createUsageBucket();
  const selectedSessionBucket = sessionBuckets[selectedWindow.key] || createUsageBucket();
  const perModelStats = new Map();
  const perConvStats = new Map();
  const perWorkspaceStats = new Map();
  const selectedWindowSteps = [];
  let earliestSelectedStepMs = Infinity;
  let latestSelectedStepMs = 0;

  const currentYear = new Date(nowMs).getFullYear();
  const monthBoundsMs = Array.from({ length: 13 }, (_, idx) =>
    new Date(currentYear, idx, 1).getTime()
  );
  const yearStartMs = monthBoundsMs[0];
  const nextYearStartMs = monthBoundsMs[12];
  const monthlySeries = Array.from({ length: 12 }, (_, idx) => ({
    month: idx + 1,
    label: `${idx + 1}月`,
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    responseTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
    perModelStats: new Map(),
  }));

  const perSourceStats = new Map();
  const allEntriesToAggregate = collectUsageEntriesToAggregate(familySet, endpoint);
  const familySig = buildFamilySig(familySet);

  const timeZone = modelInputs ? resolveCachedLocalTimeZone() : '';
  const windows = [selectedWindow, ...Object.values(presetWindows)];
  const snapshot = lastUsageSnapshotsByEndpoint.get(endpointKey) || null;
  const sameSnapshot = modelInputs && snapshot && timeZone === snapshot.timeZone &&
    currentYear === snapshot.currentYear &&
    modelInputs.catalogRevision === snapshot.modelInputs.catalogRevision &&
    modelInputs.phaseEpoch === snapshot.modelInputs.phaseEpoch &&
    isDeepStrictEqual(modelInputs.dynamicModelMap, snapshot.modelInputs.dynamicModelMap) &&
    sameUsageEntries(snapshot.entries, allEntriesToAggregate);
  const previous = sameSnapshot ? snapshot.ranges.get(selectedRangeCacheKey) : null;
  if (previous) {
    // 时钟继续前进，只有实际有步骤跨过窗口边界时才重新聚合。
    const trend = planUsageTrend(selectedWindow, nowMs, previous.earliest, previous.latest);
    if (
      trend.hourly === previous.trend.hourly &&
      trend.stepMs === previous.trend.stepMs &&
      trend.first === previous.trend.first &&
      trend.last === previous.trend.last &&
      sameUsageWindows(
        previous.windows,
        windows,
        (snapshot.dates ??= sortedUsageTimestamps(allEntriesToAggregate))
      )
    ) {
      snapshot.ranges.delete(selectedRangeCacheKey);
      snapshot.ranges.set(selectedRangeCacheKey, previous);
      if (previous.familySig === familySig) {
        return {
          ...previous.result,
          usageRevision: snapshot.revision,
          selectedWindow,
          trendStartMs: trend.start,
          trendEndMs: trend.end,
        };
      }
      const { finalizedSelectedSession: nextSelSession, sessionPresets } =
        computeFamilySessionBuckets({
          entries: allEntriesToAggregate,
          familySet,
          presetKeys,
          presetWindows,
          selectedWindow,
          resolveStepModel,
        });
      const prevPresets = previous.result.finalizedPresets || {};
      const nextFinalizedPresets = {};
      for (const k of presetKeys) {
        nextFinalizedPresets[k] = {
          ...(prevPresets[k] || { label: presetWindows[k].label }),
          session: sessionPresets[k],
        };
      }
      return {
        ...previous.result,
        usageRevision: snapshot.revision,
        selectedWindow,
        trendStartMs: trend.start,
        trendEndMs: trend.end,
        finalizedSelectedSession: nextSelSession,
        finalizedPresets: nextFinalizedPresets,
      };
    }
  }

  for (const entry of allEntriesToAggregate) {
    const { cascadeId, isCurrentConv } = entry;
    const srcKey = entry.appSource || 'standalone';
    const srcName = USAGE_SOURCE_LABELS[srcKey] || `Antigravity (${srcKey})`;

    const entrySteps = entry.steps || [];
    for (let sIdx = 0; sIdx < entrySteps.length; sIdx++) {
      const st = entrySteps[sIdx];
      if (!st || typeof st !== 'object') continue;
      const mInfo = resolveStepModel(st);
      const inTok = safeTok(st.inputTokens);
      const cacheTok = safeTok(st.cacheReadTokens);
      const outTok = safeTok(st.outputTokens);
      const thinkTok = safeTok(st.thinkingTokens);
      const respTok =
        st.responseTokens !== undefined && st.responseTokens !== null
          ? safeTok(st.responseTokens)
          : Math.max(0, outTok - thinkTok);
      const stepTotalTokens = inTok + cacheTok + outTok;
      const stepCost = computeStepCost(st, mInfo.pricing);
      const resolvedCost = Number.isFinite(stepCost) ? stepCost : 0;
      const unpriced = stepCost === null ? 1 : 0;
      const tMs = Number(st.createdAtMs) > 0 ? Number(st.createdAtMs) : 0;
      const savedCost = mInfo.pricing
        ? (cacheTok / 1_000_000) * Math.max(0, mInfo.pricing.input - mInfo.pricing.cache)
        : 0;
      const stepUsage = { inTok, cacheTok, outTok, thinkTok, respTok, stepTotalTokens,
        resolvedCost, savedCost, unpriced };

      if (tMs >= yearStartMs && tMs < nextYearStartMs) {
        let monthIdx = 11;
        for (let m = 0; m < 12; m++) {
          if (tMs < monthBoundsMs[m + 1]) {
            monthIdx = m;
            break;
          }
        }
        const mBucket = monthlySeries[monthIdx];
        if (mBucket) {
          mBucket.calls += 1;
          mBucket.inputTokens += inTok;
          mBucket.cacheReadTokens += cacheTok;
          mBucket.responseTokens += respTok;
          mBucket.thinkingTokens += thinkTok;
          mBucket.totalTokens += stepTotalTokens;
          mBucket.costUsd += resolvedCost;
          mBucket.unpricedCalls = (mBucket.unpricedCalls || 0) + unpriced;
          accumulateStepIntoModelMap(mBucket.perModelStats, st, mInfo, stepCost);
        }
      }

      for (const k of presetKeys) {
        const w = presetWindows[k];
        const matchesPreset = k === 'all' ? true : tMs > 0 && tMs >= w.startMs && tMs <= w.endMs;
        if (matchesPreset) {
          accumulateStepIntoBucket(accountBuckets[k], stepUsage, cascadeId, st);
          if (isCurrentConv) {
            accumulateStepIntoBucket(sessionBuckets[k], stepUsage, cascadeId, st);
          }
        }
      }

      const inSelectedWindow =
        selectedWindow.key === 'all'
          ? true
          : tMs > 0 && tMs >= selectedWindow.startMs && tMs <= selectedWindow.endMs;

      if (inSelectedWindow) {
        if (selectedWindow.key === 'custom') {
          accumulateStepIntoBucket(selectedAccountBucket, stepUsage, cascadeId, st);
          if (isCurrentConv) {
            accumulateStepIntoBucket(selectedSessionBucket, stepUsage, cascadeId, st);
          }
        }
        if (tMs > 0) {
          if (tMs < earliestSelectedStepMs) earliestSelectedStepMs = tMs;
          if (tMs > latestSelectedStepMs && tMs <= MAX_TREND_TIMESTAMP_MS) latestSelectedStepMs = tMs;
          selectedWindowSteps.push({
            tMs,
            tokens: stepTotalTokens,
            inputTokens: inTok,
            cacheReadTokens: cacheTok,
            outputTokens: outTok,
            thinkingTokens: thinkTok,
            responseTokens: respTok,
            costUsd: resolvedCost,
            unpricedCalls: unpriced,
            mInfo,
            responseModel: st.responseModel || '',
          });
        }

        if (!perSourceStats.has(srcKey)) {
          perSourceStats.set(srcKey, {
            name: srcName,
            calls: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            responseTokens: 0,
            thinkingTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            perModelStats: new Map(),
          });
        }
        const sAgg = perSourceStats.get(srcKey);
        sAgg.calls += 1;
        sAgg.inputTokens += inTok;
        sAgg.cacheReadTokens += cacheTok;
        sAgg.responseTokens += respTok;
        sAgg.thinkingTokens += thinkTok;
        sAgg.totalTokens += stepTotalTokens;
        sAgg.costUsd += resolvedCost;
        sAgg.unpricedCalls = (sAgg.unpricedCalls || 0) + unpriced;
        accumulateStepIntoModelMap(sAgg.perModelStats, st, mInfo, stepCost);

        accumulateStepIntoModelMap(perModelStats, st, mInfo, stepCost);
        accumulateStepIntoConversationMap(
          perConvStats,
          entry,
          srcKey,
          srcName,
          stepUsage,
          tMs,
          st,
          mInfo,
          stepCost
        );
        accumulateStepIntoWorkspaceMap(
          perWorkspaceStats,
          entry,
          stepUsage,
          tMs,
          st,
          mInfo,
          stepCost
        );
      }
    }
  }

  const finalizedMonthlySeries = monthlySeries.map(
    ({ perModelStats: monthModelMap, ...mBucket }) => ({
      ...mBucket,
      costUsd: +mBucket.costUsd.toFixed(4),
      models: finalizeModelBreakdownMap(monthModelMap),
    })
  );

  // 构建当前选定时间窗口的自适应自然整点/整日趋势序列 (trendSeries)
  const { trend, trendStartMs, trendEndMs, trendSeries } = buildUsageTrendSeries(
    selectedWindow,
    selectedWindow,
    selectedWindowSteps,
    nowMs,
    earliestSelectedStepMs,
    latestSelectedStepMs
  );

  const finalizedPresets = {};
  for (const k of presetKeys) {
    finalizedPresets[k] = {
      label: presetWindows[k].label,
      session: finalizeUsageBucket(sessionBuckets[k]),
      account: finalizeUsageBucket(accountBuckets[k]),
    };
  }

  const finalizedSelectedSession = finalizeUsageBucket(selectedSessionBucket);
  const finalizedSelectedAccount = finalizeUsageBucket(selectedAccountBucket);

  const sourcesBreakdown = Array.from(perSourceStats.values())
    .filter((s) => s.totalTokens > 0 || s.calls > 0)
    .map(({ perModelStats: sourceModelMap, ...s }) => ({
      ...s,
      costUsd: +s.costUsd.toFixed(2),
      models: finalizeModelBreakdownMap(sourceModelMap),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);

  const todayBucket = finalizedPresets.today.account;
  const weekBucket = finalizedPresets.week.account;
  const modelBreakdown = finalizeModelBreakdownMap(perModelStats);
  const topConversations = finalizeTopConversationsMap(perConvStats);
  const topWorkspaces = finalizeTopWorkspacesMap(perWorkspaceStats);

  let resolvedUsageRevision = usageSnapshotRevisionSeq;
  let activeSnap = snapshot;
  if (modelInputs) {
    if (!sameSnapshot) {
      resolvedUsageRevision = ++usageSnapshotRevisionSeq;
      activeSnap = {
        revision: resolvedUsageRevision,
        timeZone,
        modelInputs,
        currentYear,
        entries: allEntriesToAggregate,
        dates: null,
        ranges: new Map(),
        selectedRanges: new Map(),
      };
      lastUsageSnapshotsByEndpoint.delete(endpointKey);
      if (lastUsageSnapshotsByEndpoint.size >= MAX_USAGE_SNAPSHOT_ENDPOINTS) {
        const oldestKey = lastUsageSnapshotsByEndpoint.keys().next().value;
        if (oldestKey !== undefined) lastUsageSnapshotsByEndpoint.delete(oldestKey);
      }
      lastUsageSnapshotsByEndpoint.set(endpointKey, activeSnap);
    } else if (previous) {
      resolvedUsageRevision = ++usageSnapshotRevisionSeq;
      activeSnap.revision = resolvedUsageRevision;
      activeSnap.ranges.clear();
      activeSnap.selectedRanges?.clear?.();
    } else {
      resolvedUsageRevision = activeSnap.revision;
    }
  } else {
    resolvedUsageRevision = ++usageSnapshotRevisionSeq;
  }

  const result = {
    usageRevision: resolvedUsageRevision,
    selectedWindow,
    trendStartMs,
    trendEndMs,
    finalizedSelectedSession,
    finalizedSelectedAccount,
    finalizedPresets,
    trendSeries,
    sourcesBreakdown,
    currentYear,
    monthlySeries: finalizedMonthlySeries,
    todayBucket,
    weekBucket,
    modelBreakdown,
    topConversations,
    topWorkspaces,
  };
  if (modelInputs && activeSnap) {
    const { ranges } = activeSnap;
    ranges.delete(selectedRangeCacheKey);
    ranges.set(selectedRangeCacheKey, {
      familySig,
      windows,
      selectedWindow,
      trend,
      result,
      earliest: earliestSelectedStepMs,
      latest: latestSelectedStepMs,
    });
    // 缓存各时间窗口的完整多窗口聚合结果，同快照复用时亚毫秒命中。
    if (ranges.size > 16) ranges.delete(ranges.keys().next().value);
  }
  return result;
}

/**
 * 轻量级单时间窗口剪枝聚合器（专为 `scope=consumption` / `scope=consumption-presets` 瞬切服务）：
 * 1. 跳过 12 个月年度柱与 8 预设桶；
 * 2. 基于会话级 `[minMs, maxMs]` 边界直接跳过时间完全不重叠的历史会话；
 * 3. 与 `aggregateMultiWindowUsage` 共用完全一致的时间窗口、来源/模型归并及趋势分桶逻辑。
 */
export function aggregateSelectedWindowUsage({
  filterOpts = {},
  activeCascadeId = null,
  activeFamilyCascadeIds = null,
  resolveStepModel,
  modelInputs = null,
  precollectedEntries = null,
  endpoint = null,
}) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const endpointKey = isRemote ? String(endpoint.id || 'remote') : 'local';
  const rawFamilyIds =
    activeFamilyCascadeIds instanceof Set
      ? Array.from(activeFamilyCascadeIds)
      : activeCascadeId
        ? [activeCascadeId]
        : [];
  const familySet = new Set(rawFamilyIds.map((id) => String(id || '').toLowerCase()));
  const nowMs = Date.now();
  const selectedWindow = resolveTimeWindow(
    filterOpts.range || 'all',
    filterOpts.startMs,
    filterOpts.endMs,
    nowMs
  );
  const selectedRangeCacheKey = selectedWindow.key;

  const allEntriesToAggregate = Array.isArray(precollectedEntries)
    ? precollectedEntries
    : collectUsageEntriesToAggregate(familySet, endpoint);
  const familySig = buildFamilySig(familySet);
  const currentYear = new Date(nowMs).getFullYear();
  const timeZone = modelInputs ? resolveCachedLocalTimeZone() : '';

  const currentCheckWindows = [selectedWindow];

  const snapshot = lastUsageSnapshotsByEndpoint.get(endpointKey) || null;
  const sameSnapshot = Boolean(
    modelInputs &&
      snapshot &&
      timeZone === snapshot.timeZone &&
      currentYear === snapshot.currentYear &&
      modelInputs.catalogRevision === snapshot.modelInputs.catalogRevision &&
      modelInputs.phaseEpoch === snapshot.modelInputs.phaseEpoch &&
      isDeepStrictEqual(modelInputs.dynamicModelMap, snapshot.modelInputs.dynamicModelMap) &&
      sameUsageEntries(snapshot.entries, allEntriesToAggregate)
  );

  if (sameSnapshot) {
    snapshot.selectedRanges ??= new Map();
    const cachedFull = snapshot.ranges.get(selectedRangeCacheKey);
    const cachedLite = snapshot.selectedRanges.get(selectedRangeCacheKey);
    const candidate = cachedFull || cachedLite;
    if (candidate) {
      const prevWin = candidate.selectedWindow || candidate.windows?.[0] || selectedWindow;
      const trend = planUsageTrend(selectedWindow, nowMs, candidate.earliest, candidate.latest);
      const prevCheckWindows = candidate.checkWindows || [prevWin];
      if (
        trend.hourly === candidate.trend.hourly &&
        trend.stepMs === candidate.trend.stepMs &&
        trend.first === candidate.trend.first &&
        trend.last === candidate.trend.last &&
        sameUsageWindows(
          prevCheckWindows.length === currentCheckWindows.length ? prevCheckWindows : [prevWin],
          currentCheckWindows,
          (snapshot.dates ??= sortedUsageTimestamps(allEntriesToAggregate))
        )
      ) {
        const res = candidate.result;
        const resolvedSelectedSession =
          candidate.familySig === familySig
            ? res.finalizedSelectedSession
            : computeFamilySessionBuckets({
                entries: allEntriesToAggregate,
                familySet,
                presetKeys: [],
                presetWindows: {},
                selectedWindow,
                resolveStepModel,
              }).finalizedSelectedSession;
        return {
          usageRevision: snapshot.revision,
          selectedWindow,
          trendStartMs: trend.start,
          trendEndMs: trend.end,
          finalizedSelectedSession: resolvedSelectedSession,
          finalizedSelectedAccount: res.finalizedSelectedAccount,
          trendSeries: res.trendSeries,
          sourcesBreakdown: res.sourcesBreakdown,
          modelBreakdown: res.modelBreakdown,
          topConversations: res.topConversations || [],
          topWorkspaces: res.topWorkspaces || [],
        };
      }
      snapshot.revision = ++usageSnapshotRevisionSeq;
      snapshot.ranges.clear();
      snapshot.selectedRanges.clear();
    }
  }

  let minCutoffMs = 0;
  let maxCutoffMs = Infinity;
  let canPruneByTime = false;
  if (selectedWindow.key !== 'all') {
    canPruneByTime = true;
    minCutoffMs = selectedWindow.startMs;
    maxCutoffMs = selectedWindow.endMs;
  }

  const selectedAccountBucket = createUsageBucket();
  const selectedSessionBucket = createUsageBucket();
  const perModelStats = new Map();
  const perSourceStats = new Map();
  const perConvStats = new Map();
  const perWorkspaceStats = new Map();
  const selectedWindowSteps = [];
  let earliestSelectedStepMs = Infinity;
  let latestSelectedStepMs = 0;

  for (const entry of allEntriesToAggregate) {
    const steps = entry.steps || [];
    if (steps.length === 0) continue;
    if (canPruneByTime) {
      const bounds = getStepsTimeBounds(steps);
      if (bounds.maxMs <= 0 || bounds.maxMs < minCutoffMs || bounds.minMs > maxCutoffMs) {
        continue;
      }
    }
    const { cascadeId, isCurrentConv } = entry;
    const srcKey = entry.appSource || 'standalone';
    const srcName = USAGE_SOURCE_LABELS[srcKey] || `Antigravity (${srcKey})`;

    for (let sIdx = 0; sIdx < steps.length; sIdx++) {
      const st = steps[sIdx];
      if (!st || typeof st !== 'object') continue;
      const tMs = Number(st.createdAtMs) > 0 ? Number(st.createdAtMs) : 0;
      if (canPruneByTime && (tMs <= 0 || tMs < minCutoffMs || tMs > maxCutoffMs)) {
        continue;
      }

      const mInfo = resolveStepModel(st);
      const inTok = safeTok(st.inputTokens);
      const cacheTok = safeTok(st.cacheReadTokens);
      const outTok = safeTok(st.outputTokens);
      const thinkTok = safeTok(st.thinkingTokens);
      const respTok =
        st.responseTokens !== undefined && st.responseTokens !== null
          ? safeTok(st.responseTokens)
          : Math.max(0, outTok - thinkTok);
      const stepTotalTokens = inTok + cacheTok + outTok;
      const stepCost = computeStepCost(st, mInfo.pricing);
      const resolvedCost = Number.isFinite(stepCost) ? stepCost : 0;
      const unpriced = stepCost === null ? 1 : 0;
      const savedCost = mInfo.pricing
        ? (cacheTok / 1_000_000) * Math.max(0, mInfo.pricing.input - mInfo.pricing.cache)
        : 0;
      const stepUsage = {
        inTok,
        cacheTok,
        outTok,
        thinkTok,
        respTok,
        stepTotalTokens,
        resolvedCost,
        savedCost,
        unpriced,
      };

      accumulateStepIntoBucket(selectedAccountBucket, stepUsage, cascadeId, st);
      if (isCurrentConv) {
        accumulateStepIntoBucket(selectedSessionBucket, stepUsage, cascadeId, st);
      }

      if (tMs > 0) {
        if (tMs < earliestSelectedStepMs) earliestSelectedStepMs = tMs;
        if (tMs > latestSelectedStepMs && tMs <= MAX_TREND_TIMESTAMP_MS) latestSelectedStepMs = tMs;
        selectedWindowSteps.push({
          tMs,
          tokens: stepTotalTokens,
          inputTokens: inTok,
          cacheReadTokens: cacheTok,
          outputTokens: outTok,
          thinkingTokens: thinkTok,
          responseTokens: respTok,
          costUsd: resolvedCost,
          unpricedCalls: unpriced,
          mInfo,
          responseModel: st.responseModel || '',
        });
      }

      if (!perSourceStats.has(srcKey)) {
        perSourceStats.set(srcKey, {
          name: srcName,
          calls: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          responseTokens: 0,
          thinkingTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          perModelStats: new Map(),
        });
      }
      const sAgg = perSourceStats.get(srcKey);
      sAgg.calls += 1;
      sAgg.inputTokens += inTok;
      sAgg.cacheReadTokens += cacheTok;
      sAgg.responseTokens += respTok;
      sAgg.thinkingTokens += thinkTok;
      sAgg.totalTokens += stepTotalTokens;
      sAgg.costUsd += resolvedCost;
      sAgg.unpricedCalls = (sAgg.unpricedCalls || 0) + unpriced;
      accumulateStepIntoModelMap(sAgg.perModelStats, st, mInfo, stepCost);

      accumulateStepIntoModelMap(perModelStats, st, mInfo, stepCost);
      accumulateStepIntoConversationMap(
        perConvStats,
        entry,
        srcKey,
        srcName,
        stepUsage,
        tMs,
        st,
        mInfo,
        stepCost
      );
      accumulateStepIntoWorkspaceMap(
        perWorkspaceStats,
        entry,
        stepUsage,
        tMs,
        st,
        mInfo,
        stepCost
      );
    }
  }

  const { trend, trendStartMs, trendEndMs, trendSeries } = buildUsageTrendSeries(
    selectedWindow,
    selectedWindow,
    selectedWindowSteps,
    nowMs,
    earliestSelectedStepMs,
    latestSelectedStepMs
  );

  const finalizedSelectedSession = finalizeUsageBucket(selectedSessionBucket);
  const finalizedSelectedAccount = finalizeUsageBucket(selectedAccountBucket);
  const sourcesBreakdown = Array.from(perSourceStats.values())
    .filter((s) => s.totalTokens > 0 || s.calls > 0)
    .map(({ perModelStats: sourceModelMap, ...s }) => ({
      ...s,
      costUsd: +s.costUsd.toFixed(2),
      models: finalizeModelBreakdownMap(sourceModelMap),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);
  const modelBreakdown = finalizeModelBreakdownMap(perModelStats);
  const topConversations = finalizeTopConversationsMap(perConvStats);
  const topWorkspaces = finalizeTopWorkspacesMap(perWorkspaceStats);

  const sliceResult = {
    usageRevision: sameSnapshot ? snapshot.revision : usageSnapshotRevisionSeq,
    selectedWindow,
    trendStartMs,
    trendEndMs,
    finalizedSelectedSession,
    finalizedSelectedAccount,
    trendSeries,
    sourcesBreakdown,
    modelBreakdown,
    topConversations,
    topWorkspaces,
  };

  if (sameSnapshot) {
    snapshot.selectedRanges ??= new Map();
    snapshot.selectedRanges.delete(selectedRangeCacheKey);
    snapshot.selectedRanges.set(selectedRangeCacheKey, {
      familySig,
      checkWindows: currentCheckWindows,
      selectedWindow,
      trend,
      result: sliceResult,
      earliest: earliestSelectedStepMs,
      latest: latestSelectedStepMs,
    });
    if (snapshot.selectedRanges.size > 16) {
      snapshot.selectedRanges.delete(snapshot.selectedRanges.keys().next().value);
    }
  }

  return sliceResult;
}

/**
 * 轻量级单会话家族用量汇总（专为 `scope=conversation` 瞬切服务）：
 * 仅遍历当前选中根会话及其子代理步骤，不触碰其余历史会话与全局账户聚合缓存。
 */
export function aggregateSessionUsageForFamily({
  filterOpts = {},
  activeCascadeId = null,
  activeFamilyCascadeIds = null,
  resolveStepModel,
  endpoint = null,
}) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const cacheStore = getEndpointCacheStore(endpoint);
  const rawFamilyIds =
    activeFamilyCascadeIds instanceof Set
      ? Array.from(activeFamilyCascadeIds)
      : activeCascadeId
        ? [activeCascadeId]
        : [];
  const familySet = new Set(rawFamilyIds.map((id) => String(id || '').toLowerCase()).filter(Boolean));
  const nowMs = Date.now();
  const selectedWindow = resolveTimeWindow(
    filterOpts.range || 'all',
    filterOpts.startMs,
    filterOpts.endMs,
    nowMs
  );
  const presetKeys = ['all', '5h', 'today', '24h', 'week', '7d', '14d', '30d'];
  const presetWindows = {};
  for (const k of presetKeys) {
    presetWindows[k] = resolveTimeWindow(k, 0, 0, nowMs);
  }

  const familyEntries = [];
  if (typeof cacheStore.getCachedTrajectoryEntryByLower === 'function') {
    for (const fidLower of familySet) {
      const hit = cacheStore.getCachedTrajectoryEntryByLower(fidLower);
      const entry = hit?.entry;
      if (!entry || !Array.isArray(entry.steps) || entry.steps.length === 0) continue;
      familyEntries.push({
        cascadeId: hit.id,
        appSource: isRemote ? 'ssh' : entry.appSource || 'standalone',
        steps: entry.steps,
        isCurrentConv: true,
      });
    }
  } else {
    for (const [cid, entry] of cacheStore.listCachedTrajectoryEntries()) {
      if (!entry || !Array.isArray(entry.steps) || entry.steps.length === 0) continue;
      const cidLower = String(cid || '').toLowerCase();
      if (!familySet.has(cidLower)) continue;
      familyEntries.push({
        cascadeId: cid,
        appSource: isRemote ? 'ssh' : entry.appSource || 'standalone',
        steps: entry.steps,
        isCurrentConv: true,
      });
    }
  }

  return computeFamilySessionBuckets({
    entries: familyEntries,
    familySet,
    presetKeys,
    presetWindows,
    selectedWindow,
    resolveStepModel,
  });
}

/**
 * 批量预聚合全部 6 个用量页预设区间（复用同一次条目收集和时间剪枝），供前端进入「用量统计」时静默预取实现 0ms 瞬切。
 */
export function aggregateConsumptionPresetBundle(params) {
  const { activeCascadeId = null, activeFamilyCascadeIds = null, endpoint = null } = params || {};
  const rawFamilyIds =
    activeFamilyCascadeIds instanceof Set
      ? Array.from(activeFamilyCascadeIds)
      : activeCascadeId
        ? [activeCascadeId]
        : [];
  const familySet = new Set(rawFamilyIds.map((id) => String(id || '').toLowerCase()));
  const precollectedEntries = collectUsageEntriesToAggregate(familySet, endpoint);
  const ranges = {};
  let usageRevision = usageSnapshotRevisionSeq;

  const packSlice = (agg) => ({
    selectedRange: {
      key: agg.selectedWindow.key,
      label: agg.selectedWindow.label,
      startMs: agg.trendStartMs,
      endMs: agg.trendEndMs,
    },
    session: agg.finalizedSelectedSession,
    account: agg.finalizedSelectedAccount,
    trendSeries: agg.trendSeries,
    sourcesBreakdown: agg.sourcesBreakdown,
    modelBreakdown: agg.modelBreakdown,
    topConversations: agg.topConversations || [],
    topWorkspaces: agg.topWorkspaces || [],
  });

  for (const rangeKey of CONSUMPTION_PRESET_RANGE_KEYS) {
    const agg = aggregateSelectedWindowUsage({
      ...params,
      filterOpts: { range: rangeKey },
      precollectedEntries,
    });
    usageRevision = agg.usageRevision;
    ranges[rangeKey] = packSlice(agg);
  }

  return { usageRevision, ranges };
}
