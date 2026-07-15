// 应用级单例流订阅路由器（方案 C / 甲-1）。
//
// 根因背景：
//   过去 useChatStreamSubscription 以「单 streamIdRef 过滤」工作——每个 ChatSurface 实例
//   只认自己当前的 streamId，其余事件丢弃。这与「ChatSurface 内十几个 useState」叠加，使
//   会话身份与会话内容两份状态无法原子绑定，切会话时必然出现「id 已新、内容还旧」的中间态
//   （即「新会话/切换会话串入其它会话内容」的根因）。
//
//   本路由器把流订阅上移为「全应用唯一一份」：在 App 顶层挂载一次，订阅全部 13 个
//   chatStream 事件，并按 streamId → conversationId（conversationStore.resolveConversation）
//   把每个事件路由到对应会话桶。于是：
//     - 前台会话（cid === activeConversationId）的正文/思考 delta 走打字机平滑吐字；
//     - 后台会话（cid !== activeConversationId）的 delta 直接整段写入其桶（不做逐字动画）；
//     - 终结类事件（done/aborted/error）清理对应桶的运行态并把表达层落回主进程持久化。
//   组件不再持有会话运行态，切会话只是「换订阅 key」，物理上不存在被复用的 messages 槽位。
//
// 真值边界：发送链路与用量账本真值仍在主进程；本路由器只把主进程下发的事件映射到表达层，
//   并通过 conversationsReplaceMessages 把内存消息回写主进程的开放袋（与原 hook 一致）。

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { clientApi } from '../../clientApi';
import { conversationStore } from '../state/conversationStore';
import { reduceCompactionLifecycle } from '../state/compactionLifecycle';
import { mergeLoadedMessagesWithLiveTail } from '../state/compactionLiveTailMerge';
import { loadConversationMessages, usageFromLifetime } from '../state/conversationLoad';
import { IDLE_COMPACTION_STATE } from '../state/types';
import {
  getTextContent,
  isEmptyAssistantPlaceholder,
  markDanglingToolCallsInterrupted,
} from '../state/streamSegments';
import type { ChatMsg } from '../state/types';
import { useTypewriterStream } from './useTypewriterStream';

/** 路由器需要的、无法下沉到 store 的应用级回调（按会话 id 携带上下文）。 */
export interface ConversationStreamRouterParams {
  /** 当前前台会话 id。前台 delta 走打字机，后台 delta 直接整段写桶。 */
  activeConversationId: string | null;
  /** 某会话内容发生变化（用于侧栏列表刷新等）。 */
  onConversationUpdated?: (conversationId: string) => void;
  /** 前台会话触发内置浏览器工具时，请求上层自动展开 Workbench。仅前台触发。 */
  onBrowserToolActivity?: (tool: string) => void;
  /** 回合结束且主进程判定已越过压缩阈值时，请求上层对该会话跑一次自动压缩。 */
  onCompactionSuggested?: (conversationId: string) => void;
}

// —— 纯函数助手：与 ChatSurface 内原 appendStreamText/appendStreamThinking 逐字一致，
//    仅改为「输入只读消息数组、输出新数组」的纯形态，供桶级 setState 复用。——

/** 追加正文 delta：并入末尾 text 段或新建 text 段。非 assistant 尾返回原数组。 */
function appendText(messages: readonly ChatMsg[], chunk: string): ChatMsg[] {
  const prev = messages as ChatMsg[];
  if (!chunk) return prev;
  const last = prev[prev.length - 1];
  if (!last || last.role !== 'assistant') return prev;
  const segments = [...(last.segments || [])];
  const lastSeg = segments[segments.length - 1];
  if (lastSeg && lastSeg.type === 'text') {
    segments[segments.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + chunk };
  } else {
    segments.push({ type: 'text', content: chunk });
  }
  return [...prev.slice(0, -1), { ...last, content: getTextContent(segments), segments }];
}

/** 追加思考 delta：仅与活跃的尾部 thinking 段合并，工具调用后新起一段。 */
function appendThinking(messages: readonly ChatMsg[], chunk: string): ChatMsg[] {
  const prev = messages as ChatMsg[];
  if (!chunk) return prev;
  const last = prev[prev.length - 1];
  if (!last || last.role !== 'assistant') return prev;
  const segments = [...(last.segments || [])];
  const lastSeg = segments[segments.length - 1];
  if (lastSeg && lastSeg.type === 'thinking') {
    segments[segments.length - 1] = { type: 'thinking', content: (lastSeg.content || '') + chunk };
  } else {
    segments.push({ type: 'thinking', content: chunk });
  }
  return [...prev.slice(0, -1), { ...last, segments }];
}

/** 把内存消息映射回主进程持久化（与原 hook persistMessages 逐字一致，按会话 id）。 */
function persistMessages(conversationId: string, msgs: readonly ChatMsg[]): void {
  if (!conversationId) return;
  void clientApi.conversationsReplaceMessages({
    id: conversationId,
    messages: msgs.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      segments: m.segments,
      usage: m.usage,
      durationMs: m.durationMs,
      _compaction: m.compaction,
      attachments: m.attachments,
      interrupted: m.interrupted,
    })),
  });
}

/**
 * 在 App 顶层挂载一次的全局流路由器。返回前台打字机控制器，供前台 ChatSurface 在发送时
 * reset（切流时清空残留缓冲），其余调用方无需关心。
 */
export function useConversationStreamRouter(params: ConversationStreamRouterParams): {
  textTypewriter: ReturnType<typeof useTypewriterStream>;
  thinkingTypewriter: ReturnType<typeof useTypewriterStream>;
} {
  const { activeConversationId, onConversationUpdated, onBrowserToolActivity, onCompactionSuggested } =
    params;

  // 用 ref 持有「当前前台会话 / 最新回调」，让稳定的事件处理闭包始终读到最新值，
  // 从而把全部订阅放进一个「只挂载一次」的 effect，避免频繁解绑/重绑。
  const activeRef = useRef<string | null>(activeConversationId);
  const onUpdatedRef = useRef(onConversationUpdated);
  onUpdatedRef.current = onConversationUpdated;
  const onBrowserRef = useRef(onBrowserToolActivity);
  onBrowserRef.current = onBrowserToolActivity;
  const onCompactionRef = useRef(onCompactionSuggested);
  onCompactionRef.current = onCompactionSuggested;

  // 前台打字机：onText 落到「当前前台会话」桶。后台会话不经打字机（直接整段写桶）。
  const appendActiveText = useCallback((chunk: string) => {
    const cid = activeRef.current;
    if (!cid || !chunk) return;
    conversationStore.setState(cid, (prev) => ({ messages: appendText(prev.messages, chunk) }));
  }, []);
  const appendActiveThinking = useCallback((chunk: string) => {
    const cid = activeRef.current;
    if (!cid || !chunk) return;
    conversationStore.setState(cid, (prev) => ({ messages: appendThinking(prev.messages, chunk) }));
  }, []);
  const textTypewriter = useTypewriterStream(appendActiveText);
  const thinkingTypewriter = useTypewriterStream(appendActiveThinking);
  const flushTextTypewriter = textTypewriter.flush;
  const flushThinkingTypewriter = thinkingTypewriter.flush;

  useLayoutEffect(() => {
    if (activeRef.current === activeConversationId) return;
    // 切前台会话前，先把旧前台会话已收到但仍在打字机 buffer 里的 delta 落到旧桶。
    // 不能 reset 丢弃，否则后台 done 可能用缺字的 renderer 快照回写主进程。
    flushThinkingTypewriter();
    flushTextTypewriter();
    activeRef.current = activeConversationId;
  }, [activeConversationId, flushTextTypewriter, flushThinkingTypewriter]);

  useEffect(() => {
    // 按会话保存「完成后短暂停顿再隐藏」的 timer，并绑定触发它的 streamId。
    // 单例 timer 会让会话 A / 旧压缩流的迟到收尾误清会话 B / 新压缩流。
    const compactionDoneTimers = new Map<
      string,
      { streamId: string; timer: ReturnType<typeof setTimeout> }
    >();
    const cancelCompactionDoneTimer = (cid: string, streamId?: string) => {
      const entry = compactionDoneTimers.get(cid);
      if (!entry || (streamId && entry.streamId !== streamId)) return;
      clearTimeout(entry.timer);
      compactionDoneTimers.delete(cid);
    };

    // 兜底清除“正在重试连接”横幅：连接若在 SSE 正文阶段恢复，recovering-fetch 已
    // return，不会补发 recovered 事件，横幅会一直残留。收到真实数据/收尾事件即收敛。
    const clearRecoveryNotice = (cid: string) => {
      if (conversationStore.getSnapshot(cid).providerRecoveryNotice) {
        conversationStore.setState(cid, { providerRecoveryNotice: null });
      }
    };

    const offRuntimeEvent = clientApi.onRuntimeEvent((event) => {
      if (event.protocolVersion !== 1) return;
      if (event.type === 'session.started' && event.streamId && event.conversationId) {
        conversationStore.routeStream(event.streamId, event.conversationId);
      }
    });

    const offDelta = clientApi.onChatStreamDelta(({ streamId, content }) => {
      const cid = conversationStore.resolveConversation(streamId);
      if (!cid) return;
      // 兜底清除“正在重试连接”横幅：正文已在流式输出即证明连接已恢复。
      // 恢复发生在 SSE 正文阶段时，recovering-fetch 已 return，不会补发 recovered
      // 事件，横幅便会一直挂着（本次 bug 根因）。此处收到真实 delta 即收敛。
      clearRecoveryNotice(cid);
      if (cid === activeRef.current) {
        // 保持 provider 事件顺序：另一侧 buffer 若有积压，先 flush 再追加本侧。
        thinkingTypewriter.flush();
        textTypewriter.push(content);
      } else {
        conversationStore.setState(cid, (prev) => ({ messages: appendText(prev.messages, content) }));
      }
    });

    const offThinking = clientApi.onChatStreamThinking(({ streamId, content }) => {
      const cid = conversationStore.resolveConversation(streamId);
      if (!cid) return;
      // 推理模型常先输出 thinking 再出正文，此处同样兜底清除重试横幅。
      clearRecoveryNotice(cid);
      if (cid === activeRef.current) {
        textTypewriter.flush();
        thinkingTypewriter.push(content);
      } else {
        conversationStore.setState(cid, (prev) => ({ messages: appendThinking(prev.messages, content) }));
      }
    });

    const offDone = clientApi.onChatStreamDone(
      ({ streamId, usage, lifetimeUsage, contextTokens, contextWindow, compactionSuggested }) => {
        const cid = conversationStore.resolveConversation(streamId);
        if (!cid) return;
        // 流正常收尾，重试横幅若仍残留一并清除。
        clearRecoveryNotice(cid);
        if (cid === activeRef.current) {
          textTypewriter.flush();
          thinkingTypewriter.flush();
        }
        const snap = conversationStore.getSnapshot(cid);
        const turnDurationMs = snap.turnStartedAt != null ? Date.now() - snap.turnStartedAt : undefined;
        const hasUsage =
          usage?.inputTokens || usage?.outputTokens || usage?.cacheWriteTokens || usage?.cacheReadTokens;
        const msgUsage = hasUsage
          ? {
              input: usage.inputTokens ?? 0,
              output: usage.outputTokens ?? 0,
              cacheWrite: usage.cacheWriteTokens ?? 0,
              cacheRead: usage.cacheReadTokens ?? 0,
            }
          : null;

        // 运行态收尾 + streamId 清理 + 回合计时清零。
        conversationStore.setState(cid, {
          isStreaming: false,
          activeUsage: null,
          pendingPermissionCalls: [],
          toolProgress: null,
          turnStartedAt: null,
          streamId: null,
        });

        // 口径统一：把主进程随 done 下发的权威上下文用量快照反映到该会话表达层。
        if (typeof contextTokens === 'number') {
          conversationStore.setState(cid, {
            authoritativeContext: {
              contextTokens,
              contextWindow: typeof contextWindow === 'number' ? contextWindow : null,
            },
          });
        } else {
          conversationStore.setState(cid, { authoritativeContext: null });
        }

        // 用量账本真值在主进程：优先反映 lifetimeUsage，否则按本轮 msgUsage 累加。
        if (lifetimeUsage) {
          conversationStore.setState(cid, { tokenUsage: usageFromLifetime(lifetimeUsage) });
        } else if (msgUsage) {
          conversationStore.setState(cid, (prev) => ({
            tokenUsage: {
              input: (prev.tokenUsage?.input ?? 0) + msgUsage.input,
              output: (prev.tokenUsage?.output ?? 0) + msgUsage.output,
              cacheWrite: (prev.tokenUsage?.cacheWrite ?? 0) + msgUsage.cacheWrite,
              cacheRead: (prev.tokenUsage?.cacheRead ?? 0) + msgUsage.cacheRead,
            },
          }));
        }

        conversationStore.setState(cid, (prev) => {
          const msgs = prev.messages as ChatMsg[];
          const last = msgs[msgs.length - 1];
          if (last && isEmptyAssistantPlaceholder(last)) {
            const next = msgs.slice(0, -1);
            persistMessages(cid, next);
            return {
              messages: next,
              streamError: 'empty_visible_model_response: 模型已结束，但没有返回任何可见文本、思考或工具调用。',
            };
          }
          if (last?.role === 'assistant') {
            const patched: ChatMsg = {
              ...last,
              ...(turnDurationMs != null ? { durationMs: turnDurationMs } : {}),
              // 终态兜底：若仍有 tool-call 段未拿到结果，补写中断标记避免永久转圈。
              segments: markDanglingToolCallsInterrupted(last.segments, '工具结果未返回（本轮已结束）'),
            };
            const updated = [...msgs.slice(0, -1), patched];
            persistMessages(cid, updated);
            return { messages: updated };
          }
          persistMessages(cid, msgs);
          return {};
        });
        onUpdatedRef.current?.(cid);
        if (compactionSuggested) onCompactionRef.current?.(cid);
      },
    );

    const offUsage = clientApi.onChatStreamUsage(({ streamId, usage }) => {
      const cid = conversationStore.resolveConversation(streamId);
      if (!cid || !usage) return;
      conversationStore.setState(cid, {
        activeUsage: {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cacheWrite: usage.cacheWriteTokens ?? 0,
          cacheRead: usage.cacheReadTokens ?? 0,
        },
      });
    });

    const offAborted = clientApi.onChatStreamAborted(({ streamId }) => {
      const cid = conversationStore.resolveConversation(streamId);
      if (!cid) return;
      if (cid === activeRef.current) {
        // 中断时丢弃打字机积压缓冲（而非 flush 吐完），否则用户点停止后
        // 已入队的 delta 仍会继续「涌出」。正文以主进程落盘的快照为准。
        textTypewriter.reset();
        thinkingTypewriter.reset();
      }
      const snap = conversationStore.getSnapshot(cid);
      const turnDurationMs = snap.turnStartedAt != null ? Date.now() - snap.turnStartedAt : undefined;
      conversationStore.setState(cid, {
        isStreaming: false,
        compactionState: IDLE_COMPACTION_STATE,
        activeUsage: null,
        pendingPermissionCalls: [],
        toolProgress: null,
        turnStartedAt: null,
        streamId: null,
      });
      conversationStore.setState(cid, (prev) => {
        const msgs = prev.messages as ChatMsg[];
        const last = msgs[msgs.length - 1];
        if (last && isEmptyAssistantPlaceholder(last)) {
          const next = msgs.slice(0, -1);
          persistMessages(cid, next);
          return { messages: next };
        }
        // 停止时留痕：记录整轮耗时，并给未回填的 tool-call 段补写中断标记。
        if (last?.role === 'assistant') {
          const patched: ChatMsg = {
            ...last,
            ...(turnDurationMs != null ? { durationMs: turnDurationMs } : {}),
            segments: markDanglingToolCallsInterrupted(last.segments, '工具调用已中断（生成停止）'),
          };
          const updated = [...msgs.slice(0, -1), patched];
          persistMessages(cid, updated);
          return { messages: updated };
        }
        persistMessages(cid, msgs);
        return {};
      });
      onUpdatedRef.current?.(cid);
    });

    const offToolProgress = clientApi.onChatStreamToolProgress(({ streamId, tool, path, receivedLines }) => {
      const cid = conversationStore.resolveConversation(streamId);
      if (!cid) return;
      conversationStore.setState(cid, { toolProgress: { tool, path, receivedLines } });
    });

    const offToolCall = clientApi.onChatStreamToolCall(({ streamId, tool, displayName, args, toolCallId }) => {
      const cid = conversationStore.resolveConversation(streamId);
      if (!cid) return;
      // 内置浏览器工具：通知上层自动展开 Workbench。仅前台触发，避免后台会话抢占视图。
      if (tool.startsWith('browser_') && cid === activeRef.current) onBrowserRef.current?.(tool);
      if (cid === activeRef.current) {
        textTypewriter.flush();
        thinkingTypewriter.flush();
      }
      conversationStore.setState(cid, (prev) => {
        const msgs = prev.messages as ChatMsg[];
        const last = msgs[msgs.length - 1];
        if (!last || last.role !== 'assistant') return {};
        const segments = [...(last.segments || [])];
        segments.push({ type: 'tool-call', tool, displayName, args, toolCallId, result: undefined });
        // 持久化真值由主进程累积代理负责，渲染端仅更新表达层，避免双写。
        return { messages: [...msgs.slice(0, -1), { ...last, segments }] };
      });
    });

    const offToolResult = clientApi.onChatStreamToolResult(({ streamId, toolCallId, result }) => {
      const cid = conversationStore.resolveConversation(streamId);
      if (!cid) return;
      if (cid === activeRef.current) {
        textTypewriter.flush();
        thinkingTypewriter.flush();
      }
      conversationStore.setState(cid, (prev) => {
        const msgs = prev.messages as ChatMsg[];
        const last = msgs[msgs.length - 1];
        // 工具结果已回填即视为该工具收尾：清空「正在…」进度行，避免它一直残留到
        // 下一条进度事件覆盖或回合结束（done/aborted/error）才消失。toolProgress 是
        // 单值最新态，收尾即清不会误伤后续工具（后续工具会再次 set 新的进度）。
        if (!last || last.role !== 'assistant') return { toolProgress: null };
        const segments = (last.segments || []).map((seg) =>
          seg.type === 'tool-call' && seg.toolCallId === toolCallId ? { ...seg, result } : seg,
        );
        return { messages: [...msgs.slice(0, -1), { ...last, segments }], toolProgress: null };
      });
    });

    const offPermissionRequest = clientApi.onChatStreamPermissionRequest(({ streamId, call }) => {
      const cid = conversationStore.resolveConversation(streamId);
      if (!cid) return;
      conversationStore.setState(cid, (prev) => {
        if (prev.pendingPermissionCalls.some((item) => item.toolCallId === call.toolCallId)) return {};
        return { pendingPermissionCalls: [...prev.pendingPermissionCalls, call] };
      });
    });

    const offError = clientApi.onChatStreamError(({ streamId, error, usage, lifetimeUsage }) => {
      const cid = conversationStore.resolveConversation(streamId);
      if (!cid) return;
      if (cid === activeRef.current) {
        // 异常终止（含复读兜底自动 error）同样丢弃积压缓冲，避免残留 delta 继续涌出。
        textTypewriter.reset();
        thinkingTypewriter.reset();
      }
      conversationStore.setState(cid, {
        isStreaming: false,
        compactionState: IDLE_COMPACTION_STATE,
        activeUsage: null,
        pendingPermissionCalls: [],
        toolProgress: null,
        streamError: error,
        // 最终失败时清除“正在重试连接”横幅，避免与错误提示叠加残留。
        providerRecoveryNotice: null,
      });
      if (lifetimeUsage) {
        conversationStore.setState(cid, { tokenUsage: usageFromLifetime(lifetimeUsage) });
      } else if (usage?.inputTokens || usage?.outputTokens || usage?.cacheWriteTokens || usage?.cacheReadTokens) {
        const msgUsage = {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cacheWrite: usage.cacheWriteTokens ?? 0,
          cacheRead: usage.cacheReadTokens ?? 0,
        };
        conversationStore.setState(cid, (prev) => ({
          tokenUsage: {
            input: (prev.tokenUsage?.input ?? 0) + msgUsage.input,
            output: (prev.tokenUsage?.output ?? 0) + msgUsage.output,
            cacheWrite: (prev.tokenUsage?.cacheWrite ?? 0) + msgUsage.cacheWrite,
            cacheRead: (prev.tokenUsage?.cacheRead ?? 0) + msgUsage.cacheRead,
          },
        }));
      }
      const snap = conversationStore.getSnapshot(cid);
      const turnDurationMs = snap.turnStartedAt != null ? Date.now() - snap.turnStartedAt : undefined;
      conversationStore.setState(cid, (prev) => {
        const msgs = prev.messages as ChatMsg[];
        const last = msgs[msgs.length - 1];
        if (last && isEmptyAssistantPlaceholder(last)) {
          const next = msgs.slice(0, -1);
          persistMessages(cid, next);
          return { messages: next };
        }
        // 长流中断保留：已产出内容的 assistant 消息因连接中断未自然收尾，标记 interrupted。
        if (last?.role === 'assistant') {
          const patched: ChatMsg = {
            ...last,
            ...(turnDurationMs != null ? { durationMs: turnDurationMs } : {}),
            interrupted: true,
            segments: markDanglingToolCallsInterrupted(last.segments, '工具调用已中断（连接错误）'),
          };
          const updated = [...msgs.slice(0, -1), patched];
          persistMessages(cid, updated);
          return { messages: updated };
        }
        persistMessages(cid, msgs);
        return {};
      });
      conversationStore.setState(cid, { turnStartedAt: null, streamId: null });
      onUpdatedRef.current?.(cid);
    });

    const offProviderRecovery = clientApi.onChatStreamProviderRecovery(
      ({ streamId, fromProvider, toProvider, reason }) => {
        const cid = conversationStore.resolveConversation(streamId);
        if (!cid) return;
        conversationStore.setState(cid, {
          providerRecoveryNotice: { kind: 'provider', fromProvider, toProvider, reason },
        });
      },
    );

    const offConnectionRecovery = clientApi.onChatStreamConnectionRecovery(
      ({ streamId, provider, model, status, fromConnection, toConnection, connection, attempt, maxRetries, delayMs, reason }) => {
        const cid = conversationStore.resolveConversation(streamId);
        if (!cid) return;
        conversationStore.setState(cid, {
          providerRecoveryNotice: {
            kind: 'connection',
            provider,
            model,
            status,
            fromConnection,
            toConnection,
            connection,
            attempt,
            maxRetries,
            delayMs,
            reason,
          },
        });
      },
    );

    const offCompaction = clientApi.onChatCompaction(
      ({ conversationId, streamId, stage, percent, method, beforeTokens, afterTokens, oldMessageCount, keptMessageCount, contextTokens, contextWindow }) => {
        const cid = conversationStore.resolveEventConversation(streamId, conversationId);
        if (!cid) return;
        if (stage === 'start') {
          conversationStore.setState(cid, (prev) => ({
            compactionState: reduceCompactionLifecycle(prev.compactionState, {
              stage: 'start',
              streamId,
              now: Date.now(),
            }),
          }));
          return;
        }
        if (stage === 'progress') {
          conversationStore.setState(cid, (prev) => ({
            compactionState: reduceCompactionLifecycle(prev.compactionState, {
              stage: 'progress',
              streamId,
              percent: typeof percent === 'number' ? percent : null,
              now: Date.now(),
            }),
          }));
          return;
        }
        if (stage === 'idle') {
          cancelCompactionDoneTimer(cid, streamId);
          conversationStore.setState(cid, (prev) => ({
            compactionState: reduceCompactionLifecycle(prev.compactionState, {
              stage: 'idle',
              streamId,
            }),
          }));
          return;
        }
        const activeCompaction = conversationStore.getSnapshot(cid).compactionState;
        if (
          activeCompaction.phase !== 'idle'
          && activeCompaction.streamId
          && activeCompaction.streamId !== streamId
        ) {
          return;
        }
        const completedAt = Date.now();
        cancelCompactionDoneTimer(cid);
        conversationStore.setState(cid, (prev) => ({
          // done 表示主进程已经完成压缩持久化；renderer 仍需 reload/merge 消息，期间保持 finalizing。
          compactionState: reduceCompactionLifecycle(prev.compactionState, {
            stage: 'finalizing',
            streamId,
            now: completedAt,
          }),
          // 原子替换压缩前快照。若旧 renderer 对接的是尚未携带快照的主进程，则清空旧值，
          // 回退到消息切片的本地估算，绝不继续把底部数字锁在压缩前高位。
          authoritativeContext: typeof contextTokens === 'number'
            ? {
                contextTokens,
                contextWindow: typeof contextWindow === 'number' ? contextWindow : null,
              }
            : null,
        }));
        if (
          !method ||
          beforeTokens === undefined ||
          afterTokens === undefined ||
          oldMessageCount === undefined ||
          keptMessageCount === undefined
        ) {
          conversationStore.setState(cid, {
            compactionState: {
              phase: 'failed',
              percent: 100,
              streamId,
              error: 'Compaction done event missed required summary fields.',
              failedAt: Date.now(),
            },
          });
          return;
        }
        // 完成态：重载会话，压缩点以 CompactionSummaryCard(msg.compaction) 就地出现在时间线。
        void (async () => {
          try {
            const { messages: loaded, tokenUsage: usage } = await loadConversationMessages(cid);
            conversationStore.setState(cid, (prev) => {
              // 压缩若在流式进行中完成，loadConversationMessages 会剥离正在接收 delta 的空
              // assistant 占位。这里在流仍活跃时把内存中的 assistant 尾消息接回压缩后的列表，
              // 保证 typewriter 的后续 delta 仍能落到这条消息上，避免界面卡住不出消息。
              const liveTail = prev.messages[prev.messages.length - 1];
              return {
                messages: mergeLoadedMessagesWithLiveTail(loaded, liveTail, {
                  streamMatches: prev.streamId === streamId,
                }),
                ...(usage ? { tokenUsage: usage } : {}),
              };
            });
            onUpdatedRef.current?.(cid);
            const timer = setTimeout(() => {
              conversationStore.setState(cid, (prev) => ({
                compactionState: reduceCompactionLifecycle(prev.compactionState, {
                  stage: 'idle',
                  streamId,
                }),
              }));
              const entry = compactionDoneTimers.get(cid);
              if (entry?.streamId === streamId) compactionDoneTimers.delete(cid);
            }, 300);
            compactionDoneTimers.set(cid, { streamId, timer });
          } catch (error) {
            conversationStore.setState(cid, {
              compactionState: {
                phase: 'failed',
                percent: 100,
                streamId,
                error: error instanceof Error ? error.message : String(error),
                failedAt: Date.now(),
              },
            });
          }
        })();
      },
    );

    return () => {
      for (const { timer } of compactionDoneTimers.values()) clearTimeout(timer);
      compactionDoneTimers.clear();
      offRuntimeEvent();
      offDelta();
      offThinking();
      offDone();
      offUsage();
      offAborted();
      offToolProgress();
      offToolCall();
      offToolResult();
      offPermissionRequest();
      offError();
      offProviderRecovery();
      offConnectionRecovery();
      offCompaction();
    };
    // 处理闭包只读 ref，无外部依赖：整份订阅「挂载一次」即可，切会话不重绑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { textTypewriter, thinkingTypewriter };
}
