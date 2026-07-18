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
  areConversationStatesEqualForSurface,
  conversationStore,
  createConversationSurfaceSnapshotReader,
  type ConversationRuntimeState,
} from '../state/conversationStore';
import type { QueuedMessage, ToolProgress } from '../state/types';

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
  /** 设置当前会话输入草稿。 */
  setDraft: (draft: string) => void;
  /** 在当前会话待发送队列末尾追加一条用户消息。 */
  enqueueMessage: (item: QueuedMessage) => void;
  /** 从当前会话待发送队列中移除指定消息。 */
  removeQueuedMessage: (id: string) => void;
  /** 更新当前会话待发送队列中指定消息的文案（原地编辑）。 */
  updateQueuedMessage: (id: string, text: string) => void;
  /** 拖动排序：把 fromIndex 处的消息移动到 toIndex。 */
  reorderQueuedMessage: (fromIndex: number, toIndex: number) => void;
  /** 当前会话待发送队列出队一条消息；队列为空时返回 null。 */
  shiftQueuedMessage: () => QueuedMessage | null;
  /** 登记 streamId 归属当前会话（发送/压缩/reattach 时调用）。 */
  routeStream: (streamId: string) => void;
}

export interface UseConversationStateResult {
  readonly state: ConversationRuntimeState;
  readonly actions: ConversationActions;
}

/** 只让输入区响应高频草稿变化，避免每个字符重跑整个 ChatSurface。 */
export function useConversationDraft(conversationId: string | null): string {
  const subscribe = useCallback(
    (listener: () => void) => conversationStore.subscribeSelector(
      conversationId,
      snapshot => snapshot.draft,
      listener,
    ),
    [conversationId],
  );
  const getSnapshot = useCallback(
    () => conversationStore.getSnapshot(conversationId).draft,
    [conversationId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 只让活动消息里的进度提示响应高频工具参数进度。 */
export function useConversationToolProgress(
  conversationId: string | null,
  enabled: boolean,
): ToolProgress | null {
  const subscribe = useCallback(
    (listener: () => void) => enabled
      ? conversationStore.subscribeSelector(
          conversationId,
          (snapshot) => snapshot.toolProgress,
          listener,
        )
      : () => {},
    [conversationId, enabled],
  );
  const getSnapshot = useCallback(
    () => enabled ? conversationStore.getSnapshot(conversationId).toolProgress : null,
    [conversationId, enabled],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useConversationState(
  conversationId: string | null,
): UseConversationStateResult {
  const subscribe = useCallback(
    (listener: () => void) => conversationStore.subscribeSelector(
      conversationId,
      (snapshot) => snapshot,
      listener,
      areConversationStatesEqualForSurface,
    ),
    [conversationId],
  );
  const getSnapshot = useMemo(
    () => createConversationSurfaceSnapshotReader(
      () => conversationStore.getSnapshot(conversationId),
    ),
    [conversationId],
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const actions = useMemo<ConversationActions>(
    () => ({
      set: (patch) => conversationStore.setState(conversationId, patch),
      beginLoad: () => conversationStore.beginLoad(conversationId),
      commitLoad: (patch) => conversationStore.commitLoad(conversationId, patch),
      reset: () => conversationStore.reset(conversationId),
      setDraft: (draft) => conversationStore.setDraft(conversationId, draft),
      enqueueMessage: (item) => conversationStore.enqueueMessage(conversationId, item),
      removeQueuedMessage: (id) => conversationStore.removeQueuedMessage(conversationId, id),
      updateQueuedMessage: (id, text) => conversationStore.updateQueuedMessage(conversationId, id, text),
      reorderQueuedMessage: (fromIndex, toIndex) => conversationStore.reorderQueuedMessage(conversationId, fromIndex, toIndex),
      shiftQueuedMessage: () => conversationStore.shiftQueuedMessage(conversationId),
      routeStream: (streamId) => {
        if (conversationId) conversationStore.routeStream(streamId, conversationId);
      },
    }),
    [conversationId],
  );

  return { state, actions };
}
