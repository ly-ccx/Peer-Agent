import { useCallback, useState } from 'react';

import { clientApi } from '../../clientApi';
import type { ChatMode } from '../state/preferences';

/**
 * useConversationMode —— 每会话独立的对话模式（chat / goal）。
 *
 * 行为与原 ChatSurface 内联逻辑逐字一致：
 * - 初值 'chat'；切换会话时由调用方在 loadConversation effect 里通过 setMode(convMode) 恢复该会话自己的模式。
 * - changeMode 在本地 setState 后回写当前会话 meta（conversationsUpdateMode），无活跃会话时仅更新本地态。
 *   模式真值最终经 chatSend → IPC → mode-source 进入 System Context 的 L6_MODE_REMINDER 层
 *   （见 docs/proposals/0002-goal-mode.md）。
 *
 * 表达层只持有/回写这一个会话字段，不引入新的执行真值或发送路径。
 */
export function useConversationMode(conversationId: string | null): {
  mode: ChatMode;
  setMode: React.Dispatch<React.SetStateAction<ChatMode>>;
  changeMode: (next: ChatMode) => void;
} {
  const [mode, setMode] = useState<ChatMode>('chat');
  const changeMode = useCallback((next: ChatMode) => {
    setMode(next);
    // 回写到当前会话 meta;无活跃会话(理论上不会发生,UI 恒有会话)时仅更新本地态。
    if (conversationId) void clientApi.conversationsUpdateMode({ id: conversationId, mode: next });
  }, [conversationId]);
  return { mode, setMode, changeMode };
}
