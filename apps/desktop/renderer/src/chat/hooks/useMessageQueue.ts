import { useCallback, useState } from 'react';
import type React from 'react';

import type { ChatAttachment } from '../state/types';
import type { EffortLevel } from '../state/preferences';

/**
 * 待发送消息队列项:当一轮 agent turn 正在运行/压缩时,用户继续提交的消息先入队,
 * 待当前轮结束后由 ChatSurface 的 dequeue effect 复用 submitMessage 自动发送下一条(不另造发送路径)。
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ChatAttachment[];
  effort: EffortLevel;
}

/**
 * useMessageQueue —— 待发送消息队列的状态与增删(state + enqueue + remove + setMessageQueue)。
 *
 * 行为与原 ChatSurface 内联逻辑逐字一致:
 * - enqueue 把消息压入队尾(id 由调用方生成,沿用既有 nextId 序号方案)。
 * - removeQueuedMessage 按 id 移除排队项。
 * - setMessageQueue 暴露给上层用于:会话恢复时灌入持久化队列、随会话切换的草稿/队列持久化 effect、
 *   以及当前轮结束后的自动出队。
 *
 * 说明:自动出队 effect 仍内联在 ChatSurface —— 它依赖 submitMessage(在组件内更晚声明),
 * 若改为经本 hook 参数注入会触发 const TDZ;且为保持「依赖 submitMessage 标识变化即重跑」的
 * 既有时序零差异,故出队编排留在 submitMessage 作用域内。本 hook 只持有队列状态与增删,
 * 不新增发送通道,发送真值仍在主进程。
 */
export function useMessageQueue(): {
  messageQueue: QueuedMessage[];
  setMessageQueue: React.Dispatch<React.SetStateAction<QueuedMessage[]>>;
  enqueue: (item: QueuedMessage) => void;
  removeQueuedMessage: (id: string) => void;
} {
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);

  const enqueue = useCallback((item: QueuedMessage) => {
    setMessageQueue((prev) => [...prev, item]);
  }, []);

  const removeQueuedMessage = useCallback((id: string) => {
    setMessageQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  return { messageQueue, setMessageQueue, enqueue, removeQueuedMessage };
}
