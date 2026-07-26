/**
 * 请求日志按天聚合（Token 热力图 / 趋势图数据源）。
 *
 * 数据源：usage/requests.jsonl（请求级 at + tokens）
 * 范围：7d / 1m / 3m / 6m / 1y（默认 1m）
 * 不做：不从会话 lifetimeUsage 反推历史天粒度。
 */

import { createUsageRequestLog } from './usage-request-log.mjs';

export const USAGE_DAILY_RANGES = Object.freeze(['7d', '1m', '3m', '6m', '1y']);
export const DEFAULT_USAGE_DAILY_RANGE = '1m';

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地日历日 YYYY-MM-DD */
export function toLocalDateKey(input, now = new Date()) {
  const d = input instanceof Date ? input : new Date(input ?? now);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function rangeStartDate(end, range) {
  const endDay = startOfLocalDay(end);
  switch (range) {
    case '7d':
      return addLocalDays(endDay, -6);
    case '1m':
      return addLocalDays(endDay, -29);
    case '3m':
      return addLocalDays(endDay, -89);
    case '6m':
      return addLocalDays(endDay, -179);
    case '1y':
    default:
      return addLocalDays(endDay, -364);
  }
}

export function normalizeUsageDailyRange(range) {
  if (USAGE_DAILY_RANGES.includes(range)) return range;
  return DEFAULT_USAGE_DAILY_RANGE;
}

function emptyDay(dateKey) {
  return {
    date: dateKey,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    requestCount: 0,
    estimatedCostUsd: 0,
    hasCost: false,
  };
}

function buildDaySeries(start, end) {
  const days = [];
  let cursor = startOfLocalDay(start);
  const last = startOfLocalDay(end);
  while (cursor.getTime() <= last.getTime()) {
    days.push(emptyDay(toLocalDateKey(cursor)));
    cursor = addLocalDays(cursor, 1);
  }
  return days;
}

/**
 * @param {object} options
 * @param {readonly object[]} [options.rows]
 * @param {'7d'|'1m'|'3m'|'6m'|'1y'} [options.range]
 * @param {Date|string|number} [options.now]
 */
export function buildUsageDailySnapshot({
  rows = [],
  range = DEFAULT_USAGE_DAILY_RANGE,
  now = new Date(),
} = {}) {
  const resolvedRange = normalizeUsageDailyRange(range);
  const end = now instanceof Date ? now : new Date(now);
  const safeEnd = Number.isNaN(end.getTime()) ? new Date() : end;
  const start = rangeStartDate(safeEnd, resolvedRange);
  const series = buildDaySeries(start, safeEnd);
  const byDate = new Map(series.map((day) => [day.date, day]));

  let requestCount = 0;
  let pricedRequestCount = 0;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const dateKey = toLocalDateKey(row.at, safeEnd);
    if (!dateKey) continue;
    const bucket = byDate.get(dateKey);
    if (!bucket) continue;

    const inputTokens = finiteNumber(row.inputTokens);
    const outputTokens = finiteNumber(row.outputTokens);
    const cacheReadTokens = finiteNumber(row.cacheReadTokens);
    const cacheWriteTokens = finiteNumber(row.cacheWriteTokens);
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

    bucket.inputTokens += inputTokens;
    bucket.outputTokens += outputTokens;
    bucket.cacheReadTokens += cacheReadTokens;
    bucket.cacheWriteTokens += cacheWriteTokens;
    bucket.totalTokens += totalTokens;
    const providerRequestCount = Math.max(
      1,
      Math.floor(finiteNumber(row.providerRequestCount) || 1),
    );
    bucket.requestCount += providerRequestCount;
    requestCount += providerRequestCount;

    if (row.estimatedCostUsd != null && Number.isFinite(Number(row.estimatedCostUsd))) {
      bucket.estimatedCostUsd += Number(row.estimatedCostUsd);
      bucket.hasCost = true;
      pricedRequestCount += providerRequestCount;
    }
  }

  const days = series.map((day) => ({
    date: day.date,
    inputTokens: day.inputTokens,
    outputTokens: day.outputTokens,
    cacheReadTokens: day.cacheReadTokens,
    cacheWriteTokens: day.cacheWriteTokens,
    totalTokens: day.totalTokens,
    requestCount: day.requestCount,
    estimatedCostUsd: day.hasCost ? day.estimatedCostUsd : null,
  }));

  let maxTokens = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let hasAnyCost = false;
  for (const day of days) {
    totalTokens += day.totalTokens;
    if (day.totalTokens > maxTokens) maxTokens = day.totalTokens;
    if (day.estimatedCostUsd != null) {
      estimatedCostUsd += day.estimatedCostUsd;
      hasAnyCost = true;
    }
  }

  return {
    range: resolvedRange,
    startDate: toLocalDateKey(start),
    endDate: toLocalDateKey(safeEnd),
    source: 'request-log',
    days,
    totals: {
      totalTokens,
      requestCount,
      pricedRequestCount,
      estimatedCostUsd: hasAnyCost ? estimatedCostUsd : null,
      maxTokens,
      dayCount: days.length,
      activeDayCount: days.filter((d) => d.totalTokens > 0 || d.requestCount > 0).length,
    },
    notes: {
      emptyLog: rows.length === 0,
      scope: 'request-log-only',
    },
  };
}

export function collectUsageDaily({
  range = DEFAULT_USAGE_DAILY_RANGE,
  now = new Date(),
  usageRequestLog = createUsageRequestLog(),
} = {}) {
  // 热力图最多约 365 天；读多一点避免旧日志被截断导致边界天缺数。
  const rows = usageRequestLog.readAll({ limit: 200_000 });
  return buildUsageDailySnapshot({ rows, range, now });
}
