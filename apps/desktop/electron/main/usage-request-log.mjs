/**
 * Runtime-turn usage 日志（精简版）。
 *
 * 目标：
 * - 发送成功后按「一次用户 Runtime turn」落盘 provider/model/token/cost 快照
 * - 给后续统计提供比会话 lifetimeUsage 更细的归因数据
 *
 * 不做：
 * - 不替代会话 lifetimeUsage 账本
 * - 不回填历史 null 绑定
 */

import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import path from 'node:path';
import { pathOf } from './data-store.mjs';
import { estimateUsageCostUsd } from './usage-pricing.mjs';

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// 统计分组键：优先用写入方解析好的渠道 groupId；否则尝试从复合 id 拆回 groupId。
// 裸 uuid 不在这里猜，留给聚合层用 provider 索引归组，历史行无 groupId 时回退原值。
function resolveGroupId(entry) {
  const explicit = optionalText(entry.groupId);
  if (explicit) return explicit;
  const modelProviderId = optionalText(entry.modelProviderId);
  if (modelProviderId && modelProviderId.includes('::')) {
    const groupId = modelProviderId.slice(0, modelProviderId.indexOf('::')).trim();
    if (groupId) return groupId;
  }
  return null;
}

export function createUsageRequestLog({
  logFile = pathOf('usageRequests'),
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
      groupId: resolveGroupId(entry),
      model: optionalText(entry.model),
      providerName: optionalText(entry.providerName),
      usageScope: 'runtime_turn',
      providerRequestCount: Math.max(
        1,
        Math.floor(finiteNumber(entry.providerRequestCount || usage.providerRequestCount) || 1),
      ),
      inputTokens: finiteNumber(usage.inputTokens),
      outputTokens: finiteNumber(usage.outputTokens),
      cacheReadTokens: finiteNumber(usage.cacheReadTokens),
      cacheWriteTokens: finiteNumber(usage.cacheWriteTokens),
      estimatedCostUsd: cost.hasPricing ? cost.estimatedCostUsd : null,
      pricingSource: optionalText(entry.pricingSource),
      ...(optionalText(entry.role) ? { role: optionalText(entry.role) } : {}),
      ...(optionalText(entry.workspaceId) ? { workspaceId: optionalText(entry.workspaceId) } : {}),
    };

    ensureParent();
    appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  function readAll({ limit = 5000 } = {}) {
    if (!existsSync(logFile)) return [];
    const lines = readUsageTail(logFile, Math.max(1, Math.min(50000, Math.floor(Number(limit) || 5000))));
    const start = Math.max(0, lines.length - Math.max(1, Math.min(50000, Math.floor(Number(limit) || 5000))));
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

/** Bounded tail I/O: old logs must not block every settings read as they grow. */
function readUsageTail(file, limit) {
  const fd = openSync(file, 'r');
  try {
    let position = fstatSync(fd).size, bytes = 0, newlines = 0;
    const chunks = [], maxBytes = 8 * 1024 * 1024;
    while (position > 0 && bytes < maxBytes && newlines <= limit) {
      const size = Math.min(64 * 1024, position, maxBytes - bytes);
      const chunk = Buffer.allocUnsafe(size);
      position -= size;
      const count = readSync(fd, chunk, 0, size, position);
      const read = chunk.subarray(0, count);
      for (const byte of read) if (byte === 10) newlines += 1;
      chunks.unshift(read); bytes += count;
      if (count < size) break;
    }
    const lines = Buffer.concat(chunks).toString('utf8').split('\n');
    if (position > 0) lines.shift(); // Discard the incomplete first record.
    return lines.filter(Boolean);
  } finally { closeSync(fd); }
}
