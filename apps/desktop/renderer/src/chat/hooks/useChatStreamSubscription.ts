import { useEffect } from 'react';
import type React from 'react';
import type { ClientToolCall } from '@peer-agent/protocol';

import { clientApi } from '../../clientApi';
import { isEmptyAssistantPlaceholder, markDanglingToolCallsInterrupted } from '../state/streamSegments';
import type { ChatMsg, TokenUsageState, ToolProgress } from '../state/types';
import type { TypewriterController } from './useTypewriterStream';

/** provider/connection 恢复提示（表达层横幅用）。 */
interface ProviderRecoveryNotice {
  kind?: 'provider' | 'connection';
  fromProvider?: string;
  toProvider?: string;
  provider?: string;
  model?: string;
  status?: 'retrying' | 'recovered';
  fromConnection?: string;
  toConnection?: string;
  connection?: string;
  attempt?: number;
  maxRetries?: number;
  delayMs?: number;
  reason?: string;
}

/**
 * useChatStreamSubscription —— 订阅主进程的流式事件并把它们落到表达层状态。
 *
 * 这是从 ChatSurface 下沉的「最大且最高风险」的一段 effect（~275 行），逐字搬移、行为零变更：
 * - 订阅 delta / thinking / done / usage / aborted / toolProgress / toolCall / toolResult /
 *   permissionRequest / error / providerRecovery / compaction 共 12 个流事件。
 * - 仅处理与当前 streamIdRef.current 匹配的事件（其余忽略），终结事件清理 streamId、计时与运行态。
 * - 通过 persistMessages 把内存消息映射回主进程的开放袋持久化（content/segments/usage/durationMs/
 *   compaction/attachments）。压缩完成时按会话重载并把活跃 assistant 尾消息接回，避免流式卡死。
 *
 * 所有跨闭包依赖（typewriter 控制器、refs、各 setState、计时 setter、usageFromLifetime、
 * loadConversationMessages、会话坐标与回调）都以参数注入；effect 的依赖数组与原内联实现
 * 完全一致（[appendStreamThinking, conversationId, onConversationUpdated]），订阅/清理时序不变。
 * 发送与账本真值仍在主进程，本 hook 只把流事件反映到表达层，不引入新的执行真值或发送通道。
 */
export function useChatStreamSubscription(params: {
  conversationId: string | null;
  onConversationUpdated?: () => void;
  streamIdRef: React.MutableRefObject<string | null>;
  turnStartedAtRef: React.MutableRefObject<number | null>;
  setTurnStartedAt: (startedAt: number | null) => void;
  textTypewriter: TypewriterController;
  thinkingTypewriter: TypewriterController;
  appendStreamThinking: (chunk: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMsg[]>>;
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCompacting: React.Dispatch<React.SetStateAction<boolean>>;
  setCompactionPercent?: React.Dispatch<React.SetStateAction<number | null>>;
  setActiveUsage: React.Dispatch<React.SetStateAction<TokenUsageState | null>>;
  setTokenUsage: React.Dispatch<React.SetStateAction<TokenUsageState | null>>;
  setStreamError: React.Dispatch<React.SetStateAction<string | null>>;
  setPendingPermissionCalls: React.Dispatch<React.SetStateAction<ClientToolCall[]>>;
  setToolProgress: React.Dispatch<React.SetStateAction<ToolProgress | null>>;
  setProviderRecoveryNotice: React.Dispatch<React.SetStateAction<ProviderRecoveryNotice | null>>;
  usageFromLifetime: (lifetime: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
  }) => { input: number; output: number; cacheWrite: number; cacheRead: number };
  loadConversationMessages: (conversationId: string) => Promise<{
    messages: ChatMsg[];
    tokenUsage: TokenUsageState | null;
  }>;
}): void {
  const {
    conversationId,
    onConversationUpdated,
    streamIdRef,
    turnStartedAtRef,
    setTurnStartedAt,
    textTypewriter,
    thinkingTypewriter,
    appendStreamThinking,
    setMessages,
    setIsStreaming,
    setIsCompacting,
    setCompactionPercent,
    setActiveUsage,
    setTokenUsage,
    setStreamError,
    setPendingPermissionCalls,
    setToolProgress,
    setProviderRecoveryNotice,
    usageFromLifetime,
    loadConversationMessages,
  } = params;

  useEffect(() => {
    // 压缩完成时先把进度钉到 100% 短暂停顿再隐藏横幅，给一个"到顶"收尾反馈，
    // 避免末段停在 ~95% 后横幅瞬间消失的跳变观感。该 timer 在 cleanup 中清理，
    // 防止组件卸载后仍触发 setState。
    let compactionDoneTimer: ReturnType<typeof setTimeout> | null = null;

    const persistMessages = (msgs: ChatMsg[]) => {
      if (!conversationId) return;
      void clientApi.conversationsReplaceMessages({
        id: conversationId,
        messages: msgs.map((m) => ({
          id: m.id, role: m.role, content: m.content, segments: m.segments, usage: m.usage, durationMs: m.durationMs, _compaction: m.compaction, attachments: m.attachments, interrupted: m.interrupted,
        })),
      });
    };

    const offDelta = clientApi.onChatStreamDelta(({ streamId, content }) => {
      if (streamId !== streamIdRef.current) return;
      // Preserve provider event order across independent typewriter buffers.
      // If reasoning text is still buffered, commit it before appending answer text.
      thinkingTypewriter.flush();
      textTypewriter.push(content);
    });

    const offThinking = clientApi.onChatStreamThinking(({ streamId, content }) => {
      if (streamId !== streamIdRef.current) return;
      // Preserve provider event order across independent typewriter buffers.
      // If answer text is still buffered, commit it before appending reasoning text.
      textTypewriter.flush();
      thinkingTypewriter.push(content);
    });

    const offDone = clientApi.onChatStreamDone(({ streamId, usage, lifetimeUsage }) => {
      if (streamId !== streamIdRef.current) return;
      textTypewriter.flush();
      thinkingTypewriter.flush();
      setIsStreaming(false);
      setIsCompacting(false);
      setActiveUsage(null);
      setPendingPermissionCalls([]);
      setToolProgress(null);
      const hasUsage = usage?.inputTokens || usage?.outputTokens || usage?.cacheWriteTokens || usage?.cacheReadTokens;
      const msgUsage = hasUsage
        ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0, cacheRead: usage.cacheReadTokens ?? 0 }
        : null;
      if (lifetimeUsage) {
        // Usage ledger is owned by main/runtime; renderer only reflects the
        // authoritative lifetimeUsage returned with the stream terminal event.
        setTokenUsage(usageFromLifetime(lifetimeUsage));
      } else if (msgUsage) {
        // Compatibility fallback for older runtimes/tests that do not enrich
        // terminal stream events with lifetimeUsage.
        setTokenUsage((prev) => ({
          input: (prev?.input ?? 0) + msgUsage.input,
          output: (prev?.output ?? 0) + msgUsage.output,
          cacheWrite: (prev?.cacheWrite ?? 0) + msgUsage.cacheWrite,
          cacheRead: (prev?.cacheRead ?? 0) + msgUsage.cacheRead,
        }));
      }
      const turnDurationMs = turnStartedAtRef.current != null ? Date.now() - turnStartedAtRef.current : undefined;
      if (conversationId) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && isEmptyAssistantPlaceholder(last)) {
            const next = prev.slice(0, -1);
            persistMessages(next);
            return next;
          }
          if (last?.role === 'assistant') {
            const patched: ChatMsg = {
              ...last,
              ...(msgUsage ? { usage: msgUsage } : {}),
              ...(turnDurationMs != null ? { durationMs: turnDurationMs } : {}),
              // 终态兜底：正常 done 时一般所有 tool-call 段都已回填；若仍有残留段未拿到
              // 结果（异常），补写中断标记，避免该段在结束后永久转圈。
              segments: markDanglingToolCallsInterrupted(last.segments, '工具结果未返回（本轮已结束）'),
            };
            const updated = [...prev.slice(0, -1), patched];
            persistMessages(updated);
            return updated;
          }
          persistMessages(prev);
          return prev;
        });
        onConversationUpdated?.();
      }
      setTurnStartedAt(null);
      streamIdRef.current = null;
    });

    const offUsage = clientApi.onChatStreamUsage(({ streamId, usage }) => {
      if (streamId !== streamIdRef.current || !usage) return;
      setActiveUsage({
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        cacheRead: usage.cacheReadTokens ?? 0,
      });
    });

    const offAborted = clientApi.onChatStreamAborted(({ streamId }) => {
      if (streamId !== streamIdRef.current) return;
      textTypewriter.flush();
      thinkingTypewriter.flush();
      setIsStreaming(false);
      setIsCompacting(false);
      setActiveUsage(null);
      setPendingPermissionCalls([]);
      setToolProgress(null);
      const turnDurationMs = turnStartedAtRef.current != null ? Date.now() - turnStartedAtRef.current : undefined;
      if (conversationId) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && isEmptyAssistantPlaceholder(last)) {
            const next = prev.slice(0, -1);
            persistMessages(next);
            return next;
          }
          // 停止时也留痕:把"已工作多久"记到这条 assistant 上,让用户看到中断前的整轮耗时。
          // 同时给「已发出但未回填结果」的 tool-call 段补写中断标记,避免停止后该段永久转圈。
          if (last?.role === 'assistant') {
            const patched: ChatMsg = {
              ...last,
              ...(turnDurationMs != null ? { durationMs: turnDurationMs } : {}),
              segments: markDanglingToolCallsInterrupted(last.segments, '工具调用已中断（生成停止）'),
            };
            const updated = [...prev.slice(0, -1), patched];
            persistMessages(updated);
            return updated;
          }
          persistMessages(prev);
          return prev;
        });
        onConversationUpdated?.();
      }
      setTurnStartedAt(null);
      streamIdRef.current = null;
    });

    const offToolProgress = clientApi.onChatStreamToolProgress(({ streamId, tool, path, receivedLines }) => {
      if (streamId !== streamIdRef.current) return;
      setToolProgress({ tool, path, receivedLines });
    });

    const offToolCall = clientApi.onChatStreamToolCall(({ streamId, tool, displayName, args, toolCallId }) => {
      if (streamId !== streamIdRef.current) return;
      // Tool-call events can arrive while the typewriter still holds earlier text
      // deltas. Flush first so pre-call text is committed above the structured
      // tool-call segment instead of being appended below it later.
      textTypewriter.flush();
      thinkingTypewriter.flush();
      // 参数已落地为正式 tool-call 段,过程提示让位给结构化段。
      setToolProgress(null);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        const segments = [...(last.segments || [])];
        segments.push({ type: 'tool-call', tool, displayName, args, toolCallId, result: undefined });
        const next = [...prev.slice(0, -1), { ...last, segments }];
        // 方案 3：正文/segments 的持久化真值已下沉主进程（累积代理在 tool-call 事件
        // 节流落盘）。此处只更新表达层，不再 persistMessages，避免与主进程的
        // updateMessageById 双写同一会话文件（且后台会话本就拿不到该事件）。
        return next;
      });
    });

    const offToolResult = clientApi.onChatStreamToolResult(({ streamId, toolCallId, result }) => {
      if (streamId !== streamIdRef.current) return;
      textTypewriter.flush();
      thinkingTypewriter.flush();
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        const segments = [...(last.segments || [])];
        for (let i = segments.length - 1; i >= 0; i--) {
          const segment = segments[i];
          if (segment.type !== 'tool-call' || segment.result !== undefined) continue;
          if (toolCallId && segment.toolCallId && segment.toolCallId !== toolCallId) continue;
          segments[i] = { ...segment, result };
          break;
        }
        const next = [...prev.slice(0, -1), { ...last, segments }];
        // 方案 3：tool-result 的 segments 持久化同样由主进程累积代理负责，
        // 渲染端仅更新表达层，避免与主进程双写。
        return next;
      });
    });

    const offPermissionRequest = clientApi.onChatStreamPermissionRequest(({ streamId, call }) => {
      if (streamId !== streamIdRef.current) return;
      setPendingPermissionCalls((prev) => {
        if (prev.some((item) => item.toolCallId === call.toolCallId)) return prev;
        return [...prev, call];
      });
    });

    const offError = clientApi.onChatStreamError(({ streamId, error, usage, lifetimeUsage }) => {
      if (streamId !== streamIdRef.current) return;
      textTypewriter.flush();
      thinkingTypewriter.flush();
      setIsStreaming(false);
      setIsCompacting(false);
      setActiveUsage(null);
      setPendingPermissionCalls([]);
      setToolProgress(null);
      setStreamError(error);
      if (lifetimeUsage) {
        setTokenUsage(usageFromLifetime(lifetimeUsage));
      } else if (usage?.inputTokens || usage?.outputTokens || usage?.cacheWriteTokens || usage?.cacheReadTokens) {
        const msgUsage = {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cacheWrite: usage.cacheWriteTokens ?? 0,
          cacheRead: usage.cacheReadTokens ?? 0,
        };
        setTokenUsage((prev) => ({
          input: (prev?.input ?? 0) + msgUsage.input,
          output: (prev?.output ?? 0) + msgUsage.output,
          cacheWrite: (prev?.cacheWrite ?? 0) + msgUsage.cacheWrite,
          cacheRead: (prev?.cacheRead ?? 0) + msgUsage.cacheRead,
        }));
      }
      const turnDurationMs = turnStartedAtRef.current != null ? Date.now() - turnStartedAtRef.current : undefined;
      if (conversationId) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && isEmptyAssistantPlaceholder(last)) {
            const next = prev.slice(0, -1);
            persistMessages(next);
            return next;
          }
          // (b) 长流中断保留：已产出内容的 assistant 消息因连接中断未自然收尾，
          // 标记 interrupted=true，表达层据此显示"已中断"标记与"继续生成"入口。
          if (last?.role === 'assistant') {
            const updated = [
              ...prev.slice(0, -1),
              {
                ...last,
                interrupted: true,
                ...(turnDurationMs != null ? { durationMs: turnDurationMs } : {}),
                // 连接/流出错时，给未回填结果的 tool-call 段补写中断标记，避免永久转圈。
                segments: markDanglingToolCallsInterrupted(last.segments, '工具调用已中断（连接出错）'),
              },
            ];
            persistMessages(updated);
            return updated;
          }
          persistMessages(prev);
          return prev;
        });
      }
      setTurnStartedAt(null);
      streamIdRef.current = null;
    });

    const offProviderRecovery = clientApi.onChatStreamProviderRecovery(({
      streamId,
      fromProvider,
      toProvider,
      reason,
    }) => {
      if (streamId !== streamIdRef.current) return;
      setProviderRecoveryNotice({ kind: 'provider', fromProvider, toProvider, reason });
    });

    const offConnectionRecovery = clientApi.onChatStreamConnectionRecovery(({
      streamId,
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
    }) => {
      if (streamId !== streamIdRef.current) return;
      setProviderRecoveryNotice({
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
      });
    });

    const offCompaction = clientApi.onChatCompaction(({ streamId, stage, percent, method, beforeTokens, afterTokens, oldMessageCount, keptMessageCount }) => {
      if (streamId !== streamIdRef.current) return;
      if (stage === 'start') {
        setIsCompacting(true);
        setCompactionPercent?.(null);
        return;
      }
      if (stage === 'progress') {
        // 字符级真实进度（流式收摘要时逐 chunk 上报）。
        if (typeof percent === 'number') setCompactionPercent?.(percent);
        return;
      }
      if (stage === 'idle') {
        setIsCompacting(false);
        setCompactionPercent?.(null);
        return;
      }
      // 完成：先把进度钉到 100% 给"到顶"反馈，停顿 ~150ms 再隐藏横幅。
      setCompactionPercent?.(100);
      if (compactionDoneTimer) clearTimeout(compactionDoneTimer);
      compactionDoneTimer = setTimeout(() => {
        setIsCompacting(false);
        setCompactionPercent?.(null);
        compactionDoneTimer = null;
      }, 150);
      if (!method || beforeTokens === undefined || afterTokens === undefined || oldMessageCount === undefined || keptMessageCount === undefined) return;
      // 完成态不再钉在底部横幅:重载会话后,压缩点会以 CompactionSummaryCard
      // (msg.compaction)的形式就地出现在消息时间线的对应位置(Codex 风格分割线)。
      if (conversationId) {
        void (async () => {
          const { messages: loaded, tokenUsage: usage } = await loadConversationMessages(conversationId);
          setMessages((prev) => {
            // 压缩若在流式进行中完成,loadConversationMessages 会按常规把正在接收
            // delta 的空 assistant 占位剥离(isEmptyAssistantPlaceholder)。一旦尾部
            // 变成 user 消息,appendStreamText 因 last.role !== 'assistant' 直接丢弃后续
            // delta,界面就会卡住、永远不出消息。这里在流仍活跃时把内存中的 assistant
            // 尾消息接回压缩后的列表,保证 typewriter 的后续 delta 仍能落到这条消息上。
            const liveTail = prev[prev.length - 1];
            if (streamIdRef.current === streamId && liveTail && liveTail.role === 'assistant') {
              return [...loaded, liveTail];
            }
            return loaded;
          });
          if (usage) setTokenUsage(usage);
          onConversationUpdated?.();
        })();
      }
    });

    return () => { if (compactionDoneTimer) { clearTimeout(compactionDoneTimer); compactionDoneTimer = null; } offDelta(); offThinking(); offDone(); offUsage(); offAborted(); offToolProgress(); offToolCall(); offToolResult(); offPermissionRequest(); offError(); offProviderRecovery(); offConnectionRecovery(); offCompaction(); };
  }, [appendStreamThinking, conversationId, onConversationUpdated]);
}
