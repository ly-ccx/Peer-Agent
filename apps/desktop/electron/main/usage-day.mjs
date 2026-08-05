/**
 * 请求日志按天详情聚合（点击热力图 / 日条某一天后的下钻数据源）。
 *
 * 数据源：usage/requests.jsonl（请求级 at + tokens + modelProviderId / model）
 * 输出：某一天的汇总 + 按模型拆分（byModel）+ 24 小时分布（hours）。
 * 不做：不从会话 lifetimeUsage 反推历史天粒度（与 usage-daily.mjs 同源同约定）。
 */

import { createUsageRequestLog } from './usage-request-log.mjs';
import { toLocalDateKey } from './usage-daily.mjs';

export const UNBOUND_MODEL_KEY = 'unbound';

const HOUR_COUNT = 24;
const READ_LIMIT = 200_000;

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function emptyTokenBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    requestCount: 0,
  };
}

function isValidDateKey(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function rowModelKey(row) {
  return typeof row.modelProviderId === 'string' && row.modelProviderId.trim()
    ? row.modelProviderId.trim()
    : UNBOUND_MODEL_KEY;
}

/**
 * 从 llmConfigStore 的 provider 列表构建 modelProviderId → 可读 label 的索引。
 * qoder 等渠道的请求日志只写模型条目 UUID + 内部 id（如 cmodel），
 * 可读 label 在配置条目（modelLabel）里，与 usage-stats 的 providerIndex 同源。
 */
function buildModelLabelIndex(providers) {
  const index = new Map();
  for (const provider of providers || []) {
    if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) continue;
    const label = typeof provider.modelLabel === 'string' && provider.modelLabel.trim()
      ? provider.modelLabel.trim()
      : (typeof provider.model === 'string' && provider.model.trim() ? provider.model.trim() : provider.id.trim());
    index.set(provider.id.trim(), label);
  }
  return index;
}

function rowModelLabel(row, labelIndex) {
  const providerId = typeof row.modelProviderId === 'string' && row.modelProviderId.trim()
    ? row.modelProviderId.trim()
    : '';
  if (providerId && labelIndex) {
    const configuredLabel = labelIndex.get(providerId);
    if (configuredLabel) return configuredLabel;
  }
  const model = typeof row.model === 'string' && row.model.trim() ? row.model.trim() : '';
  if (model) return model;
  const provider = typeof row.providerName === 'string' && row.providerName.trim()
    ? row.providerName.trim()
    : '';
  if (provider) return provider;
  return rowModelKey(row);
}

function hasCost(row) {
  return row.estimatedCostUsd != null && Number.isFinite(Number(row.estimatedCostUsd));
}

function costOf(row) {
  return hasCost(row) ? Number(row.estimatedCostUsd) : 0;
}

function providerRequestWeight(row) {
  return Math.max(1, Math.floor(finiteNumber(row.providerRequestCount) || 1));
}

function sortModelRows(rows) {
  return [...rows].sort((a, b) => {
    const costA = a.estimatedCostUsd == null ? -1 : a.estimatedCostUsd;
    const costB = b.estimatedCostUsd == null ? -1 : b.estimatedCostUsd;
    if (costB !== costA) return costB - costA;
    if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
    return String(a.label).localeCompare(String(b.label));
  });
}

/**
 * @param {object} options
 * @param {readonly object[]} [options.rows]
 * @param {string} [options.date] 目标日，YYYY-MM-DD（本地时区日历日，与 usage-daily 的日期键一致）。
 * @param {Date|string|number} [options.now]
 */
export function buildUsageDaySnapshot({
  rows = [],
  date,
  now = new Date(),
  labelIndex = null,
} = {}) {
  const end = now instanceof Date ? now : new Date(now);
  const safeNow = Number.isNaN(end.getTime()) ? new Date() : end;
  const targetDate = isValidDateKey(date) ? date : null;

  const byModel = new Map();
  const hours = Array.from({ length: HOUR_COUNT }, (_, hour) => ({
    hour,
    ...emptyTokenBucket(),
  }));

  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    requestCount: 0,
    pricedRequestCount: 0,
    estimatedCostUsd: 0,
    hasAnyCost: false,
    modelCount: 0,
  };

  if (targetDate) {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const rowDate = toLocalDateKey(row.at, safeNow);
      if (!rowDate || rowDate !== targetDate) continue;

      const inputTokens = finiteNumber(row.inputTokens);
      const outputTokens = finiteNumber(row.outputTokens);
      const cacheReadTokens = finiteNumber(row.cacheReadTokens);
      const cacheWriteTokens = finiteNumber(row.cacheWriteTokens);
      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
      const weight = providerRequestWeight(row);
      const priced = hasCost(row);
      const cost = costOf(row);

      totals.inputTokens += inputTokens;
      totals.outputTokens += outputTokens;
      totals.cacheReadTokens += cacheReadTokens;
      totals.cacheWriteTokens += cacheWriteTokens;
      totals.totalTokens += totalTokens;
      totals.requestCount += weight;
      if (priced) {
        totals.pricedRequestCount += weight;
        totals.estimatedCostUsd += cost;
        totals.hasAnyCost = true;
      }

      // 按模型拆分。
      const modelKey = rowModelKey(row);
      let modelBucket = byModel.get(modelKey);
      if (!modelBucket) {
        modelBucket = {
          key: modelKey,
          label: rowModelLabel(row, labelIndex),
          modelProviderId: modelKey === UNBOUND_MODEL_KEY ? null : modelKey,
          providerName: typeof row.providerName === 'string' && row.providerName.trim()
            ? row.providerName.trim()
            : null,
          ...emptyTokenBucket(),
          estimatedCostUsd: null,
          hasCost: false,
        };
        byModel.set(modelKey, modelBucket);
      }
      modelBucket.inputTokens += inputTokens;
      modelBucket.outputTokens += outputTokens;
      modelBucket.cacheReadTokens += cacheReadTokens;
      modelBucket.cacheWriteTokens += cacheWriteTokens;
      modelBucket.totalTokens += totalTokens;
      modelBucket.requestCount += weight;
      if (priced) {
        modelBucket.hasCost = true;
        modelBucket.estimatedCostUsd = (modelBucket.estimatedCostUsd || 0) + cost;
      }

      // 24 小时分布（本地时区小时，与日期键同源）。
      const at = new Date(row.at);
      const hour = Number.isNaN(at.getTime()) ? 0 : at.getHours();
      const hourBucket = hours[hour];
      if (hourBucket) {
        hourBucket.inputTokens += inputTokens;
        hourBucket.outputTokens += outputTokens;
        hourBucket.cacheReadTokens += cacheReadTokens;
        hourBucket.cacheWriteTokens += cacheWriteTokens;
        hourBucket.totalTokens += totalTokens;
        hourBucket.requestCount += weight;
      }
    }
  }

  const byModelList = sortModelRows(
    [...byModel.values()].map((bucket) => ({
      ...bucket,
      estimatedCostUsd: bucket.hasCost ? bucket.estimatedCostUsd : null,
    })),
  );

  const activeHours = hours.filter((h) => h.totalTokens > 0 || h.requestCount > 0).length;
  const maxHourTokens = hours.reduce((max, h) => Math.max(max, h.totalTokens), 0);

  return {
    date: targetDate,
    source: 'request-log',
    totals: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      totalTokens: totals.totalTokens,
      requestCount: totals.requestCount,
      pricedRequestCount: totals.pricedRequestCount,
      estimatedCostUsd: totals.hasAnyCost ? totals.estimatedCostUsd : null,
      modelCount: byModelList.length,
      activeHourCount: activeHours,
      maxHourTokens,
    },
    byModel: byModelList,
    hours,
    notes: {
      emptyDay: !targetDate || (totals.totalTokens === 0 && totals.requestCount === 0),
      scope: 'request-log-only',
    },
  };
}

export function collectUsageDay({
  date,
  now = new Date(),
  usageRequestLog = createUsageRequestLog(),
  llmConfigStore = null,
} = {}) {
  const rows = usageRequestLog.readAll({ limit: READ_LIMIT });
  const providers = llmConfigStore?.listProviders ? llmConfigStore.listProviders() : [];
  const labelIndex = buildModelLabelIndex(providers);
  return buildUsageDaySnapshot({ rows, date, now, labelIndex });
}
