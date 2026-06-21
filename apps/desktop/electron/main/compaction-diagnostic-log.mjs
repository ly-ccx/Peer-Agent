/**
 * Compaction Diagnostic Log — 压缩诊断日志（临时排障用）
 *
 * 目的：在不改变压缩控制流的前提下，把「LLM 摘要为什么失败 / 为什么降级」
 * 这件事落成可持久化、可读取的结构化日志，便于复现后定位真实根因。
 *
 * 落点：~/.peer-agent/logs/compaction-diagnostic.log（每行一条 JSON）。
 *
 * 设计约束：
 * - 纯旁路（best-effort）：任何写日志失败都必须被吞掉，绝不影响主流程。
 * - 不泄露密钥：apiKey 一律脱敏，只保留可辨识的尾部指纹。
 * - 同步追加：压缩属低频事件，写入量极小，用 appendFileSync 保证次序与可见性。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getDataHome } from './data-store.mjs';

const LOG_REL = path.join('logs', 'compaction-diagnostic.log');

/** 脱敏 apiKey：仅保留长度与尾 4 位指纹，避免明文落盘。 */
function maskApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
  const tail = apiKey.slice(-4);
  return `***${tail}(len=${apiKey.length})`;
}

/** 从 providerConfig 中提取可安全记录的字段（脱敏 apiKey）。 */
function describeProvider(providerConfig) {
  if (!providerConfig || typeof providerConfig !== 'object') return null;
  return {
    provider: providerConfig.provider ?? null,
    model: providerConfig.model ?? null,
    baseUrl: providerConfig.baseUrl ?? null,
    apiKey: maskApiKey(providerConfig.apiKey),
  };
}

/**
 * 追加一条诊断日志。
 *
 * @param {string} phase  阶段标签，如 'summarize:enter' / 'readstream:error' / 'compact:catch'
 * @param {object} [fields]  额外结构化字段（会原样 JSON 序列化）；若包含 providerConfig 会被脱敏后展开。
 */
export function logCompactionDiagnostic(phase, fields = {}) {
  try {
    const { providerConfig, ...rest } = fields ?? {};
    const entry = {
      ts: new Date().toISOString(),
      phase,
      ...(providerConfig ? { provider: describeProvider(providerConfig) } : {}),
      ...rest,
    };
    const home = getDataHome();
    const logPath = path.join(home, LOG_REL);
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // 旁路日志失败绝不影响主流程
  }
}

export { LOG_REL as COMPACTION_DIAGNOSTIC_LOG_REL };
