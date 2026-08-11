/**
 * 缓存命中率指标体系（稳态/全量双口径 + 渠道分层）。
 *
 * 定义文档：peer-knowledge/knowledge/experience/cache-hit-rate-metrics-design.md
 *
 * 口径：
 * - 全量原始命中率 HR_raw = Σ cacheRead / Σ (cacheRead + input)，全部记录
 * - 稳态命中率 HR_steady = 同上，但仅含"稳态有效轮"：
 *     1) 剔除首写轮（每个 conversationId 的第一条请求）
 *     2) 剔除过期重写轮（距同会话上一条 > STEADY_TTL_MS，默认 5 分钟）
 *     3) 剔除无缓存渠道（providerName 为空或 zeus 前缀，idealab 网关）
 *
 * 展示：整体（双口径）+ 分渠道（稳态）+ 分形态（首写/过期/无缓存/稳态）
 */
import { createUsageRequestLog } from './usage-request-log.mjs';

export const STEADY_TTL_MS = 5 * 60 * 1000; // 服务端缓存 TTL 约 5 分钟

/** 无缓存渠道识别：providerName 为空（TUI 归因缺失）或以 zeus 开头（idealab 网关） */
export function isNoCacheChannel(row) {
  const providerName = typeof row?.providerName === 'string' ? row.providerName.trim() : '';
  return providerName === '' || providerName.startsWith('zeus');
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function emptyBucket() {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** 单条请求的 token 桶 */
export function rowTokenBucket(row) {
  return {
    inputTokens: finiteNumber(row.inputTokens),
    cacheReadTokens: finiteNumber(row.cacheReadTokens),
    cacheWriteTokens: finiteNumber(row.cacheWriteTokens),
  };
}

/** 桶相加 */
export function addTokenBuckets(a, b) {
  return {
    inputTokens: finiteNumber(a?.inputTokens) + finiteNumber(b?.inputTokens),
    cacheReadTokens: finiteNumber(a?.cacheReadTokens) + finiteNumber(b?.cacheReadTokens),
    cacheWriteTokens: finiteNumber(a?.cacheWriteTokens) + finiteNumber(b?.cacheWriteTokens),
  };
}

/** 命中率（token 加权）。分母为 0 返回 null（无有效样本） */
export function hitRate(bucket) {
  const denominator = finiteNumber(bucket?.cacheReadTokens) + finiteNumber(bucket?.inputTokens);
  if (denominator <= 0) return null;
  return finiteNumber(bucket?.cacheReadTokens) / denominator;
}

function gapMs(a, b) {
  const aTime = new Date(a).getTime();
  const bTime = new Date(b).getTime();
  return Number.isFinite(aTime) && Number.isFinite(bTime) ? aTime - bTime : Infinity;
}

/**
 * 按会话分轮分类：首写轮 / 过期重写轮 / 稳态有效轮。
 * @param {Array<object>} rows 已过滤无缓存渠道的记录
 * @returns {{ first: {bucket,count}, expired: {bucket,count}, steady: {bucket,count},
 *             steadyRows: Array<object> }} steadyRows 为稳态有效轮原记录
 */
export function classifyRoundsByConversation(rows) {
  const result = {
    first: { bucket: emptyBucket(), count: 0 },
    expired: { bucket: emptyBucket(), count: 0 },
    steady: { bucket: emptyBucket(), count: 0 },
    steadyRows: [],
  };
  const byConversation = new Map();
  for (const row of rows) {
    const conversationId = typeof row?.conversationId === 'string' ? row.conversationId : '';
    if (!conversationId) continue;
    const list = byConversation.get(conversationId) ?? [];
    list.push(row);
    byConversation.set(conversationId, list);
  }
  for (const list of byConversation.values()) {
    list.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      const bucket = rowTokenBucket(row);
      if (i === 0) {
        result.first.bucket = addTokenBuckets(result.first.bucket, bucket);
        result.first.count += 1;
        continue;
      }
      const gap = gapMs(row?.at, list[i - 1]?.at);
      if (gap > STEADY_TTL_MS) {
        result.expired.bucket = addTokenBuckets(result.expired.bucket, bucket);
        result.expired.count += 1;
      } else {
        result.steady.bucket = addTokenBuckets(result.steady.bucket, bucket);
        result.steady.count += 1;
        result.steadyRows.push(row);
      }
    }
  }
  return result;
}

/**
 * 缓存命中率指标汇总。
 * @param {Array<object>} rows requests.jsonl 请求记录
 * @returns {{ raw, steady, noCache, byForm, byChannel }}
 */
export function computeCacheHitRateMetrics(rows = []) {
  const raw = { bucket: emptyBucket(), count: 0 };
  const noCache = { bucket: emptyBucket(), count: 0 };
  const byChannelRaw = new Map();
  const cacheableRows = [];

  for (const row of rows) {
    const bucket = rowTokenBucket(row);
    raw.bucket = addTokenBuckets(raw.bucket, bucket);
    raw.count += 1;

    if (isNoCacheChannel(row)) {
      noCache.bucket = addTokenBuckets(noCache.bucket, bucket);
      noCache.count += 1;
      continue;
    }
    cacheableRows.push(row);

    const channelKey = `${row?.providerName ?? '?'}/${row?.model ?? '?'}`;
    let channel = byChannelRaw.get(channelKey);
    if (!channel) {
      channel = {
        key: channelKey,
        providerName: row?.providerName ?? '?',
        model: row?.model ?? '?',
        bucket: emptyBucket(),
        count: 0,
      };
      byChannelRaw.set(channelKey, channel);
    }
    channel.bucket = addTokenBuckets(channel.bucket, bucket);
    channel.count += 1;
  }

  // 稳态口径：剔除首写/过期/无缓存后的记录
  const rounds = classifyRoundsByConversation(cacheableRows);
  const steady = {
    count: rounds.steady.count,
    bucket: rounds.steady.bucket,
    hitRate: hitRate(rounds.steady.bucket),
  };

  // 分渠道（稳态口径）
  const byChannelSteady = new Map();
  for (const row of rounds.steadyRows) {
    const channelKey = `${row?.providerName ?? '?'}/${row?.model ?? '?'}`;
    let channel = byChannelSteady.get(channelKey);
    if (!channel) {
      channel = { bucket: emptyBucket(), count: 0 };
      byChannelSteady.set(channelKey, channel);
    }
    channel.bucket = addTokenBuckets(channel.bucket, rowTokenBucket(row));
    channel.count += 1;
  }

  const byChannelOut = [];
  for (const channel of byChannelRaw.values()) {
    const steadyChannel = byChannelSteady.get(channel.key);
    byChannelOut.push({
      providerName: channel.providerName,
      model: channel.model,
      count: channel.count,
      inputTokens: channel.bucket.inputTokens,
      cacheReadTokens: channel.bucket.cacheReadTokens,
      rawHitRate: hitRate(channel.bucket),
      steadyHitRate: steadyChannel ? hitRate(steadyChannel.bucket) : null,
      steadyCount: steadyChannel?.count ?? 0,
    });
  }
  byChannelOut.sort((a, b) => b.inputTokens - a.inputTokens);

  return {
    raw: {
      count: raw.count,
      bucket: raw.bucket,
      hitRate: hitRate(raw.bucket),
    },
    steady,
    noCache: {
      count: noCache.count,
      bucket: noCache.bucket,
      hitRate: hitRate(noCache.bucket),
    },
    byForm: {
      first: { count: rounds.first.count, bucket: rounds.first.bucket, hitRate: hitRate(rounds.first.bucket) },
      expired: { count: rounds.expired.count, bucket: rounds.expired.bucket, hitRate: hitRate(rounds.expired.bucket) },
      steady,
    },
    byChannel: byChannelOut,
  };
}

/** 从请求日志读取并计算（供 CLI / 统计复用） */
export function collectCacheHitRateMetrics({ usageRequestLog = null } = {}) {
  const log = usageRequestLog || createUsageRequestLog();
  const requests = log.readAll({ limit: 200_000 });
  return computeCacheHitRateMetrics(requests);
}

/** 格式化命中率指标为可读文本（对外展示/诊断用） */
export function formatCacheHitRateMetrics(metrics) {
  const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const lines = [];
  lines.push('── 缓存命中率（双口径）────────────────────────');
  lines.push(`全量原始命中率  ${pct(metrics.raw.hitRate)}  (n=${metrics.raw.count}, 含首写/过期/无缓存)`);
  lines.push(`稳态命中率      ${pct(metrics.steady.hitRate)}  (n=${metrics.steady.count}, 剔除首写/过期/无缓存)`);
  lines.push('');
  lines.push('── 分形态 ──────────────────────────────────────');
  lines.push(`首写轮   ${pct(metrics.byForm.first.hitRate)}  (n=${metrics.byForm.first.count})`);
  lines.push(`过期轮   ${pct(metrics.byForm.expired.hitRate)}  (n=${metrics.byForm.expired.count})`);
  lines.push(`稳态轮   ${pct(metrics.byForm.steady.hitRate)}  (n=${metrics.byForm.steady.count})`);
  lines.push(`无缓存渠道 ${pct(metrics.noCache.hitRate)}  (n=${metrics.noCache.count})`);
  lines.push('');
  lines.push('── 分渠道（稳态口径，按 input 降序）────────────');
  for (const c of metrics.byChannel) {
    const steady = c.steadyHitRate === null ? 'n/a' : pct(c.steadyHitRate);
    lines.push(`${c.providerName}/${c.model}  steady=${steady}  raw=${pct(c.rawHitRate)}  (n=${c.count}, input=${(c.inputTokens / 1e6).toFixed(1)}M)`);
  }
  return lines.join('\n');
}
