/**
 * 请求级 usage 日志（精简版）。
 *
 * 目标：
 * - 发送成功后按「单次请求」落盘 provider/model/token/cost 快照
 * - 给后续统计提供比会话 lifetimeUsage 更细的归因数据
 *
 * 不做：
 * - 不替代会话 lifetimeUsage 账本
 * - 不回填历史 null 绑定
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathOf } from './data-store.mjs';
import { estimateUsageCostUsd } from './usage-stats.mjs';

const DEFAULT_REL = path.join('usage', 'requests.jsonl');

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createUsageRequestLog({
  logFile = pathOf(DEFAULT_REL),
  estimateCost = estimateUsageCostUsd,
} = {}) {
  function ensureParent() {
    const dir = path.dirname(logFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  function append(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const usage = entry.usage || {};
    const pricing = entry.pricing || {};
    const cost = estimateCost(
      {
        inputTokens: finiteNumber(usage.inputTokens),
        outputTokens: finiteNumber(usage.outputTokens),
        cacheReadTokens: finiteNumber(usage.cacheReadTokens),
        cacheWriteTokens: finiteNumber(usage.cacheWriteTokens),
      },
      pricing,
    );

    const record = {
      id: optionalText(entry.id) || `usage_${Date.now()}`,
      at: optionalText(entry.at) || new Date().toISOString(),
      conversationId: optionalText(entry.conversationId),
      streamId: optionalText(entry.streamId),
      modelProviderId: optionalText(entry.modelProviderId),
      model: optionalText(entry.model),
      providerName: optionalText(entry.providerName),
      inputTokens: finiteNumber(usage.inputTokens),
      outputTokens: finiteNumber(usage.outputTokens),
      cacheReadTokens: finiteNumber(usage.cacheReadTokens),
      cacheWriteTokens: finiteNumber(usage.cacheWriteTokens),
      estimatedCostUsd: cost.hasPricing ? cost.estimatedCostUsd : null,
      pricingSource: optionalText(entry.pricingSource),
    };

    ensureParent();
    appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  function readAll({ limit = 5000 } = {}) {
    if (!existsSync(logFile)) return [];
    const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    const start = Math.max(0, lines.length - Math.max(1, Number(limit) || 5000));
    const rows = [];
    for (let i = start; i < lines.length; i += 1) {
      try {
        rows.push(JSON.parse(lines[i]));
      } catch {
        // skip corrupt line
      }
    }
    return rows;
  }

  return {
    logFile,
    append,
    readAll,
  };
}

export function appendUsageRequestLog(entry, options) {
  return createUsageRequestLog(options).append(entry);
}
