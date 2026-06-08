import { reduceChatRuntime } from '@zeus-atlas/chat-kernel';
import type { ChatMessage, ChatRuntimeState, ClientToolCall, Conversation } from '@zeus-atlas/protocol';
import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useRef } from 'react';
import { chatClient } from '../api/chatClient';
import { normalizeClientToolCall } from './clientToolCallEvents';
import { resolveConversationView } from './runtimeHelpers';

interface UseCloudStreamEventsParams {
  readonly activeStreamConversationIdRef: { current: number | null };
  readonly activeStreamIdRef: { current: string | null };
  readonly currentConversation: Conversation | null;
  readonly enqueueClientToolCalls: (calls: readonly ClientToolCall[]) => void;
  readonly executeClientToolCall: (call: ClientToolCall) => Promise<unknown>;
  readonly isAlwaysAllowed: (call: ClientToolCall) => boolean;
  readonly refreshConversations: () => Promise<void>;
  readonly setState: Dispatch<SetStateAction<ChatRuntimeState>>;
  readonly stopLocalProxyPolling: () => void;
}

export function useCloudStreamEvents({
  activeStreamConversationIdRef,
  activeStreamIdRef,
  currentConversation,
  enqueueClientToolCalls,
  executeClientToolCall,
  isAlwaysAllowed,
  refreshConversations,
  setState,
  stopLocalProxyPolling,
}: UseCloudStreamEventsParams) {
  // 避免 local.skill.* 静默自动放行重复触发同一 toolCallId(SSE 重发或 useEffect 重建均可能)
  const autoApprovedToolCallIdsRef = useRef<Set<string>>(new Set());


  // 串台第二道防线:streamId 已对上,但 conversation ref 已被清空(abort/stop)
  // → 认为 stream 已注销,event 是尾巴 → ignore。
  // 注意:不能跟 conversationIdRef(state 派生)比较 —— sendMessage 设 ref 是同步,
  // state.conversation 走 React 异步 commit,新会话首条消息会出现 ref 已设但
  // conversationIdRef 还没刷新的 race,把所有 SSE event 误判为 stale 直接卡住。
  const isStaleStreamPayload = (streamId: string) => {
    if (streamId !== activeStreamIdRef.current) return true;
    if (activeStreamConversationIdRef.current === null) return true;
    return false;
  };

  // 占位：当前的 streamId 切换时把 dev-mode 自动放行的去重表清空，避免
  // 跨 stream 残留导致下一轮无法再放行同名 toolCallId。
  useEffect(() => {
    autoApprovedToolCallIdsRef.current = new Set();
  }, [currentConversation?.id]);

  useEffect(() => {
    console.log('[useCloudStreamEvents] event subscriptions wired');
    const unsubscribeEvent = chatClient.onStreamEvent((payload) => {
      if (isStaleStreamPayload(payload.streamId)) return;
      const clientToolCall = normalizeClientToolCall(payload.event);
      if (clientToolCall) {
        // local.skill.* 站全环自动放行：**不入 pending 队列**，避免确认条闪现，
        // 直接走 IPC 执行。其他 capability 仅在 dev-mode 下白名单默认放行（入队后立即执行）。
        const isAutoApprovedSkill = clientToolCall.capabilityId.startsWith('local.skill.');
        if (isAutoApprovedSkill) {
          if (!autoApprovedToolCallIdsRef.current.has(clientToolCall.toolCallId)) {
            autoApprovedToolCallIdsRef.current.add(clientToolCall.toolCallId);
            console.log('[Step3.5 静默自动放行（不入队）] capabilityId:', clientToolCall.capabilityId, 'toolCallId:', clientToolCall.toolCallId);
            void executeClientToolCall(clientToolCall);
          }
        } else if (isAlwaysAllowed(clientToolCall)) {
          // M3·G「一直允许」：该命令签名（tool-id 粒度）本会话已被用户授权，
          // 自动放行、不入 pending；幂等由 executeClientToolCall 内 executedToolCallIdsRef 兜底。
          console.log('[Step3.5 一直允许·自动放行] capabilityId:', clientToolCall.capabilityId, 'toolCallId:', clientToolCall.toolCallId);
          void executeClientToolCall(clientToolCall);
        } else {
          // 标准路径：非 local.skill.* 且未"一直允许"→ 入 pending，走 PermissionGateStrip 人工
          // 确认（含本地 shell）。开发与生产行为一致，不按 dev 模式自动放行。
          enqueueClientToolCalls([clientToolCall]);
        }
      }
      // run-scoped SSE 长流（main 进程实现）会跨多轮 pause-resume 把 client_tool_*
      // / agent_run_* / run_started / run_complete 全部 forward 过来；reducer
      // 已经在 chat-kernel/chat-reducer.ts + thinking-reducer.ts 里全部识别。
      // 这里不再需要 pause-polling 兜底——后端 forwardByRun + main 进程
      // resubscribe 双层保活已经覆盖断流场景。
      setState((current) =>
        reduceChatRuntime(current, {
          type: 'stream_event',
          event: payload.event,
          receivedAt: payload.receivedAt,
        }),
      );
    });
    const unsubscribeDone = chatClient.onStreamDone((payload) => {
      const stale = isStaleStreamPayload(payload.streamId);
      console.log('[useCloudStreamEvents] stream:done received', {
        streamId: payload.streamId,
        activeRefStreamId: activeStreamIdRef.current,
        activeRefConvId: activeStreamConversationIdRef.current,
        stale,
      });
      if (stale) return;
      const streamConversationId = activeStreamConversationIdRef.current;
      activeStreamIdRef.current = null;
      activeStreamConversationIdRef.current = null;
      stopLocalProxyPolling();
      setState((current) => {
        if (!current.currentAssistantMessageId) {
          console.log('[useCloudStreamEvents] stream:done — no current assistant, only set isStreaming=false');
          return { ...current, isStreaming: false };
        }
        const nextState = reduceChatRuntime(current, {
          type: 'stream_event',
          event: { event: 'complete', data: {} },
          receivedAt: payload.completedAt,
        });
        // Stream-done reconcile 兜底：
        // 即便后端 EventForwarder + main 进程 runId-relay 在某条边缘路径上漏推
        // chat_complete / 末轮 content_delta（典型场景：续聊 exec-2 完成后产出的
        // 新 assistant message 内容，事件未被 forwardByRun 转出来），UI 仍会卡在
        // "thinking 卡 + 空 content"，必须手动刷新才看到结果。
        //
        // 在 stream done 时主动拉一次 /api/chat/messages/list 把 DB 真实状态拉回
        // 来 reconcile —— DB 一定是对的（落库走的是另一条路径），这能保证 UI
        // 自愈，断点收敛在这一处兜底而不是用户感知。
        const assistantId = current.currentAssistantMessageId;
        const assistant = nextState.messages.find((message) => message.id === assistantId);
        const conversationId =
          current.conversation?.id ?? streamConversationId ?? undefined;
        const contentEmpty = !!assistant && !assistant.content.trim();
        // 多跳续聊(ata-all→shell→最终回复)后,content_delta 已给 assistant 填了中间推理,
        // content 不为空 → 旧逻辑跳过 reconcile → 用户看到 delta 拼的思考过程而非 DB 最终版。
        // 改为无条件 reconcile：DB 一定是对的，stream_done 后拉一次 messages 覆盖 delta 缓冲。
        // 代价仅一次 HTTP 请求，换来 UI 自愈保证。
        const shouldReconcile = !!conversationId && !!assistant && assistant.role === 'assistant';
        console.log('[useCloudStreamEvents] reconcile check', {
          assistantId,
          assistantFound: !!assistant,
          assistantRole: assistant?.role,
          contentLen: assistant?.content?.length ?? 0,
          contentEmpty,
          shouldReconcile,
          conversationId,
          willReconcile: shouldReconcile,
        });
        if (shouldReconcile) {
          void chatClient
            .getMessages({ conversationId, limit: 50, order: 'asc' })
            .then((messagesEnvelope: { list?: readonly ChatMessage[] } | undefined) => {
              const list = messagesEnvelope?.list;
              console.log('[useCloudStreamEvents] reconcile fetch ok', {
                conversationId,
                listLen: list?.length ?? 0,
              });
              if (!Array.isArray(list) || list.length === 0) return;
              setState((latest) => {
                if (!latest.conversation || latest.conversation.id !== conversationId) {
                  console.log('[useCloudStreamEvents] reconcile applied: skipped (conversation switched)', {
                    expected: conversationId,
                    actual: latest.conversation?.id,
                  });
                  return latest;
                }
                console.log('[useCloudStreamEvents] reconcile applied: history_loaded dispatched', {
                  conversationId,
                  listLen: list.length,
                });
                return reduceChatRuntime(latest, {
                  type: 'history_loaded',
                  conversation: latest.conversation,
                  view: latest.view ?? resolveConversationView(latest.conversation),
                  messages: list,
                });
              });
            })
            .catch((err) => {
              console.warn('[useCloudStreamEvents] stream-done reconcile fetch failed', err);
            });
        }
        return nextState;
      });
      void refreshConversations();
    });
    const unsubscribeError = chatClient.onStreamError((payload) => {
      const stale = isStaleStreamPayload(payload.streamId);
      console.log('[useCloudStreamEvents] stream:error received', {
        streamId: payload.streamId,
        activeRefStreamId: activeStreamIdRef.current,
        activeRefConvId: activeStreamConversationIdRef.current,
        stale,
        error: payload.error,
      });
      if (stale) return;
      activeStreamIdRef.current = null;
      activeStreamConversationIdRef.current = null;
      stopLocalProxyPolling();
      setState((current) =>
        reduceChatRuntime(current, {
          type: 'stream_error',
          error: payload.error,
        }),
      );
    });

    return () => {
      unsubscribeEvent();
      unsubscribeDone();
      unsubscribeError();
    };
  }, [
    activeStreamConversationIdRef,
    activeStreamIdRef,
    enqueueClientToolCalls,
    executeClientToolCall,
    isAlwaysAllowed,
    refreshConversations,
    setState,
    stopLocalProxyPolling,
  ]);

  // Idle watchdog 必须在独立 useEffect 里，deps 只放真正稳定的引用（refs +
  // setState）。如果跟上面的事件订阅 useEffect 合并，executeClientToolCall /
  // refreshConversations 等 callback 依赖 conversationId，每次 state.conversation
  // 变化都会让 useEffect cleanup + re-setup，setInterval 永远跑不到 timeout 就被
  // clear，watchdog 实际上从未生效。
  //
  // 拆出来后这个 effect 只在 mount 时启动一次，setInterval 持续跑到 unmount。
  // NOTE: 之前两版自动 abort watchdog（idle-based / empty-content-based）都被实测
  // 证明会误伤正常 LLM 长思考场景（assistant.content 在 LLM 推理早期天然为空、
  // 持续 20s+ 是常态），导致 stream 被前端误 abort，DB 里只剩用户 message，UI 看
  // 起来"消息被吃了"。
  //
  // 自动判定"stream 是真的 hang 了"这件事在前端做不可靠 —— 真正的根治在后端
  // (cbu-xiaoer-node-service ChatStreamService 在 dev-mode 自动放行 client tool
  // 续聊完成后主动 sse.end)。前端目前保留的兜底路径：
  //   1. 用户点 stop → c39e9af 的 stopStream fix 让 onStreamDone 不被判 stale
  //      → 走 reconcile 自愈 UI（已 verified）。
  //   2. 后端任何路径下主动关闭 SSE → main 发 done → onStreamDone reconcile。
  //
  // 不再 setInterval 自动 abort。emptyAssistantSinceRef 也无需追踪。
}
