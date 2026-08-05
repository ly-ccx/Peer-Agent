import {
  buildAnthropicTools,
  buildAnthropicToolsFromModelProjection,
  buildOpenAITools,
  buildOpenAIToolsFromModelProjection,
  buildSystemContext,
  buildSystemPrompt,
  createRuntimeToolProjection,
  renderSystemContext,
} from './llm-prompts.mjs';
import { contextAccountingModelKey } from '@peer-agent/protocol';
import { reprojectContextAccountingWindow } from '@peer-agent/runtime-core';
import {
  normalizeAnthropicMessages,
  normalizeOpenAIMessages,
} from './provider-encoders/index.mjs';
import { agentLoopAnthropic } from './chat-runtime/anthropic-agent-loop.mjs';
import { agentLoopGemini } from './chat-runtime/gemini-agent-loop.mjs';
import { agentLoopOpenAI } from './chat-runtime/openai-agent-loop.mjs';
import { agentLoopQoder } from './chat-runtime/qoder-agent-loop.mjs';
import { joinSummaryThinkingContent } from './thinking-summary-join.mjs';
import { sanitizeApiMessages } from './chat-runtime/message-sanitizer.mjs';
import { createChatPermissionGate } from './chat-runtime/permission-gate.mjs';
import { resolveActiveGoalExecutionBinding } from './chat-runtime/goal-mode-gate.mjs';
import {
  createProviderAttemptStream,
  describeFetchFailure,
  describeProviderTarget,
  orderProviderCandidates,
  resolveConversationModelBindingPatch,
} from './chat-runtime/provider-recovery-broker.mjs';
import { hasUnsupportedToolClaim } from './chat-runtime/response-guard.mjs';
import { createDesktopRuntimeSessionAdapter } from './chat-runtime/runtime-session-adapter.mjs';
import { createToolContext } from './chat-runtime/tool-orchestrator.mjs';
import {
  getProviderCredentialErrorCode,
  resolveProviderCredential,
} from './provider-credential-resolver.mjs';
import { resolveChannel } from './provider-channels.mjs';
import {
  processTrailingUserImages,
  readFallbackVisionProviderId,
  recognizeImagesWithFallbackProvider,
} from './chat-runtime/fallback-vision.mjs';
import { resolveGeminiCodeAssistProjectId } from './subscription-quota.mjs';
import { fetchWithConnectionRecovery } from './provider-transports/recovering-fetch.mjs';
import { getQoderModelMetadata, resolveQoderModelOptionProjection } from './provider-adapters/qoder-model-catalog.mjs';
import { detectTailRepetition } from './repetition-detector.mjs';
import { createUsageRequestLog } from './usage-request-log.mjs';
import { estimateUsageCostUsd } from './usage-stats.mjs';
import { resolveConversationModelProviderId } from './conversation-model-binding.mjs';

const activeStreams = new Map();
const usageRequestLog = createUsageRequestLog();

const permissionGate = createChatPermissionGate({ activeStreams });
const conversationToolContexts = new Map();
let activeWorkspacePath = null;

// (a) 同 provider 流读取早期中断的自动重试退避。
//
// 注意：传输层 recovering-fetch 已经对「连接阶段」的瞬态失败做了自己的有界退避
// （含 connect-timeout 兜底）。如果这里再复用传输层那一整组延迟，两层会相乘叠加，
// 首发一旦失败用户要干等很久——这正是「第一次调用卡住」的主因之一。
// 因此本层只负责「连接已建立、但流读取早期被掐断」(replay-safe) 的重试，使用独立的
// 短而有界的快速退避（首轮快速重试 + 有界总时长 ~5s），与传输层退避解耦，避免乘积。
const SAME_PROVIDER_RETRY_DELAYS_MS = [500, 1_500, 3_000];

// 流终结后保留 streamRecord 的时长。done/error/aborted 后不立即删除记录，而是标记
// terminal 并保留一段时间，使「切回已结束的后台轮次」仍能通过 reattach 回放完整终态
// 快照（正文/segments/interrupted/usage）。保留期满后才硬删除，释放内存。
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

// 可被用户 abort 打断的退避等待：abort 时以 AbortError 拒绝，沿用既有
// AbortError -> chat:stream:aborted 的结构化取消路径。
function sleepWithSignal(ms, signal) {
  const makeAbortError = () => {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
  };
  if (signal?.aborted) return Promise.reject(makeAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(makeAbortError());
    }, { once: true });
  });
}

function buildRuntimeTools({ mcpRegistry, providerType, mode }) {
  // mode 作为运行时事实下传到 Runtime Projection，模式隔离工具暴露（ADR 35）。
  const { registry, projection, modelProjection } = createRuntimeToolProjection({
    mcpRegistry,
    projectionOptions: { mode },
  });
  const tools = providerType === 'anthropic'
    ? buildAnthropicToolsFromModelProjection(modelProjection)
    : buildOpenAIToolsFromModelProjection(modelProjection);
  return { registry, runtimeProjection: projection, tools };
}

export { buildAnthropicTools, buildOpenAITools, buildSystemPrompt };
// restored 重投影(21 号文档 13.3)需要按模式投影工具 schema,导出供 main 复用。
export { buildRuntimeTools };
export { normalizeAnthropicMessages, normalizeOpenAIMessages };
export { hasUnsupportedToolClaim };
export { finalizeDanglingToolSegments, terminalDanglingNote };
export { sanitizeApiMessages };
export { resolveRunWorkspacePath };

/**
 * 解析「本轮运行的工作根目录」。一轮 agent 运行的 cwd / 系统上下文以「该会话绑定的
 * workspacePath」为唯一真值，不再依赖全局可变的 activeWorkspacePath，从根上消除
 * 「新用户首条消息跑错根目录」这一类全局态滞后导致的 bug。兜底链（按优先级）：
 *   B1 主真值：按 conversationId 从 conversation-store 读取会话绑定的 workspacePath；
 *   B2 兜底/校验：渲染端经 chat:send 透传的 incomingWorkspacePath（仅当会话无绑定时启用）；
 *   兜底：全局活跃工作区 activeWorkspacePath（历史会话无 workspacePath / conversationId 为空时）；
 *   最终兜底：process.cwd()。
 * 提为模块级纯函数（依赖经参数注入）以便单测，闭包内由 createLlmChatService 透传捕获的状态。
 */
function resolveRunWorkspacePath({
  conversationStore = null,
  conversationId = null,
  incomingWorkspacePath = null,
  activeWorkspacePath = null,
} = {}) {
  if (conversationId && conversationStore?.getConversation) {
    try {
      const conv = conversationStore.getConversation(conversationId);
      const bound = conv?.workspacePath;
      if (bound && typeof bound === 'string') return bound;
    } catch {
      // 读取失败时落到兜底链，不阻断本轮运行。
    }
  }
  if (incomingWorkspacePath && typeof incomingWorkspacePath === 'string') return incomingWorkspacePath;
  if (activeWorkspacePath && typeof activeWorkspacePath === 'string') return activeWorkspacePath;
  return process.cwd();
}

function buildGoalWorkspaceBindingExtensions(binding) {
  const origin = binding?.originWorkspacePath ?? null;
  const target = binding?.targetWorkspacePath ?? null;
  if (!origin || !target || origin === target) return [];
  return [{
    id: `goal-workspace-binding-${binding.planId || 'active'}`,
    title: 'Goal workspace binding',
    layer: 'L3_INSTRUCTIONS',
    priority: 20,
    sourceKind: 'runtime',
    trust: 'runtime',
    content: [
      `Goal origin workspace: ${origin}`,
      `Goal target workspace: ${target}`,
      'Use the origin workspace as the knowledge and intent source.',
      'Write, edit, run checks, and collect implementation evidence in the target workspace unless the Goal explicitly changes scope.',
      'Do not treat the origin workspace as the write boundary for this Goal.',
    ].join('\n'),
  }];
}

function recordPromptSnapshot(store, context, metadata) {
  try {
    store?.record?.(context, metadata);
  } catch (error) {
    console.warn('[llm-chat] failed to record prompt snapshot:', error?.message || error);
  }
}

function hasBillableUsage(usage) {
  return Boolean(
    (usage?.inputTokens || 0) ||
    (usage?.outputTokens || 0) ||
    (usage?.cacheWriteTokens || 0) ||
    (usage?.cacheReadTokens || 0)
  );
}

function isRequestUserInputToolName(toolName) {
  return toolName === 'request_user_input'
    || (typeof toolName === 'string' && toolName.endsWith('.request_user_input'));
}

function buildAgentRunOutcome(streamRecord = {}) {
  return {
    terminalStatus: streamRecord.terminalStatus || 'error',
    requestedUserInput: Boolean(streamRecord.requestedUserInput),
    toolCallCount: Number.isFinite(streamRecord.toolCallCount)
      ? Math.max(0, Math.trunc(streamRecord.toolCallCount))
      : 0,
    ...(hasBillableUsage(streamRecord.finalUsage) ? { usage: streamRecord.finalUsage } : {}),
  };
}

function recordConversationUsage({ conversationStore, streamRecord, usage, usageRequestLog, llmConfigStore }) {
  if (
    (!conversationStore?.recordRuntimeTurnUsage && !conversationStore?.addUsage)
    || !streamRecord?.conversationId
    || !hasBillableUsage(usage)
  ) return null;
  if (streamRecord.usageRecorded) return null;
  try {
    const requestedModelProviderId = streamRecord.modelProviderId || null;
    const actualModelProviderId = streamRecord.actualModelProviderId || null;
    const model = streamRecord.actualModel || null;
    const providers = typeof llmConfigStore?.listProviders === 'function'
      ? llmConfigStore.listProviders()
      : [];
    const patch = resolveConversationModelBindingPatch({
      providers,
      requestedModelProviderId,
      actualModelProviderId,
      actualModel: model,
    });
    const modelProviderId = patch.modelProviderId
      || actualModelProviderId
      || requestedModelProviderId
      || null;
    // 用量归因必须带渠道 groupId：统计按 Provider 分组时以渠道为键，
    // 不能让模型条目 uuid 代替渠道（否则同一渠道的每个模型条目各占一行）。
    const resolvedProvider = providers.find((candidate) => (
      candidate?.id === modelProviderId
      || (candidate?.groupId && candidate.groupId === modelProviderId)
      || (
        modelProviderId
        && candidate?.groupId
        && candidate?.model
        && modelProviderId === `${candidate.groupId}::${candidate.model}`
      )
    )) || null;
    const compositeSeparator = typeof modelProviderId === 'string'
      ? modelProviderId.indexOf('::')
      : -1;
    const groupId = (resolvedProvider?.groupId || '').trim()
      || (compositeSeparator > 0 ? modelProviderId.slice(0, compositeSeparator).trim() : '')
      || null;
    try {
      if (typeof conversationStore.updateModelEffort === 'function') {
        conversationStore.updateModelEffort(streamRecord.conversationId, patch);
      }
    } catch (error) {
      console.warn('[llm-chat] failed to persist provider snapshot:', error?.message || error);
    }

    let lifetimeUsage = null;
    if (
      usage?.usageScope === 'runtime_turn'
      && typeof conversationStore.recordRuntimeTurnUsage === 'function'
    ) {
      const cost = estimateUsageCostUsd(usage, streamRecord.actualPricing || {});
      const recorded = conversationStore.recordRuntimeTurnUsage(
        streamRecord.conversationId,
        {
          usage,
          attribution: {
            id: streamRecord.streamId || undefined,
            streamId: streamRecord.streamId || null,
            modelProviderId,
            groupId,
            model,
            providerName: streamRecord.actualProviderName || null,
            estimatedCostUsd: cost.hasPricing ? cost.estimatedCostUsd : null,
            pricingSource: streamRecord.actualPricingSource || null,
          },
        },
      );
      lifetimeUsage = recorded?.lifetimeUsage ?? null;
    } else {
      // Compatibility for injected legacy stores/adapters. Production Desktop
      // and TUI both use recordRuntimeTurnUsage.
      lifetimeUsage = conversationStore.addUsage?.(streamRecord.conversationId, usage);
      if (lifetimeUsage) {
        try {
        usageRequestLog?.append?.({
          id: streamRecord.streamId || undefined,
          conversationId: streamRecord.conversationId,
          streamId: streamRecord.streamId || null,
          modelProviderId,
          groupId,
          model,
          providerName: streamRecord.actualProviderName || null,
          usage,
          providerRequestCount: usage?.providerRequestCount,
          pricing: streamRecord.actualPricing || {},
          pricingSource: streamRecord.actualPricingSource || null,
        });
        } catch (error) {
          console.warn('[llm-chat] failed to append usage request log:', error?.message || error);
        }
      }
    }

    streamRecord.usageRecorded = Boolean(lifetimeUsage);
    return lifetimeUsage;
  } catch (error) {
    console.warn('[llm-chat] failed to record conversation usage:', error?.message || error);
    return null;
  }
}

/**
 * 原生 reasoning 当轮自愈降级的观测点（不持久化）。
 *
 * agent loop 在某一轮拿到“空响应”(textContent 与 thinkingContent 均为空) 时,
 * 已在 loop 内将 effectiveSupportsReasoning 置 false 并重试当轮——这是合理的会话内自愈。
 *
 * 这里**刻意不再写回 provider 配置**:偶发空响应(限流/网络抖动/深度模式边界/上下文极满)
 * 不能等同于“该 provider 不支持 reasoning”。曾经在此调用 updateProvider({supportsReasoning:false})
 * 会把一次偶发事件固化成持久能力位,导致用户没动设置、深度档却被悄悄永久关闭。
 * 详见 docs/architecture 中关于 provider 能力位与会话内降级的边界说明。
 */
function noteNativeReasoningFallback(provider, details = {}) {
  if (!provider?.id) return;
  console.warn(
    `[llm-chat] native reasoning fell back to plain mode for this turn (provider ${provider.id}): ${details.reason || 'unsupported'}; capability flag left unchanged`
  );
}

// 终态落盘兜底：把「已发出但未回填结果」的 tool-call 段补写一个明确的中断 result，
// 使其在持久化后脱离「执行中（永久转圈）」态。背景：渲染层三个终态 handler 已对 live
// segments 做过同样收尾，但仅当终态事件 streamId 与当前会话匹配时才生效；后台会话（已
// 切走）或事件 streamId 不匹配时，真值来源是这里的落盘 + 切回时的会话重载。因此必须在
// 主进程的终态落盘汇聚点再兜一次，否则切回会话仍会看到永久转圈的工具段。
// 与渲染层口径一致：result === undefined 且 synthetic !== true 视为悬空段。
// 纯函数：无悬空段时返回原数组引用，调用方据此可跳过无谓写入。
function terminalDanglingNote(terminalStatus) {
  if (terminalStatus === 'goal_handoff') return null;
  if (terminalStatus === 'aborted') return '工具调用已中断（生成停止）';
  if (terminalStatus === 'error') return '工具调用已中断（连接出错）';
  return '工具结果未返回（本轮已结束）';
}

function finalizeDanglingToolSegments(segments, terminalStatus) {
  if (!Array.isArray(segments)) return segments;
  const note = terminalDanglingNote(terminalStatus);
  if (note == null) return segments;
  let changed = false;
  const next = segments.map((segment) => {
    if (segment?.type === 'tool-call' && segment.result === undefined && segment.synthetic !== true) {
      changed = true;
      return { ...segment, result: note };
    }
    return segment;
  });
  return changed ? next : segments;
}

/**
 * ADR 22: 累积代理。包裹真实 webContents,拦截流式正文/思考事件追加到 streamRecord,
 * 其余事件原样透传。这样两个 provider adapter / agent loop 都无需改动,
 * 累积逻辑集中在单一 seam。返回的对象只需实现 send()(adapter/loop 只用到 send)。
 */
function wrapWebContentsForRuntimeEvents(
  realWebContents,
  streamRecord,
  {
    conversationStore = null,
    llmConfigStore = null,
    emitRuntimeEvent = null,
    failRuntimeTurn = null,
  } = {},
) {
  const appendTextSegment = (type, content, kind) => {
    if (!content) return;
    const segments = streamRecord.segments;
    const last = segments[segments.length - 1];
    // Thinking segments only merge when kind matches (including both missing
    // kind for legacy/unknown sources). Different kinds stay separate tracks.
    const sameThinkingKind =
      type === 'thinking'
      && last?.type === 'thinking'
      && (last.kind || undefined) === (kind || undefined);
    const samePlainText = type !== 'thinking' && last?.type === type;
    if (sameThinkingKind || samePlainText) {
      // Only GPT-style summary phrases get safe breaks; reasoning/legacy stay plain +.
      const mergedKind = type === 'thinking' ? (kind || last.kind) : undefined;
      last.content =
        type === 'thinking' && mergedKind === 'summary'
          ? joinSummaryThinkingContent(last.content || '', content)
          : `${last.content || ''}${content}`;
      if (type === 'thinking' && kind && !last.kind) last.kind = kind;
    } else if (type === 'thinking' && kind) {
      segments.push({ type, content, kind });
    } else {
      segments.push({ type, content });
    }
  };

  // 「正文持久化真值下沉主进程」：把累积的 content/segments 直接 patch 到 store 里
  // 对应的 assistant 消息，不再依赖 renderer 在终态事件回写。后台会话（主界面已切走、
  // 该会话的 ChatSurface 不再消费事件）也能落盘完整正文，根治「切走即丢 → 看似自我中断」。
  // 流式期间按时间节流写盘（默认 500ms），终结态强制 flush；写盘失败不影响事件透传。
  const PERSIST_THROTTLE_MS = 500;
  let lastPersistAt = 0;
  const persistStreamRecord = ({ final = false, interrupted = false } = {}) => {
    if (!conversationStore?.updateMessageById) return;
    if (!streamRecord?.conversationId) return;
    // 没有明确 assistantMessageId 时绝不回写：否则会落到会话最后一条 assistant，
    // 把 Verifier 的 JSON 验收结果盖到用户可见回复上。
    if (!streamRecord?.assistantMessageId) return;
    // Explorer / Verifier 等内部旁路流不落盘。
    if (streamRecord?.ephemeral) return;
    const now = Date.now();
    if (!final && now - lastPersistAt < PERSIST_THROTTLE_MS) return;
    lastPersistAt = now;
    // 终态落盘时，把已发出但未回填结果的 tool-call 段补成中断态，避免切回会话后永久转圈。
    const sourceSegments = final
      ? finalizeDanglingToolSegments(streamRecord.segments, streamRecord.terminalStatus)
      : streamRecord.segments;
    const patch = {
      content: streamRecord.accumulatedText || '',
      segments: Array.isArray(sourceSegments)
        ? sourceSegments.map((segment) => ({ ...segment }))
        : [],
    };
    if (final && Number.isFinite(streamRecord.startedAt)) {
      patch.durationMs = Math.max(0, now - streamRecord.startedAt);
    }
    if (final && hasBillableUsage(streamRecord.finalUsage)) {
      patch.usage = { ...streamRecord.finalUsage };
    }
    if (final && interrupted) patch.interrupted = true;
    try {
      if (final) {
        // 终态：全量落盘（会同步重写整份 JSONL，一次性成本可接受）并清理流式 sidecar。
        conversationStore.updateMessageById(
          streamRecord.conversationId,
          streamRecord.assistantMessageId ?? null,
          patch,
        );
      } else if (typeof conversationStore.patchStreamingMessage === 'function') {
        // 流式中间态：只写几十 KB 的 sidecar。此前这里直接走 updateMessageById，
        // 大会话（数 MB JSONL）每 500ms 同步读写一次，把主进程主线程打满
        //（trace: 单次 230ms+ × 35 次），所有窗口一起卡死。
        conversationStore.patchStreamingMessage(
          streamRecord.conversationId,
          streamRecord.assistantMessageId,
          patch,
        );
      } else {
        // 旧 store 兼容路径（无 sidecar 能力时保持原行为）。
        conversationStore.updateMessageById(
          streamRecord.conversationId,
          streamRecord.assistantMessageId ?? null,
          patch,
        );
      }
    } catch (err) {
      console.warn('[llm-chat] persist stream record failed:', err?.message || err);
    }
  };
  streamRecord.persist = persistStreamRecord;

  const emitStreamRuntimeEvent = (event) => {
    if (typeof emitRuntimeEvent !== 'function') return null;
    try {
      return emitRuntimeEvent({
        ...event,
        sessionId: streamRecord.conversationId || streamRecord.streamId,
        streamId: streamRecord.streamId,
        conversationId: streamRecord.conversationId || undefined,
      });
    } catch (error) {
      console.warn('[llm-chat] runtime event emission failed:', error?.message || error);
      return null;
    }
  };

  return {
    send(channel, payload) {
      // 终态守卫：一旦本轮已发出终态（done/error/aborted，含复读兜底自动 error），
      // 丢弃所有后续在途的正文/思考 delta，避免「已收口却仍继续转发残留」导致刷屏。
      if (
        streamRecord.terminalEventSent &&
        (channel === 'chat:stream:delta' || channel === 'chat:stream:thinking')
      ) {
        return false;
      }
      if (channel === 'chat:stream:delta' && typeof payload?.content === 'string') {
        emitStreamRuntimeEvent({ type: 'message.delta', content: payload.content });
        streamRecord.accumulatedText += payload.content;
        appendTextSegment('text', payload.content);
        persistStreamRecord();
        // 复读兜底：命中尾部周期检测即视为模型卡死，主动 abort 并以 error 收口本轮。
        // delta 属于 REPLAY_UNSAFE 通道，terminalEventSent 置位后不会触发重试/切 provider。
        const repetition = detectTailRepetition(streamRecord.accumulatedText);
        if (repetition) {
          console.warn(
            `[llm-chat] repetition detected (period=${repetition.period}, repeats=${repetition.repeats}, reason=${repetition.reason}, substantiveChars=${repetition.substantiveChars}, unit=${JSON.stringify(repetition.unitPreview)}); aborting stream ${streamRecord.streamId}`,
          );
          const lifetimeUsage = recordConversationUsage({
            conversationStore,
            streamRecord,
            usage: undefined,
            usageRequestLog,
            llmConfigStore,
          });
          const errorPayload = { streamId: streamRecord.streamId, error: 'repetition_detected' };
          if (lifetimeUsage) errorPayload.lifetimeUsage = lifetimeUsage;
          streamRecord.terminalEventSent = true;
          streamRecord.terminalStatus = 'error';
          streamRecord.interrupted = true;
          if (lifetimeUsage) streamRecord.lifetimeUsage = lifetimeUsage;
          persistStreamRecord({ final: true, interrupted: true });
          try {
            failRuntimeTurn?.('repetition_detected');
          } catch {
            /* 已中断时忽略 */
          }
          realWebContents.send('chat:stream:delta', payload);
          return realWebContents.send('chat:stream:error', errorPayload);
        }
      } else if (channel === 'chat:stream:thinking' && typeof payload?.content === 'string') {
        const thinkingKind =
          payload.kind === 'summary' || payload.kind === 'reasoning'
            ? payload.kind
            : undefined;
        emitStreamRuntimeEvent({
          type: 'reasoning.delta',
          content: payload.content,
          ...(thinkingKind ? { kind: thinkingKind } : {}),
        });
        // Keep accumulatedThinking consistent with segment join rules (summary-only breaks).
        streamRecord.accumulatedThinking =
          thinkingKind === 'summary'
            ? joinSummaryThinkingContent(streamRecord.accumulatedThinking || '', payload.content)
            : `${streamRecord.accumulatedThinking || ''}${payload.content}`;
        appendTextSegment('thinking', payload.content, thinkingKind);
        persistStreamRecord();
      } else if (channel === 'chat:stream:tool-call') {
        const toolName = typeof payload?.tool === 'string' ? payload.tool : undefined;
        streamRecord.toolCallCount = Math.max(0, Math.trunc(streamRecord.toolCallCount || 0)) + 1;
        if (isRequestUserInputToolName(toolName)) streamRecord.requestedUserInput = true;
        streamRecord.segments.push({
          type: 'tool-call',
          tool: toolName,
          args: payload?.args && typeof payload.args === 'object' ? payload.args : {},
          toolCallId: typeof payload?.toolCallId === 'string' ? payload.toolCallId : undefined,
          startedAtMs: Number.isFinite(payload?.startedAtMs) ? payload.startedAtMs : undefined,
          result: undefined,
        });
        persistStreamRecord();
      } else if (channel === 'chat:stream:tool-result') {
        const toolCallId = typeof payload?.toolCallId === 'string' ? payload.toolCallId : null;
        for (let index = streamRecord.segments.length - 1; index >= 0; index -= 1) {
          const segment = streamRecord.segments[index];
          if (segment?.type !== 'tool-call') continue;
          if (toolCallId && segment.toolCallId && segment.toolCallId !== toolCallId) continue;
          if (segment.result !== undefined) continue;
          segment.result = typeof payload?.result === 'string' ? payload.result : '';
          segment.startedAtMs = Number.isFinite(payload?.startedAtMs) ? payload.startedAtMs : segment.startedAtMs;
          segment.endedAtMs = Number.isFinite(payload?.endedAtMs) ? payload.endedAtMs : undefined;
          segment.durationMs = Number.isFinite(payload?.durationMs) ? payload.durationMs : undefined;
          break;
        }
        persistStreamRecord();
      } else if (channel === 'chat:stream:done' || channel === 'chat:stream:error') {
        const lifetimeUsage = recordConversationUsage({
          conversationStore,
          streamRecord,
          usage: payload?.usage,
          usageRequestLog,
          llmConfigStore,
        });
        if (lifetimeUsage) {
          payload = { ...payload, lifetimeUsage };
        }
        streamRecord.terminalEventSent = true;
        // 终结态强制落盘：done 视为正常完成；Goal intake 被 Runner 接管时使用显式
        // goal_handoff 非错误终态；error 才标记 interrupted=true。
        const erroredTerminal = channel === 'chat:stream:error';
        const goalHandoffTerminal = channel === 'chat:stream:done'
          && payload?.reason === 'goal_handoff';
        streamRecord.terminalStatus = erroredTerminal
          ? 'error'
          : (goalHandoffTerminal ? 'goal_handoff' : 'done');
        streamRecord.interrupted = erroredTerminal;
        if (payload?.usage) streamRecord.finalUsage = payload.usage;
        if (payload?.lifetimeUsage) streamRecord.lifetimeUsage = payload.lifetimeUsage;
        if (erroredTerminal) {
          emitStreamRuntimeEvent({
            type: 'runtime.error',
            code: typeof payload?.error === 'string' ? payload.error : 'stream_error',
            message: typeof payload?.message === 'string' ? payload.message : undefined,
            details: payload,
          });
        } else {
          emitStreamRuntimeEvent({
            type: 'message.completed',
            content: streamRecord.accumulatedText || undefined,
            usage: payload?.usage,
            lifetimeUsage: payload?.lifetimeUsage,
            finishReason: typeof payload?.finishReason === 'string' ? payload.finishReason : undefined,
          });
        }
        persistStreamRecord({ final: true, interrupted: erroredTerminal });
        if (payload?.contextAccounting?.version === 1
          && typeof conversationStore?.updateContextSnapshot === 'function'
          && streamRecord.conversationId
          // 观测即持久化后,同一快照可能已在 context.accounting 事件时落盘;
          // 终态重复写会造成双写,据 persistKey 去重。
          && contextSnapshotPersistKey(payload.contextAccounting)
            !== streamRecord.persistedContextSnapshotKey) {
          conversationStore.updateContextSnapshot(
            streamRecord.conversationId,
            payload.contextAccounting,
          );
        }
      } else if (channel === 'chat:stream:aborted') {
        streamRecord.terminalEventSent = true;
        streamRecord.terminalStatus = 'aborted';
        streamRecord.interrupted = true;
        emitStreamRuntimeEvent({
          type: 'runtime.error',
          code: 'stream_aborted',
          message: 'Stream aborted.',
          recoverable: true,
          details: payload,
        });
        persistStreamRecord({ final: true, interrupted: true });
      }
      const routedPayload = (
        channel === 'chat:stream:done'
        || channel === 'chat:stream:error'
        || channel === 'chat:stream:aborted'
      ) && streamRecord.conversationId
        ? { ...payload, conversationId: streamRecord.conversationId }
        : payload;
      return realWebContents.send(channel, routedPayload);
    },
  };
}

/**
 * 观测快照的落盘去重键:同一 (modelKey, revision, lastObserved.at) 视为同一次观测,
 * 终态(done/error)不再重复写 sidecar。
 */
function contextSnapshotPersistKey(snapshot) {
  if (!snapshot || snapshot.version !== 1) return null;
  return `${snapshot.modelKey}::${snapshot.revision ?? 0}::${snapshot.lastObserved?.at ?? ''}`;
}

function getActiveContextEpochId(store, conversationId = null) {
  try {
    return store?.getLatestContextEpoch?.(conversationId)?.contextEpochId
      ?? store?.getLatestContextEpoch?.(null)?.contextEpochId
      ?? null;
  } catch {
    return null;
  }
}

function getConversationToolContext({ conversationId = null, workspacePath = null } = {}) {
  if (!conversationId) return createToolContext({ conversationId, workspacePath });
  const key = `${conversationId}::${workspacePath || process.cwd()}`;
  let context = conversationToolContexts.get(key);
  if (!context) {
    context = createToolContext({ conversationId, workspacePath });
    conversationToolContexts.set(key, context);
  }
  return context;
}

export function createLlmChatService({
  llmConfigStore,
  conversationStore = null,
  emitRuntimeEvent = null,
  persistCompaction = null,
  promptSnapshotStore = null,
  preferredAccessLevel = 'ask_before_local',
  mcpRegistry = null,
  // main 注入的带 onChange 的 goalPlanStore 单例。AI 工具(goal_create_plan/
  // goal_update_task)必须写到它，变更才能广播到渲染端，浮条才会随流式更新。
  goalPlanStore = null,
  // main 注入的 Browser 工作现场 reveal 桥；Agent 工具路径创建 LocalToolHost 时需要它。
  ensureBrowserReady = null,
  // 全局活跃流广播宿主(由 main 注入):向所有渲染窗口推送当前正在运行的会话列表,
  // 使左侧列表无需"点进去"即可知道哪些会话在跑。表达层订阅,真值仍在 activeStreams。
  broadcast = null,
  runtimeSessionAdapter = null,
  // 读取全局 settings.json（含 fallbackVision 兜底多模态模型配置）。
  getSettings = null,
}) {
  permissionGate.setAccessLevel(preferredAccessLevel);
  const runtimeSessions = runtimeSessionAdapter ?? createDesktopRuntimeSessionAdapter();

  function setWorkspacePath(wsPath) { activeWorkspacePath = wsPath; }

  // 闭包薄封装：把当前捕获的 conversationStore / activeWorkspacePath 注入模块级纯函数
  // resolveRunWorkspacePath（见文件顶部，含完整兜底链说明与单测）。
  function resolveRunWorkspacePathForRun(conversationId = null, incomingWorkspacePath = null) {
    return resolveRunWorkspacePath({
      conversationStore,
      conversationId,
      incomingWorkspacePath,
      activeWorkspacePath,
    });
  }

  function setLocalAccessLevel(nextAccessLevel) {
    return permissionGate.setAccessLevel(nextAccessLevel);
  }

  // 当前正在流式运行的会话 id 去重列表(只读快照)。
  // 流终结后保留记录（供切回回放），但终结后的记录不应再被视为「运行中」。
  // 因此所有「活跃」投影/认领都以 terminalEventSent 为界：仅未终结的才算 running。
  function isRunning(record) {
    return Boolean(record) && !record.terminalEventSent;
  }

  // 流终态收口：标记保留、广播运行态变化（终态记录会从 running 投影中消失），
  // 并安排保留期满后的硬删除。重复调用安全（计时器只设一次）。
  function retireStream(streamId) {
    const record = activeStreams.get(streamId);
    if (!record) return;
    record.retainedAt = Date.now();
    emitActiveStreamsChanged();
    if (record.cleanupTimer) return;
    record.cleanupTimer = setTimeout(() => {
      activeStreams.delete(streamId);
    }, TERMINAL_RETENTION_MS);
    if (typeof record.cleanupTimer?.unref === 'function') record.cleanupTimer.unref();
  }

  function listActiveConversationIds() {
    const ids = new Set();
    for (const record of activeStreams.values()) {
      if (isRunning(record) && record.conversationId && !record.ephemeral) ids.add(record.conversationId);
    }
    return [...ids];
  }

  // ADR 27: 活跃流投影携带工作区维度。按 conversationId 去重(同一会话可能有多条流,
  // 取首条记录的 origin 工作区即可),供 renderer 派生"哪些工作区有运行中的流"。
  // workspacePath / originWorkspacePath 都是会话发起侧；execution 不进绿点投影。
  function listActiveStreams() {
    const byConversation = new Map();
    for (const record of activeStreams.values()) {
      if (!isRunning(record)) continue;
      if (!record.conversationId) continue;
      if (record.ephemeral) continue;
      if (!byConversation.has(record.conversationId)) {
        const originWorkspacePath = record.originWorkspacePath
          ?? record.workspacePath
          ?? null;
        byConversation.set(record.conversationId, {
          conversationId: record.conversationId,
          streamId: record.streamId,
          // 绿点真值：origin（会话发起工作区）
          workspacePath: originWorkspacePath,
          originWorkspacePath,
        });
      }
    }
    return [...byConversation.values()];
  }

  // activeStreams 发生增删后广播一次,让所有窗口的左侧列表同步运行状态。
  // ADR 27: 在保留 conversationIds(既有消费者不破坏)的同时附带 streams(带工作区)。
  function emitActiveStreamsChanged() {
    if (typeof broadcast !== 'function') return;
    try {
      broadcast('chat:stream:active-changed', {
        conversationIds: listActiveConversationIds(),
        streams: listActiveStreams(),
      });
    } catch {}
  }

  function getProviderCandidates(preferredProviderId = null) {
    // 路由真值必须与设置页/聊天选择器一致：只使用用户明确保存的 provider×model 记录。
    // 目录展开只是“可导入候选”，不能替换真实记录，否则 renderer 回传的真实 id 会在
    // main 进程消失，并错误回退到目录里的另一模型。
    const providers = llmConfigStore.listProviders();
    return orderProviderCandidates(providers, preferredProviderId);
  }

  /**
   * 主模型不支持 vision 时，仅对本轮末尾 user 消息中的新图做：
   * - 已配置兜底多模态模型：先识别，再静默注入文本
   * - 未配置：剥离 image_url，并弱提示
   * 历史图不触发。会话落盘仍保留原始附件，仅改发送给 provider 的 messages。
   */
  async function prepareMessagesForProviderVision(messagesInput, preferredProviderId, webContents, streamId) {
    const source = Array.isArray(messagesInput) ? messagesInput : [];
    const candidates = getProviderCandidates(preferredProviderId);
    const primary = candidates[0] || null;
    const supportsVision = Boolean(primary?.supportsVision);
    const probe = processTrailingUserImages(source, { supportsVision });
    if (supportsVision || !probe.imageUrls.length) {
      return source;
    }

    const settings = typeof getSettings === 'function' ? getSettings() : null;
    const fallbackId = readFallbackVisionProviderId(settings);
    const allProviders = typeof llmConfigStore?.listProviders === 'function'
      ? llmConfigStore.listProviders()
      : candidates;
    const fallbackProvider = fallbackId
      ? allProviders.find((item) => item.id === fallbackId) || null
      : null;

    let imageDescriptions = null;
    let credentialResolved = false;
    let recognitionStatus = fallbackProvider ? 'not_started' : 'provider_not_found';
    let recognitionError = null;
    let recognitionWire = null;
    if (fallbackProvider?.supportsVision) {
      try {
        recognitionStatus = 'started';
        const recognition = await recognizeImagesWithFallbackProvider({
          provider: fallbackProvider,
          imageUrls: probe.imageUrls,
          userText: probe.trailingUserText || '',
          getCredential: async (id) => {
            const target = allProviders.find((item) => item.id === id) || fallbackProvider;
            const credential = await resolveProviderCredential({ provider: target, llmConfigStore });
            credentialResolved = true;
            return credential;
          },
          resolveChannel,
          fetchImpl: (url, init) => fetchWithConnectionRecovery(url, init, {
            webContents,
            streamId,
            provider: fallbackProvider.id,
            model: fallbackProvider.model,
          }),
        });
        recognitionWire = recognition?.wire || null;
        recognitionError = recognition?.ok ? null : (recognition?.error || 'recognition_failed');
        recognitionStatus = recognition?.ok ? 'succeeded' : 'failed';
        if (recognition?.ok && Array.isArray(recognition.descriptions) && recognition.descriptions.length) {
          imageDescriptions = recognition.descriptions;
        }
      } catch (error) {
        recognitionStatus = 'failed';
        recognitionError = error?.code || error?.message || 'recognition_failed';
      }
    } else if (fallbackProvider) {
      recognitionStatus = 'provider_without_vision';
    }

    const processed = processTrailingUserImages(source, {
      supportsVision: false,
      imageDescriptions,
    });
    console.info('[llm-chat] fallback_vision', {
      streamId,
      primaryProviderId: primary?.id || null,
      primarySupportsVision: supportsVision,
      detectedImageCount: probe.imageUrls.length,
      fallbackProviderId: fallbackId,
      fallbackProviderFound: Boolean(fallbackProvider),
      fallbackAuthMethod: fallbackProvider?.authMethod || null,
      credentialResolved,
      recognitionStatus,
      recognitionWire,
      recognitionError,
      descriptionCount: imageDescriptions?.length || 0,
      injected: processed.recognizedImageCount > 0,
      strippedImageCount: processed.strippedImageCount,
    });
    if (processed.changed && !imageDescriptions) {
      try {
        webContents?.send?.('chat:stream:notice', {
          streamId,
          code: 'vision_images_stripped',
          message: 'Images were omitted because the current model does not support vision. Configure a fallback vision model in Settings → Models.',
          imageCount: processed.strippedImageCount,
        });
      } catch {
        // notice is best-effort
      }
    }
    return processed.messages;
  }

  async function sendMessage({
    messages: rawMessages,
    webContents,
    streamId,
    effort = 'default',
    mode = 'chat',
    conversationId = null,
    // 会话级首选 provider（会话 meta.modelProviderId 透传）。指定时排为本轮主 provider；
    // 若该 provider 已失效/被删，orderProviderCandidates 会自动回退默认（强绑定回退）。
    modelProviderId = null,
    // B2 兜底：渲染端经 chat:send 透传的工作区路径，仅在会话未绑定 workspacePath 时作为兜底/校验，
    // 不作为主真值（主真值由 resolveRunWorkspacePath 按 conversationId 从 store 解析）。
    workspacePath: incomingWorkspacePath = null,
    assistantMessageId = null,
    contextAttachments = [],
    runtimeReminders = [],
    attachmentContext = [],
    continuityContext = [],
    configInstructions = [],
    contextExtensions = [],
    explorerContext = null,
    verifierContext = null,
    // Goal Runner 进度 sink：{ onRound, onToolCall }。onRound 经各 provider loop 透传，
    // onToolCall 经 toolContext 透传，分别用于实时轮次/工具计数。普通 chat 不传。
    agentProgress = null,
    // Request-scoped policy for governed background runs (for example Automation).
    // It is copied into this turn's Tool Context and never mutates the shared chat access level.
    permissionPolicy = null,
    // 内部旁路流（Explorer / Verifier）：不写会话正文、不进活跃流投影，避免验收 JSON 泄漏到聊天。
    ephemeral = false,
  }) {
    // 托管回合（Goal Runner 等）没有 renderer 再次透传 modelProviderId，但只要绑定了
    // conversationId，就必须继承该会话的模型选择。否则会静默落到全局默认 provider，
    // 造成 UI 显示 ChatGPT、后台实际改跑 Grok 的跨模型漂移。
    const effectiveModelProviderId = resolveConversationModelProviderId({
      modelProviderId,
      conversationId,
      conversationStore,
    });
    const providerCandidates = getProviderCandidates(effectiveModelProviderId);
    if (!providerCandidates.length) {
      webContents.send('chat:stream:error', { streamId, error: 'no_provider_configured' });
      return { terminalStatus: 'error', requestedUserInput: false, toolCallCount: 0 };
    }
    const messages = await prepareMessagesForProviderVision(
      rawMessages,
      effectiveModelProviderId,
      webContents,
      streamId,
    );

    // 会话 workspace 是本轮的 origin：用户从哪里发起、有哪些知识上下文。Goal 模式下，
    // active Goal 可绑定 targetWorkspacePath；此时工具 cwd / 项目指令切换到 target，
    // origin 作为 runtime context extension 注入，不再把 origin 当写入边界。
    const conversationWorkspacePath = resolveRunWorkspacePathForRun(conversationId, incomingWorkspacePath);
    // Agent 默认（chat）与 legacy goal 均可绑定 active Goal 的 target workspace。
    const goalWorkspaceBinding = (mode === 'goal' || mode === 'chat')
      ? resolveActiveGoalExecutionBinding(conversationId, conversationWorkspacePath, goalPlanStore)
      : null;
    const runWorkspacePath = goalWorkspaceBinding?.executionWorkspacePath || conversationWorkspacePath;
    const effectiveContextExtensions = [
      ...(Array.isArray(contextExtensions) ? contextExtensions : []),
      ...buildGoalWorkspaceBindingExtensions(goalWorkspaceBinding),
    ];

    const runtimeTurn = runtimeSessions.startStream({ streamId, conversationId });
    const streamRecord = {
      runtimeSessionId: runtimeTurn.sessionId,
      runtimeTurn,
      webContents,
      runtimeWebContents: null,
      permissionIds: new Set(),
      conversationId,
      // 正文持久化主键：主进程据此把累积正文/segments patch 回 store 的 assistant 消息。
      assistantMessageId,
      // 内部旁路流：true 时不落盘、不投影为用户可见活跃会话流。
      ephemeral: Boolean(ephemeral),
      // ADR 27: 活跃流指示用「会话发起工作区」(origin)，不是 Goal target / execution。
      // 用户从 peer-knowledge 发起、工具写到 peer_agent 时，绿点应留在 peer-knowledge。
      // runWorkspacePath 仍用于 tool cwd / 项目指令 / 写入边界，不混入 UI 运行指示。
      workspacePath: conversationWorkspacePath,
      originWorkspacePath: conversationWorkspacePath,
      // 可选诊断字段：本轮实际执行根（Goal target 或 origin）。
      executionWorkspacePath: runWorkspacePath,
      // 整轮 wall-clock 起点属于运行时事实。renderer 切走/重开后通过 reattach 恢复该锚点，
      // 避免重新进入会话时计时停住或从 0 重新开始。
      startedAt: Date.now(),
      // 复读兜底：命中尾部周期检测时需在 send 收口点自行构造 error payload，故留存 streamId。
      streamId,
      // 发送入口透传的首选 provider；真正命中的实际 provider 在 attempt 循环里覆盖到 actual*。
      modelProviderId: effectiveModelProviderId ?? null,
      // ADR 22: 累积进行中的流式正文/思考/工具段,供 HMR 重载后 reattach 取快照续接。
      accumulatedText: '',
      accumulatedThinking: '',
      segments: [],
      usageRecorded: false,
      toolCallCount: 0,
      requestedUserInput: false,
      // 多 provider fallback / 同 provider 重试共享一次 Runtime Pipeline session 事件状态。
      runtimeEventState: { sessionStarted: true },
      // 终态事件去重:保证 done/error/aborted 三选一恰好发一次,防止压缩等中间阶段抛错后界面悬挂。
      terminalEventSent: false,
      // Goal handoff 必须等待 sendMessage finally 真正释放 Runtime turn，不能把 UI done
      // 当成 session 已空闲。Promise 暴露给 forceCompleteConversationStreams 聚合等待。
      released: null,
      resolveReleased: null,
    };
    streamRecord.released = new Promise((resolve) => { streamRecord.resolveReleased = resolve; });
    let accumulatingWebContents = webContents;
    try {
      activeStreams.set(streamId, streamRecord);
      emitActiveStreamsChanged();
      if (typeof emitRuntimeEvent === 'function') {
        emitRuntimeEvent({
          type: 'session.started',
          sessionId: conversationId || streamId,
          streamId,
          conversationId: conversationId || undefined,
          mode,
        });
      }
      // 观测即持久化(ADR 56 补丁):provider_usage 级 context.accounting 快照在观测
      // 发生时立即写入 conversation sidecar,不再只依赖 chat:stream:done。这样被
      // 中断(aborted)或崩溃的 turn 不丢 lastObserved,restore 后圆环能恢复百分比。
      // 只拦截 provider_usage:estimated/unknown 快照不落盘,避免噪声覆盖观测事实。
      const emitRuntimeEventPersistingAccounting = (event) => {
        if (
          event?.type === 'context.accounting'
          && event.snapshot?.version === 1
          && event.snapshot.pressureSource === 'provider_usage'
          && streamRecord.conversationId
          && !streamRecord.ephemeral
          && typeof conversationStore?.updateContextSnapshot === 'function'
        ) {
          try {
            conversationStore.updateContextSnapshot(streamRecord.conversationId, event.snapshot);
            streamRecord.persistedContextSnapshotKey = contextSnapshotPersistKey(event.snapshot);
          } catch (error) {
            console.warn('[llm-chat] failed to persist observed context snapshot:', error?.message || error);
          }
        }
        if (typeof emitRuntimeEvent === 'function') return emitRuntimeEvent(event);
        return null;
      };
      // 累积代理:拦截 delta/thinking 追加到记录,其余事件透传给真实 webContents。
      accumulatingWebContents = wrapWebContentsForRuntimeEvents(webContents, streamRecord, {
        conversationStore,
        llmConfigStore,
        emitRuntimeEvent,
        failRuntimeTurn: (reason) => runtimeSessions.failStream(streamId, reason),
      });
      streamRecord.runtimeWebContents = accumulatingWebContents;

      const toolContext = getConversationToolContext({ conversationId, workspacePath: runWorkspacePath });
      // 把本回合的交互模式写入（复用的）会话级 toolContext，供 goal 模式运行时闸门在工具
      // 执行层判定准入。见 Goal 模式运行时闸门设计。
      toolContext.mode = mode;
      toolContext.workspacePath = runWorkspacePath;
      toolContext.originWorkspacePath = goalWorkspaceBinding?.originWorkspacePath ?? conversationWorkspacePath;
      toolContext.targetWorkspacePath = goalWorkspaceBinding?.targetWorkspacePath ?? null;
      toolContext.readableRoots = goalWorkspaceBinding?.readableRoots ?? null;
      toolContext.writableRoots = goalWorkspaceBinding?.writableRoots ?? null;
      toolContext.permissionPolicy = permissionPolicy;
      // 把本回合的工具计数 sink 写入会话级 toolContext，供工具派发处实时回调。
      // 仅本回合有效，回合结束后由下一次 sendMessage 覆盖（无 sink 时复位为 null）。
      toolContext.onToolCall = agentProgress?.onToolCall ?? null;

      for (let attemptIndex = 0; attemptIndex < providerCandidates.length; attemptIndex += 1) {
        let provider = providerCandidates[attemptIndex];
        // 记录本轮实际命中的 provider 快照，供 usage 落盘归因。
        streamRecord.actualModelProviderId = provider?.id || null;
        streamRecord.actualModel = provider?.model || null;
        streamRecord.actualProviderName = provider?.name || null;
        streamRecord.actualPricing = {
          inputPrice: provider?.inputPrice,
          outputPrice: provider?.outputPrice,
          cacheReadPrice: provider?.cacheReadPrice,
          cacheWritePrice: provider?.cacheWritePrice,
        };
        streamRecord.actualPricingSource = provider?.pricingSource || null;
        let credential;
        try {
          credential = await resolveProviderCredential({ provider, llmConfigStore });
        } catch (credentialError) {
          accumulatingWebContents.send('chat:stream:error', {
            streamId,
            error: getProviderCredentialErrorCode(credentialError),
          });
          return;
        }
        if (!credential || streamRecord.terminalEventSent) return;
        // Gemini OAuth 需要 Code Assist projectId；缺失时通过 loadCodeAssist/onboardUser 解析并落盘。
        if (provider.authMethod === 'oauth_google' && credential.apiKey) {
          const existingProjectId = provider.oauthProjectId || credential.oauthProjectId || null;
          if (!existingProjectId) {
            try {
              const projectId = await resolveGeminiCodeAssistProjectId({
                accessToken: credential.apiKey,
                projectId: null,
                pollIntervalMs: 1000,
                maxPolls: 45,
                // 走 Electron net.fetch + 重试，避免 Node undici 在代理环境下超时后被误判为“缺少 project”。
                fetchImpl: (url, init) => fetchWithConnectionRecovery(url, init),
              });
              if (projectId && typeof llmConfigStore?.updateProvider === 'function') {
                llmConfigStore.updateProvider(provider.id, { oauthProjectId: projectId });
                provider = { ...provider, oauthProjectId: projectId };
              } else if (!projectId) {
                throw new Error(
                  'Gemini OAuth 尚未完成 Code Assist 项目初始化（缺少 cloudaicompanionProject）。请重新登录 Google，或确认账号已开通 Gemini Code Assist。',
                );
              }
            } catch (error) {
              // 项目解析失败时直接中断，避免无 project 打 streamGenerateContent 只得到含糊 500。
              throw error;
            }
          } else {
            provider = { ...provider, oauthProjectId: existingProjectId };
          }
        }
        const resolvedChannel = resolveChannel({
          ...provider,
          apiKey: credential.apiKey,
          accountId: credential.accountId,
          oauthProjectId: provider.oauthProjectId || credential.oauthProjectId || null,
        });
        const storedConversation = conversationId
          ? conversationStore?.getConversation?.(conversationId)
          : null;
        const accountingIdentity = {
          conversationId: conversationId || streamId,
          contentRevision:
            Number.isSafeInteger(storedConversation?.contentRevision)
            && storedConversation.contentRevision >= 0
              ? storedConversation.contentRevision
              : 0,
          modelKey: contextAccountingModelKey(provider.id, provider.model),
        };
        // Prefer current provider window (already tier-projected for Qoder) so
        // restored snapshots do not keep a stale capacity like 180k after 1M tier.
        const initialContextAccounting = reprojectContextAccountingWindow(
          storedConversation?.contextSnapshot?.version === 1
          && storedConversation.contextSnapshot.modelKey === accountingIdentity.modelKey
            ? storedConversation.contextSnapshot
            : null,
          provider.contextWindow,
        );

        const systemContext = buildSystemContext(runWorkspacePath, {
          contextAttachments,
          runtimeReminders,
          attachmentContext,
          configInstructions,
          contextExtensions: effectiveContextExtensions,
          explorerContext,
          verifierContext,
          continuityContext,
          conversationId,
          effort,
          mode,
          // goal-plan 事实上下文 Source（0006）：goal 模式下注入活动计划权威 taskId。
          goalPlanStore,
          // mcp-host 自我认知 Source：注入「我自己是 MCP host + 注册表路径 + 已装清单」。
          mcpRegistry,
          provider: resolvedChannel.legacyProvider,
          model: provider.model,
        });
        const systemPrompt = renderSystemContext(systemContext);
        recordPromptSnapshot(promptSnapshotStore, systemContext, {
          streamId,
          conversationId,
          contextEpochId: getActiveContextEpochId(promptSnapshotStore, conversationId),
          effort,
          provider: resolvedChannel.legacyProvider,
          providerId: provider.id,
          model: provider.model,
          mode,
          recoveryAttempt: attemptIndex + 1,
        });

        // 压缩后通过既有 Context Source 重建 system prompt（goal/mode/continuity 等）。
        // 只重建可权威回读的工作状态，不把 tool output 抬升为 system 指令。
        const rebuildSystemPrompt = async ({
          continuityContext: nextContinuityContext = continuityContext,
          reason = 'post-compact',
        } = {}) => {
          const rebuiltContext = buildSystemContext(runWorkspacePath, {
            contextAttachments,
            runtimeReminders,
            attachmentContext,
            configInstructions,
            contextExtensions: effectiveContextExtensions,
            explorerContext,
            verifierContext,
            continuityContext: nextContinuityContext,
            conversationId,
            effort,
            mode,
            goalPlanStore,
            mcpRegistry,
            provider: resolvedChannel.legacyProvider,
            model: provider.model,
          });
          const rebuiltPrompt = renderSystemContext(rebuiltContext);
          recordPromptSnapshot(promptSnapshotStore, rebuiltContext, {
            streamId,
            conversationId,
            contextEpochId: getActiveContextEpochId(promptSnapshotStore, conversationId),
            effort,
            provider: resolvedChannel.legacyProvider,
            providerId: provider.id,
            model: provider.model,
            mode,
            recoveryAttempt: attemptIndex + 1,
            rehydrateReason: reason,
          });
          return rebuiltPrompt;
        };

        // (a) 同 provider 流读取早期中断的自动重试：把单次尝试封装为闭包，便于在
        // replay-safe 且为可恢复传输失败时，从头重发同一请求（覆盖全部 wire）。
        const runProviderAttempt = async () => {
        const attemptStream = createProviderAttemptStream({
          webContents: accumulatingWebContents,
          streamId,
          provider,
        });
        const qoderCatalogMetadata = resolvedChannel.wire === 'qoder-private'
          ? getQoderModelMetadata(provider.model)
          : null;
        const qoderMetadata = qoderCatalogMetadata || provider.modelOptions?.length
          ? { ...qoderCatalogMetadata, modelOptions: provider.modelOptions ?? qoderCatalogMetadata?.modelOptions }
          : null;
        const qoderOptionProjection = resolvedChannel.wire === 'qoder-private'
          ? resolveQoderModelOptionProjection(qoderMetadata, provider.modelOptionValues)
          : null;
        const contextWindow = qoderOptionProjection?.inputTokenLimit || provider.contextWindow || 0;
        const maxOutputTokens = provider.maxOutputTokens || 0;
        const onNativeReasoningFallback = (details) => noteNativeReasoningFallback(provider, details);
        const runtimeTools = buildRuntimeTools({
          mcpRegistry,
          providerType: resolvedChannel.legacyProvider,
          mode,
        });

        try {
          if (resolvedChannel.wire === 'qoder-private') {
            await agentLoopQoder({
              baseUrl: provider.baseUrl,
              apiKey: credential.apiKey,
              model: provider.model,
              systemPrompt,
              messages,
              tools: runtimeTools.tools,
              webContents: attemptStream.webContents,
              streamId,
              signal: runtimeTurn.signal,
              contextWindow,
              modelOptions: provider.modelOptions,
              modelOptionValues: provider.modelOptionValues,
              effort,
              maxOutputTokens,
              conversationId,
              toolContext,
              workspacePath: runWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              goalPlanStore,
              ensureBrowserReady,
              agentProgress,
              resolvedChannel,
              // qoder 与其他 loop 同权:压缩必须持久化、携带连续性上下文、支持压缩后 system 重建。
              persistCompaction,
              continuityContext,
              rebuildSystemPrompt,
              emitRuntimeEvent: emitRuntimeEventPersistingAccounting,
              runtimeEventState: streamRecord.runtimeEventState,
              providerId: provider.id,
              runtimeMode: mode,
              accountingIdentity,
              initialContextAccounting,
            });
          } else if (resolvedChannel.wire === 'anthropic-messages') {
            await agentLoopAnthropic({
              baseUrl: provider.baseUrl,
              apiKey: credential.apiKey,
              model: provider.model,
              systemPrompt,
              messages,
              tools: runtimeTools.tools,
              webContents: attemptStream.webContents,
              streamId,
              signal: runtimeTurn.signal,
              effort,
              supportsReasoning: Boolean(provider.supportsReasoning),
              supportsPromptCaching: Boolean(provider.supportsPromptCaching),
              contextWindow,
              maxOutputTokens,
              conversationId,
              persistCompaction,
              continuityContext,
              rebuildSystemPrompt,
              toolContext,
              agentProgress,
              workspacePath: runWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              goalPlanStore,
              ensureBrowserReady,
              onNativeReasoningFallback,
              resolvedChannel,
              emitRuntimeEvent: emitRuntimeEventPersistingAccounting,
              runtimeEventState: streamRecord.runtimeEventState,
              providerId: provider.id,
              runtimeMode: mode,
              accountingIdentity,
              initialContextAccounting,
            });
          } else if (resolvedChannel.wire === 'gemini') {
            await agentLoopGemini({
              baseUrl: provider.baseUrl,
              apiKey: credential.apiKey,
              model: provider.model,
              systemPrompt,
              messages,
              tools: runtimeTools.tools,
              webContents: attemptStream.webContents,
              streamId,
              signal: runtimeTurn.signal,
              effort,
              supportsReasoning: Boolean(provider.supportsReasoning),
              contextWindow,
              maxOutputTokens,
              conversationId,
              persistCompaction,
              continuityContext,
              rebuildSystemPrompt,
              toolContext,
              agentProgress,
              workspacePath: runWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              goalPlanStore,
              ensureBrowserReady,
              resolvedChannel,
              authMethod: credential.authMethod,
              emitRuntimeEvent: emitRuntimeEventPersistingAccounting,
              runtimeEventState: streamRecord.runtimeEventState,
              providerId: provider.id,
              runtimeMode: mode,
              accountingIdentity,
              initialContextAccounting,
            });
          } else {
            await agentLoopOpenAI({
              baseUrl: provider.baseUrl,
              apiKey: credential.apiKey,
              model: provider.model,
              systemPrompt,
              messages,
              tools: runtimeTools.tools,
              webContents: attemptStream.webContents,
              streamId,
              signal: runtimeTurn.signal,
              effort,
              supportsReasoning: Boolean(provider.supportsReasoning),
              supportsPromptCaching: Boolean(provider.supportsPromptCaching),
              contextWindow,
              maxOutputTokens,
              conversationId,
              persistCompaction,
              continuityContext,
              rebuildSystemPrompt,
              toolContext,
              agentProgress,
              workspacePath: runWorkspacePath,
              permissionGate,
              registry: runtimeTools.registry,
              runtimeProjection: runtimeTools.runtimeProjection,
              mcpRegistry,
              goalPlanStore,
              ensureBrowserReady,
              onNativeReasoningFallback,
              authMethod: credential.authMethod,
              accountId: credential.accountId,
              resolvedChannel,
              emitRuntimeEvent: emitRuntimeEventPersistingAccounting,
              runtimeEventState: streamRecord.runtimeEventState,
              providerId: provider.id,
              runtimeMode: mode,
              accountingIdentity,
              initialContextAccounting,
            });
          }
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          attemptStream.webContents.send('chat:stream:error', {
            streamId,
            error: describeFetchFailure(err),
          });
        }
          return attemptStream;
        };

        // (a) 同 provider 自动重试：仅在 replay-safe（未发出任何 delta/thinking/
        // tool-call/usage 等）且为可恢复传输失败（ECONNRESET/terminated 等）时，从头
        // 重发同一请求；复用既有连接退避与 chat:stream:connection-recovery 事件。
        // 用户 abort（AbortError）与已产出内容的长流中断不在此自动重试范围内。
        const sameProviderMax = SAME_PROVIDER_RETRY_DELAYS_MS.length;
        let attemptStream;
        let attemptResult;
        for (let retry = 0; ; retry += 1) {
          attemptStream = await runProviderAttempt();
          attemptResult = attemptStream.getResult();
          const canRetrySameProvider =
            attemptResult.terminalError &&
            !attemptResult.terminalSent &&
            attemptResult.sameProviderRetryable &&
            retry < sameProviderMax;
          if (!canRetrySameProvider) {
            if (retry > 0 && !attemptResult.terminalError) {
              accumulatingWebContents.send('chat:stream:connection-recovery', {
                streamId,
                conversationId,
                provider: describeProviderTarget(provider),
                model: provider.model,
                status: 'recovered',
                attempt: retry,
                maxRetries: sameProviderMax,
              });
            }
            break;
          }
          const delayMs = SAME_PROVIDER_RETRY_DELAYS_MS[retry];
          accumulatingWebContents.send('chat:stream:connection-recovery', {
            streamId,
            conversationId,
            provider: describeProviderTarget(provider),
            model: provider.model,
            status: 'retrying',
            attempt: retry + 1,
            maxRetries: sameProviderMax,
            delayMs,
            reason: attemptResult.errorText,
          });
          console.warn(
            `[llm-chat] same-provider stream retry ${retry + 1}/${sameProviderMax}: ${describeProviderTarget(provider)} (${attemptResult.errorText})`
          );
          await sleepWithSignal(delayMs, runtimeTurn.signal);
        }

        if (!attemptResult.terminalError || attemptResult.terminalSent) return;

        const nextProvider = providerCandidates[attemptIndex + 1] ?? null;
        if (nextProvider && attemptResult.replayable) {
          accumulatingWebContents.send('chat:stream:provider-recovery', {
            streamId,
            conversationId,
            fromProviderId: provider.id,
            fromProvider: describeProviderTarget(provider),
            toProviderId: nextProvider.id,
            toProvider: describeProviderTarget(nextProvider),
            reason: attemptResult.errorText,
            attempt: attemptIndex + 1,
          });
          console.warn(
            `[llm-chat] provider recovery: ${describeProviderTarget(provider)} -> ${describeProviderTarget(nextProvider)} (${attemptResult.errorText})`
          );
          continue;
        }

        attemptStream.flushError();
        return;
      }
    } catch (err) {
      console.error('[llm-chat] error:', err);
      if (err?.name === 'AbortError') {
        // 用户主动中断:补发 aborted 终态(若 abort() 已发则被去重保护跳过)。
        if (!streamRecord.terminalEventSent) {
          accumulatingWebContents.send('chat:stream:aborted', { streamId });
        }
      } else {
        accumulatingWebContents.send('chat:stream:error', {
          streamId,
          error: describeFetchFailure(err),
        });
      }
    } finally {
      permissionGate.settleStreamPermissionRequests(streamId, {
        granted: false,
        reason: 'stream_finished',
      });
      // 终态兜底:任何路径(含压缩等中间阶段提前 return / 静默吞错)都必须解锁渲染端,
      // 否则停止按钮会一直悬挂。恰好发一次,依赖 terminalEventSent 去重。
      if (!streamRecord.terminalEventSent) {
        accumulatingWebContents.send('chat:stream:error', {
          streamId,
          error: 'stream_terminated_without_result',
        });
        streamRecord.terminalEventSent = true;
        streamRecord.terminalStatus = 'error';
        streamRecord.interrupted = true;
        streamRecord.persist?.({ final: true, interrupted: true });
      }
      // Runtime SDK 持有 session/turn 终态真值；Desktop Adapter 只映射既有 UI 终态。
      runtimeSessions.settleStream(
        streamId,
        streamRecord.terminalStatus || 'error',
        streamRecord.terminalStatus || 'stream_error',
      );
      streamRecord.resolveReleased?.();
      streamRecord.resolveReleased = null;
      // 方案 3：不立即删除，保留终态记录一段时间，使切回已结束的后台轮次可经
      // reattach 回放完整终态快照；保留期满后由 retireStream 内的计时器硬删除。
      retireStream(streamId);
      return buildAgentRunOutcome(streamRecord);
    }
  }

  /**
   * Goal handoff 专用：等待 intake 流自行完成 terminal tool 收尾；只有超时才强制兜底。
   *
   * goal_create_plan 会同步触发 plan change，而此时 tools.execute 尚未返回，tool result 也尚未
   * 写回 Runtime 消息。若这里立即发裸 done + cancel，会抢在 agent loop 的正常 sendDone 前面，
   * terminalEventSent 随即阻断携带 nextRequestInputTokens 的正确 done，导致 contextSnapshot 永久 null。
   *
   * 因此先给 pipeline 一个短暂自然收尾窗口：applyToolResults → onStopped → sendDone → 持久化
   * contextSnapshot。仅在该路径真的卡住时，才沿用旧的强制 done/cancel 兜底以解锁 UI。
   */
  function forceCompleteConversationStreams(
    conversationId,
    { reason = 'goal_handoff', graceMs = 250 } = {},
  ) {
    const normalized = typeof conversationId === 'string' ? conversationId.trim() : '';
    if (!normalized) return { completed: 0, streamIds: [], released: Promise.resolve([]) };
    const completedIds = [];
    const releasePromises = [];
    const normalizedGraceMs = Number.isFinite(Number(graceMs))
      ? Math.max(0, Number(graceMs))
      : 250;

    for (const [streamId, record] of activeStreams.entries()) {
      if (record?.conversationId !== normalized) continue;
      if (!isRunning(record)) continue;
      if (record.released) releasePromises.push(record.released);
      completedIds.push(streamId);

      setTimeout(() => {
        // 正常 terminal tool 路径已经发送权威 done 或释放 turn：不再干预。
        if (!isRunning(record) || record.terminalEventSent) return;

        const payload = {
          streamId,
          conversationId: normalized,
          reason,
        };
        try {
          (record.runtimeWebContents || record.webContents)?.send?.('chat:stream:done', payload);
        } catch (error) {
          console.warn('[llm-chat] force-complete done send failed:', error?.message || error);
        }
        // runtimeWebContents owns terminal persistence and maps this reason to goal_handoff.
        // Keep the fallback assignment for records created before that wrapper is available.
        if (!record.terminalEventSent) {
          record.terminalEventSent = true;
          record.terminalStatus = reason === 'goal_handoff' ? 'goal_handoff' : 'done';
          record.interrupted = false;
        }

        try {
          runtimeSessions.cancelStream(streamId, reason);
        } catch (error) {
          console.warn('[llm-chat] force-complete cancel failed:', error?.message || error);
        }
        permissionGate.settleStreamPermissionRequests(streamId, {
          granted: false,
          reason,
        });
        try {
          runtimeSessions.settleStream(streamId, 'completed', reason);
        } catch {}
        // Handoff waits on released; resolve here so Runner is not blocked if the
        // original sendMessage finally path is delayed or never reached.
        record.resolveReleased?.();
        record.resolveReleased = null;
        retireStream(streamId);
      }, normalizedGraceMs);
    }

    return {
      completed: completedIds.length,
      streamIds: completedIds,
      released: Promise.allSettled(releasePromises),
    };
  }

  function abort(streamId) {
    const active = activeStreams.get(streamId);
    if (!active) return { aborted: false };
    runtimeSessions.cancelStream(streamId, 'user_aborted');
    permissionGate.settleStreamPermissionRequests(streamId, {
      granted: false,
      reason: 'stream_aborted',
    });
    active.webContents.send('chat:stream:aborted', {
      streamId,
      ...(active.conversationId ? { conversationId: active.conversationId } : {}),
    });
    // abort 直接走真实 webContents，绕过累积代理；故在此显式收口终态并落盘，
    // 再走保留期（不立即删除），让切回被中断的后台轮次也能回放已累积正文。
    active.terminalEventSent = true;
    active.terminalStatus = 'aborted';
    active.interrupted = true;
    active.persist?.({ final: true, interrupted: true });
    // Ensure handoff / waiters do not hang if sendMessage finally is delayed.
    active.resolveReleased?.();
    active.resolveReleased = null;
    retireStream(streamId);
    return { aborted: true };
  }

  function resolvePermissionGrant(toolCallId, grant) {
    return permissionGate.settlePermissionRequest(toolCallId, grant);
  }

  /**
   * ADR 22: 重载后认领进行中的流。只读,不改变流状态。
   * 匹配优先级:
   * - 传 streamId:返回该流快照(不存在返回 null)。
   * - 传 conversationId:返回该会话的活跃流(避免跨会话误认领)。
   * - 都不传:存在唯一活跃流时返回它;无/多条时返回 null。
   */
  function reattach({ streamId, conversationId } = {}) {
    let record = null;
    let id = streamId ?? null;
    if (id != null) {
      record = activeStreams.get(id) ?? null;
    } else if (conversationId != null) {
      // 方案 3：同一会话可能同时存在「正在运行的新流」与「已终结保留的旧流」。
      // 切回时优先认领运行中的流；没有运行中的，再回退到最近一条保留的终态记录，
      // 使切回已结束的后台轮次也能回放完整终态快照。
      let runningMatch = null;
      let retainedMatch = null;
      for (const [activeId, activeRecord] of activeStreams.entries()) {
        if (activeRecord?.conversationId !== conversationId) continue;
        if (isRunning(activeRecord)) {
          runningMatch = [activeId, activeRecord];
          break;
        }
        if (!retainedMatch || (activeRecord.retainedAt ?? 0) > (retainedMatch[1].retainedAt ?? 0)) {
          retainedMatch = [activeId, activeRecord];
        }
      }
      const chosen = runningMatch ?? retainedMatch;
      if (chosen) {
        id = chosen[0];
        record = chosen[1];
      }
    } else if (activeStreams.size === 1) {
      const only = activeStreams.entries().next().value;
      id = only?.[0] ?? null;
      record = only?.[1] ?? null;
    }
    if (!record || id == null) return null;
    const running = isRunning(record);
    return {
      streamId: id,
      conversationId: record.conversationId ?? null,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
      accumulatedText: record.accumulatedText ?? '',
      accumulatedThinking: record.accumulatedThinking ?? '',
      segments: Array.isArray(record.segments) ? record.segments.map((segment) => ({ ...segment })) : [],
      isStreaming: running,
      // 终态快照：切回已结束轮次时，表达层据此补齐完整正文/工具段并标注中断态，
      // 而非重新挂一个「进行中」的假象。running=true 时这些字段为中性默认值。
      terminalStatus: running ? null : (record.terminalStatus ?? null),
      interrupted: running ? false : Boolean(record.interrupted),
      usage: record.finalUsage ?? null,
      lifetimeUsage: record.lifetimeUsage ?? null,
    };
  }

  return {
    sendMessage,
    abort,
    forceCompleteConversationStreams,
    setWorkspacePath,
    setLocalAccessLevel,
    resolvePermissionGrant,
    reattach,
    listActiveConversationIds,
    listActiveStreams,
  };
}
