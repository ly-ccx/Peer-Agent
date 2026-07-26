import {
  createContextAccountingCompactionPipeline,
  parseContextOverflowEvidence,
} from '@peer-agent/runtime-core';
import { contextAccountingModelKey } from '@peer-agent/protocol';
import {
  applyMicrocompaction,
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
  runtimeUsageAccounting = null,
  rebuildSystemPrompt = null,
  force = false,
  emergency = false,
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
    runtimeUsageAccounting,
    rebuildSystemPrompt,
    force,
    emergency,
  });

  const effectiveMessages = Array.isArray(compaction.messages)
    ? compaction.messages
    : sourceMessages;
  return Object.freeze({
    ...compaction,
    compaction,
    messages: effectiveMessages,
  });
}

/**
 * Desktop provider 请求的共享执行入口。
 *
 * runtime-core 拥有 build -> count/observe -> decide -> compact -> rebuild ->
 * send -> observe -> overflow retry 的状态机；这里仅适配 Desktop 的消息形态、
 * compactor 与 provider transport。
 */
export async function executeDesktopProviderRequest({
  request,
  send,
  compactRequest = coordinateDesktopProviderRequest,
  getUsage = (response) => response?.streamUsage ?? null,
  buildCanonicalRequest = ({ messages, systemPrompt, tools, model }) => ({
    messages,
    systemPrompt,
    tools,
    model,
  }),
}) {
  const sourceMessages = Array.isArray(request?.messages) ? request.messages : [];
  const sourceSystemPrompt = typeof request?.systemPrompt === 'string'
    ? request.systemPrompt
    : '';
  const pipeline = createContextAccountingCompactionPipeline({
    identity: request?.accountingIdentity ?? {
      conversationId: request?.conversationId || request?.streamId || 'desktop',
      contentRevision: 0,
      modelKey: contextAccountingModelKey(
        request?.providerConfig?.providerId ?? request?.providerConfig?.id,
        request?.providerConfig?.model,
      ),
    },
    contextWindow: request?.contextWindow,
    countCapability: request?.countCapability ?? { kind: 'observed_usage_only' },
    initialSnapshot: request?.initialContextAccounting,
    countRequest: request?.countRequest,
    onSnapshot: request?.onContextAccounting,
    buildRequest(state) {
      const projectedMessages = applyMicrocompaction(state.messages, { log: () => {} }).messages;
      return buildCanonicalRequest({
        messages: projectedMessages,
        systemPrompt: state.systemPrompt,
        tools: request?.tools ?? null,
        model: request?.providerConfig?.model ?? null,
      });
    },
    async compact({ state, reason, emergency }) {
      const result = await compactRequest({
        ...request,
        messages: state.messages,
        systemPrompt: state.systemPrompt,
        usageSnapshot: null,
        force: true,
        emergency: emergency || reason === 'provider_overflow',
      });
      if (!result?.compacted) return { compacted: false, state };
      return {
        compacted: true,
        state: {
          messages: Array.isArray(result.messages) ? result.messages : state.messages,
          systemPrompt:
            typeof result.systemPrompt === 'string' && result.systemPrompt.trim()
              ? result.systemPrompt
              : state.systemPrompt,
        },
      };
    },
    send,
    getUsage,
    onProviderRequest: request?.onProviderRequest,
    getOverflow(response) {
      if (response?.ok !== false) return null;
      return parseContextOverflowEvidence({
        status: response.status,
        errorText: response.errorText ?? '',
      });
    },
  });
  const accounting = await pipeline.execute({
    state: {
      messages: sourceMessages,
      systemPrompt: sourceSystemPrompt,
    },
  });
  const finalMessages = accounting.state.messages;
  const projectedMessages = accounting.request.messages;
  return Object.freeze({
    ...accounting,
    response: accounting.response,
    messages: finalMessages,
    systemPrompt: accounting.state.systemPrompt,
    projectedMessages,
  });
}
