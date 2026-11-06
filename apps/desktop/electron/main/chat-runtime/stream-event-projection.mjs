import { joinSummaryThinkingContent } from "../thinking-summary-join.mjs";
import { resolveConversationModelBindingPatch } from "./provider-recovery-broker.mjs";
import { detectTailRepetition } from "../repetition-detector.mjs";
import { createStreamProfiler, isStreamProfilingEnabled } from "../stream-profiler.mjs";
import { createUsageRequestLog } from "../usage-request-log.mjs";
import { recordDetachedTurnUsage } from "../background-turn-usage.mjs";
import { estimateUsageCostUsd } from "../usage-pricing.mjs";
import { persistContextAccounting } from "./persist-context-accounting.mjs";
import { createStreamTerminalDelivery } from "./stream-terminal-delivery.mjs";

export const usageRequestLog = createUsageRequestLog();

// 流式链路计时埋点（PEER_STREAM_PROFILE=1 开启；关闭时零成本）。
const streamProfiler = createStreamProfiler({ enabled: isStreamProfilingEnabled() });

export function hasBillableUsage(usage) {
  return Boolean(
    (usage?.inputTokens || 0) ||
    (usage?.outputTokens || 0) ||
    (usage?.cacheWriteTokens || 0) ||
    (usage?.cacheReadTokens || 0)
  );
}

/** 续写流的 usage 合并：中断前旧账 + 本轮增量（token 数量按字段相加）。 */
export function mergeUsageAmounts(seedUsage, turnUsage) {
  const sum = (a, b) => (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
  return {
    ...(turnUsage || {}),
    inputTokens: sum(seedUsage?.inputTokens, turnUsage?.inputTokens),
    outputTokens: sum(seedUsage?.outputTokens, turnUsage?.outputTokens),
    totalTokens: sum(seedUsage?.totalTokens, turnUsage?.totalTokens),
    cacheReadTokens: sum(seedUsage?.cacheReadTokens, turnUsage?.cacheReadTokens),
    cacheWriteTokens: sum(seedUsage?.cacheWriteTokens, turnUsage?.cacheWriteTokens),
  };
}

function isRequestUserInputToolName(toolName) {
  return toolName === 'request_user_input'
    || (typeof toolName === 'string' && toolName.endsWith('.request_user_input'));
}

function usageAttributionExtras(streamRecord) {
  const role = streamRecord?.turnProfile?.role;
  const workspaceId = streamRecord?.turnProfile?.workspaceId;
  return {
    ...(typeof role === 'string' && role.trim() ? { role: role.trim() } : {}),
    ...(typeof workspaceId === 'string' && workspaceId.trim() ? { workspaceId: workspaceId.trim() } : {}),
  };
}

function recordConversationUsage({ conversationStore, streamRecord, usage, usageRequestLog, llmConfigStore }) {
  if (!hasBillableUsage(usage) || streamRecord?.usageRecorded) return null;
  if (!streamRecord?.conversationId) {
    try {
      const recorded = recordDetachedTurnUsage({ streamRecord, usage, usageRequestLog });
      if (recorded) streamRecord.usageRecorded = true;
      return recorded;
    } catch (error) {
      console.warn('[llm-chat] failed to record background usage:', error?.message || error);
      return null;
    }
  }
  if (!conversationStore?.recordRuntimeTurnUsage && !conversationStore?.addUsage) return null;
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
            ...usageAttributionExtras(streamRecord),
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
          ...usageAttributionExtras(streamRecord),
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

// 终态落盘兜底：把「已发出但未回填结果」的 tool-call 段补写一个明确的中断 result，
// 使其在持久化后脱离「执行中（永久转圈）」态。背景：渲染层三个终态 handler 已对 live
// segments 做过同样收尾，但仅当终态事件 streamId 与当前会话匹配时才生效；后台会话（已
// 切走）或事件 streamId 不匹配时，真值来源是这里的落盘 + 切回时的会话重载。因此必须在
// 主进程的终态落盘汇聚点再兜一次，否则切回会话仍会看到永久转圈的工具段。
// 与渲染层口径一致：result === undefined 且 synthetic !== true 视为悬空段。
// 纯函数：无悬空段时返回原数组引用，调用方据此可跳过无谓写入。
export function terminalDanglingNote(terminalStatus) {
  if (terminalStatus === 'goal_handoff') return null;
  if (terminalStatus === 'aborted') return '工具调用已中断（生成停止）';
  if (terminalStatus === 'error') return '工具调用已中断（连接出错）';
  return '工具结果未返回（本轮已结束）';
}

export function finalizeDanglingToolSegments(segments, terminalStatus) {
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
export function wrapWebContentsForRuntimeEvents(
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
  // 流式期间按时间节流写 sidecar；终态在 worker 准备后提交，落盘完成才通知并释放 turn。
  const PERSIST_THROTTLE_MS = 500;
  let lastPersistAt = 0;
  let terminalPatch;
  const persistStreamRecord = ({ final = false, interrupted = false } = {}) => {
    if (final && streamRecord.finalPersistence) return streamRecord.finalPersistence;
    // 终态收口：accounting 落盘是节流的，窗口内最后一次观测值可能还挂在 pending 上。
    // 在这里补写，保证 done/aborted/error 之后百分比不会停在旧值（非终态时是 no-op）。
    if (final) streamRecord?.flushPendingAccounting?.();
    if (!conversationStore?.updateMessageById) return;
    if (!streamRecord?.conversationId) return;
    // 没有明确 assistantMessageId 时绝不回写：否则会落到会话最后一条 assistant，
    // 把 Verifier 的 JSON 验收结果盖到用户可见回复上。
    if (!streamRecord?.assistantMessageId) return;
    // Explorer / Verifier 等内部旁路流不落盘。
    if (streamRecord?.ephemeral) return;
    const now = Date.now();
    if (!final && now - lastPersistAt < PERSIST_THROTTLE_MS) {
      streamProfiler.bump('main.persist.skipped');
      return;
    }
    lastPersistAt = now;
    streamProfiler.bump(final ? 'main.persist.final' : 'main.persist');
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
      // 续写流：usage 是「中断前旧值 + 本轮增量」的合计。覆盖会吞掉中断前
      // 已累积的 token 账目（多轮工具调用中断后续写的场景）。
      patch.usage = streamRecord.resumeSeedUsage && hasBillableUsage(streamRecord.resumeSeedUsage)
        ? { ...mergeUsageAmounts(streamRecord.resumeSeedUsage, streamRecord.finalUsage) }
        : { ...streamRecord.finalUsage };
    }
    if (final && interrupted) {
      patch.interrupted = true;
      patch.streamFailure = { code: streamRecord.failureReason || 'reply_interrupted' };
      streamRecord.streamFailure = patch.streamFailure;
    } else if (final && streamRecord.resumedFromMessageId) {
      // 续写成功收尾：清掉种子消息上的 interrupted 残留，否则 updateMessageById 的
      // spread 合并会保留旧标记，UI 永远显示「已中断」。普通（非续写）流的新消息
      // 本来就没有该字段，不受影响。
      patch.interrupted = false;
      patch.streamFailure = null;
    }
    try {
      if (final) terminalPatch = patch;
      // 这里只计提交入队成本；异步终态的完成以 finalPersistence 为准。
      const committed = streamProfiler.measure(final ? 'main.persist.write.final' : 'main.persist.write', () => {
        if (final && typeof conversationStore.commitStreamingMessage === 'function') {
          return conversationStore.commitStreamingMessage(streamRecord.conversationId, streamRecord.assistantMessageId, patch);
        } else if (final) {
          // 旧 store 适配器兼容路径；生产 Conversation Store 提供异步提交。
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
      });
      if (committed?.then) { streamRecord.finalPersistence = committed; return committed; }
    } catch (err) {
      console.warn('[llm-chat] persist stream record failed:', err?.message || err);
      if (final) return Promise.reject(err);
    }
  };
  streamRecord.persist = persistStreamRecord;
  const deliverTerminal = createStreamTerminalDelivery({ record: streamRecord,
    send: (channel, payload) => realWebContents.send(channel, payload), failRuntimeTurn,
    onPersistenceFailure: streamFailure => {
      if (!streamRecord.ephemeral && streamRecord.conversationId && streamRecord.assistantMessageId) {
        conversationStore?.patchStreamingMessage?.(streamRecord.conversationId, streamRecord.assistantMessageId, {
          ...terminalPatch, interrupted: true, streamFailure,
        });
      }
    } });

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
      const terminal = ['chat:stream:done', 'chat:stream:error', 'chat:stream:aborted'].includes(channel);
      if (terminal && streamRecord.terminalNotificationRegistered) return false;
      let terminalPersistence;
      // 终态守卫：一旦本轮已发出终态（done/error/aborted，含复读兜底自动 error），
      // 丢弃所有后续在途的正文/思考 delta，避免「已收口却仍继续转发残留」导致刷屏。
      if (
        streamRecord.terminalEventSent &&
        (channel === 'chat:stream:delta' || channel === 'chat:stream:thinking')
      ) {
        return false;
      }
      if (channel === 'chat:stream:delta' && typeof payload?.content === 'string') {
        if (streamProfiler.enabled) {
          streamProfiler.bump('main.delta');
          streamProfiler.setGauge('accTextChars', streamRecord.accumulatedText.length);
        }
        streamProfiler.measure('main.delta.runtimeEvent', () =>
          emitStreamRuntimeEvent({ type: 'message.delta', content: payload.content }),
        );
        streamProfiler.measure('main.delta.accumulate', () => {
          streamRecord.accumulatedText += payload.content;
          appendTextSegment('text', payload.content);
        });
        persistStreamRecord();
        // 复读兜底：命中尾部周期检测即视为模型卡死，主动 abort 并以 error 收口本轮。
        // delta 属于 REPLAY_UNSAFE 通道，terminalEventSent 置位后不会触发重试/切 provider。
        const repetition = streamProfiler.measure('main.delta.repetition', () =>
          detectTailRepetition(streamRecord.accumulatedText),
        );
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
          terminalPersistence = persistStreamRecord({ final: true, interrupted: true });
          try {
            failRuntimeTurn?.('repetition_detected');
          } catch {
            /* 已中断时忽略 */
          }
          realWebContents.send('chat:stream:delta', payload);
          return deliverTerminal(terminalPersistence, 'chat:stream:error', errorPayload);
        }
      } else if (channel === 'chat:stream:thinking' && typeof payload?.content === 'string') {
        const thinkingKind =
          payload.kind === 'summary' || payload.kind === 'reasoning'
            ? payload.kind
            : undefined;
        if (streamProfiler.enabled) {
          streamProfiler.bump('main.thinking');
          streamProfiler.bump(`main.thinking.kind.${thinkingKind ?? 'none'}`);
          streamProfiler.setGauge('accThinkingChars', (streamRecord.accumulatedThinking || '').length);
        }
        streamProfiler.measure('main.thinking.runtimeEvent', () =>
          emitStreamRuntimeEvent({
            type: 'reasoning.delta',
            content: payload.content,
            ...(thinkingKind ? { kind: thinkingKind } : {}),
          }),
        );
        // Keep accumulatedThinking consistent with segment join rules (summary-only breaks).
        streamProfiler.measure('main.thinking.accumulate', () => {
          streamRecord.accumulatedThinking =
            thinkingKind === 'summary'
              ? joinSummaryThinkingContent(streamRecord.accumulatedThinking || '', payload.content)
              : `${streamRecord.accumulatedThinking || ''}${payload.content}`;
          appendTextSegment('thinking', payload.content, thinkingKind);
        });
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
        if (erroredTerminal && typeof payload?.error === 'string' && payload.error.trim()
          && typeof streamRecord.failureReason !== 'string') {
          streamRecord.failureReason = payload.error.trim();
        }
        if (payload?.usage) streamRecord.finalUsage = payload.usage;
        if (payload?.lifetimeUsage) streamRecord.lifetimeUsage = payload.lifetimeUsage;
        if (erroredTerminal) {
          emitStreamRuntimeEvent({
            type: 'runtime.error',
            code: typeof payload?.error === 'string' ? payload.error : 'stream_error',
            message: typeof payload?.message === 'string' ? payload.message : undefined,
            details: payload,
          });
        }
        terminalPersistence = persistStreamRecord({ final: true, interrupted: erroredTerminal });
        if (payload?.contextAccounting?.version === 1
          && typeof conversationStore?.updateContextSnapshot === 'function'
          && streamRecord.conversationId
          // 观测即持久化后,同一快照可能已在 context.accounting 事件时落盘;
          // 终态重复写会造成双写,据 persistKey 去重。
          && contextSnapshotPersistKey(payload.contextAccounting)
            !== streamRecord.persistedContextSnapshotKey) {
          persistContextAccounting({
            store: conversationStore,
            conversationId: streamRecord.conversationId,
            streamId: streamRecord.streamId,
            snapshot: payload.contextAccounting,
            emit: emitRuntimeEvent,
          });
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
        terminalPersistence = persistStreamRecord({ final: true, interrupted: true });
      }
      const routedPayload = (
        channel === 'chat:stream:done'
        || channel === 'chat:stream:error'
        || channel === 'chat:stream:aborted'
      ) && streamRecord.conversationId
        ? { ...payload, conversationId: streamRecord.conversationId }
        : payload;
      return terminal ? deliverTerminal(terminalPersistence, channel, routedPayload,
        channel === 'chat:stream:done' ? () => emitStreamRuntimeEvent({
          type: 'message.completed', content: streamRecord.accumulatedText || undefined,
          usage: payload?.usage, lifetimeUsage: payload?.lifetimeUsage,
          finishReason: typeof payload?.finishReason === 'string' ? payload.finishReason : undefined,
        }) : undefined) : realWebContents.send(channel, routedPayload);
    },
  };
}

/**
 * 观测快照的落盘去重键:同一 (modelKey, revision, lastObserved.at) 视为同一次观测,
 * 终态(done/error)不再重复写 sidecar。
 */
export function contextSnapshotPersistKey(snapshot) {
  if (!snapshot || snapshot.version !== 1) return null;
  return `${snapshot.modelKey}::${snapshot.revision ?? 0}::${snapshot.lastObserved?.at ?? ''}`;
}
