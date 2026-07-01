// 订阅某个会话运行态切片的 React hook。
//
// 把 conversationStore（按 conversationId 分桶的外部 store）接到 React 渲染：组件传入
// 当前 conversationId，hook 用 useSyncExternalStore 订阅对应桶，桶变化时仅触发该组件
// 重渲染。切会话 = 换订阅 key（subscribe/getSnapshot 闭包随 conversationId 变化重建），
// 物理上不存在「被复用的共享 messages 槽位」，因此跨会话串内容在架构层不可能发生。
//
// 返回值：
//   - state：该会话的不可变运行态快照（未知会话为稳定的 EMPTY 单例）。
//   - actions：绑定到「当前 conversationId」的稳定写入句柄，替代组件里原先一堆 setXxx。
//     actions 仅依赖 conversationId，故 conversationId 不变时引用稳定，可安全进 deps。

import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  conversationStore,
  type ConversationRuntimeState,
} from '../state/conversationStore';

/** 绑定到具体 conversationId 的运行态写入句柄。 */
export interface ConversationActions {
  /** 不可变 patch（对象或基于上一快照的 updater）。 */
  set: (
    patch:
      | Partial<ConversationRuntimeState>
      | ((prev: ConversationRuntimeState) => Partial<ConversationRuntimeState>),
  ) => void;
  /** 进入加载阶段：归零内容并标记 loading。 */
  beginLoad: () => void;
  /** 加载完成：写入消息等并标记 ready。 */
  commitLoad: (patch: Partial<ConversationRuntimeState>) => void;
  /** 丢弃当前会话桶。 */
  reset: () => void;
  /** 登记 streamId 归属当前会话（发送/压缩/reattach 时调用）。 */
  routeStream: (streamId: string) => void;
}

export interface UseConversationStateResult {
  readonly state: ConversationRuntimeState;
  readonly actions: ConversationActions;
}

export function useConversationState(
  conversationId: string | null,
): UseConversationStateResult {
  const subscribe = useCallback(
    (listener: () => void) => conversationStore.subscribe(conversationId, listener),
    [conversationId],
  );
  const getSnapshot = useCallback(
    () => conversationStore.getSnapshot(conversationId),
    [conversationId],
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const actions = useMemo<ConversationActions>(
    () => ({
      set: (patch) => conversationStore.setState(conversationId, patch),
      beginLoad: () => conversationStore.beginLoad(conversationId),
      commitLoad: (patch) => conversationStore.commitLoad(conversationId, patch),
      reset: () => conversationStore.reset(conversationId),
      routeStream: (streamId) => {
        if (conversationId) conversationStore.routeStream(streamId, conversationId);
      },
    }),
    [conversationId],
  );

  return { state, actions };
}
