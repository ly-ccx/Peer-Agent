import { createContextProjectionLifecycle } from '@peer-agent/runtime-core';
import {
  applyMicrocompaction,
  computeContextInfo,
  isPromptTooLongResponse,
  runCompactionCheck,
} from './compaction-coordinator.mjs';

/**
 * Desktop provider 请求前的唯一协调入口。
 *
 * 所有 provider loop 都必须在真正调用传输 adapter 前经过这里。压缩判定和
 * request_preflight 投影因此读取同一份 Runtime messages/tools/contextWindow；
 * provider 只负责把压缩结果映射回自身的 system/messages 形态。
 */
export async function coordinateDesktopProviderRequest({
  messages,
  systemPrompt,
  contextWindow,
  providerConfig,
  signal,
  persistCompaction,
  conversationId,
  streamId,
  webContents,
  continuityContext = [],
  tools = null,
  preserveLatestUserTurn = true,
  usageSnapshot = null,
  rebuildSystemPrompt = null,
  force = false,
  emergency = false,
  // 21 号文档第十三章：优先复用 kernel 的 per-turn 生命周期，使同一 turn 内
  // preflight / post_compaction / tool_result / turn_complete 共用单调 revision。
  // 未注入时回退临时实例（仅供返回值，不对外发布）。
  contextLifecycle = null,
}) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const compaction = await runCompactionCheck({
    messages: sourceMessages,
    systemPrompt,
    contextWindow,
    providerConfig,
    signal,
    persistCompaction,
    conversationId,
    streamId,
    webContents,
    continuityContext,
    tools,
    preserveLatestUserTurn,
    usageSnapshot,
    rebuildSystemPrompt,
    force,
    emergency,
  });

  const effectiveMessages = Array.isArray(compaction.messages)
    ? compaction.messages
    : sourceMessages;
  const projectedMessages = applyMicrocompaction(effectiveMessages, { log: () => {} }).messages;
  const contextInfo = computeContextInfo({
    messages: effectiveMessages,
    displayMessages: projectedMessages,
    contextWindow,
    tools,
    usageSnapshot,
  });
  const lifecycle = contextLifecycle ?? createContextProjectionLifecycle();
  const projectionInput = {
    messages: projectedMessages,
    tools,
    contextWindow,
    currentInputTokens: contextInfo.lastActualInputTokens,
  };
  // 压缩刚完成时先发 post_compaction 稳定投影（回落信号），再发本次请求的
  // request_preflight；未压缩时只发 request_preflight。
  if (compaction.compacted) {
    lifecycle.postCompaction({ ...projectionInput, reason: 'post_compaction' });
  }
  const projection = lifecycle.requestPreflight({
    ...projectionInput,
    reason: compaction.compacted
      ? 'post_compaction_request_preflight'
      : compaction.microcompacted
        ? 'post_microcompaction_request_preflight'
        : 'request_preflight',
  });

  return Object.freeze({
    ...compaction,
    compaction,
    messages: effectiveMessages,
    projectedMessages,
    contextInfo,
    projection,
  });
}

/**
 * 统一的 prompt-too-long 分类 + emergency 压缩重试策略（同一请求最多重试一次）。
 * 各 provider loop 在 providerResponse 失败时调用，不再各自复制分类与 emergency 块；
 * loop 只负责把返回的压缩后 messages/systemPrompt 映射回自身形态。
 *
 * 返回：
 * - { promptTooLong: false }                          —— 非 PTL 错误，loop 走自己的错误分支；
 * - { promptTooLong: true, retried: false }           —— PTL 但不可重试（已重试过 / 压不动）；
 * - { promptTooLong: true, retried: true, messages, systemPrompt } —— 已 emergency 压缩，应 continue 重试。
 */
export async function recoverFromPromptTooLong({
  status,
  errorText,
  retryUsed = false,
  request,
}) {
  if (!isPromptTooLongResponse(status, errorText)) {
    return { promptTooLong: false, retried: false };
  }
  if (retryUsed) {
    return { promptTooLong: true, retried: false };
  }
  const emergencyCompaction = await coordinateDesktopProviderRequest({
    ...request,
    emergency: true,
    force: true,
  });
  if (!emergencyCompaction.compacted) {
    return { promptTooLong: true, retried: false };
  }
  return {
    promptTooLong: true,
    retried: true,
    messages: emergencyCompaction.messages,
    systemPrompt:
      typeof emergencyCompaction.systemPrompt === 'string' && emergencyCompaction.systemPrompt.trim()
        ? emergencyCompaction.systemPrompt
        : null,
  };
}
