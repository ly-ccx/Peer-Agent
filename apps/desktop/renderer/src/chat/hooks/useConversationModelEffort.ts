import { useCallback, type Dispatch, type SetStateAction } from 'react';

import { clientApi } from '../../clientApi';
import { conversationStore } from '../state/conversationStore';
import { useConversationState } from './useConversationState';
import { isEffortLevel, writeLastModelProviderId, type EffortLevel } from '../state/preferences';

/**
 * useConversationModelEffort —— 每会话独立的「模型（provider）+ 思考强度（effort）」绑定。
 *
 * 范式与 useConversationMode 一致：状态在 conversationStore 的会话/草稿桶中持有，
 * 切换时回写当前会话 meta（conversationsUpdateModelEffort），切换会话时由调用方在
 * loadConversation effect 里通过 setEffort / setModelProviderId 恢复该会话自己的绑定值。
 *
 * 设计取舍：
 * - modelProviderId 为会话级真值，null 表示「未绑定，用全局默认 provider」。切换模型只回写
 *   当前会话 meta，绝不影响其它会话（满足「随会话绑定、非一次性全局」诉求）。
 * - effort 同样按会话绑定回写会话 meta；同时回写全局设置（updateSettings）仅作为「新会话默认
 *   种子」——已有会话在加载时用各自 meta 值权威覆盖，故不同会话的 effort 相互独立。
 * - 真值最终经 chatSend → IPC → 会话 meta 兜底解析，后端以会话 store 为准（见 chat:send handler）。
 *
 * 表达层只读取/回写这两个绑定字段，不引入新的执行真值。setEffort / setModelProviderId
 * 供「按会话/按任务恢复」等场景直接覆盖本地态（不触发回写）。
 */
export interface ConversationModelEffort {
  effort: EffortLevel;
  modelProviderId: string | null;
  setEffort: Dispatch<SetStateAction<EffortLevel>>;
  setModelProviderId: Dispatch<SetStateAction<string | null>>;
  changeEffort: (level: EffortLevel) => void;
  changeModelProviderId: (providerId: string | null) => void;
}

export function useConversationModelEffort(conversationId: string | null): ConversationModelEffort {
  const storedEffort = (clientApi.initialSettings as Record<string, unknown>)?.effort;
  const defaultEffort = isEffortLevel(storedEffort) ? storedEffort : 'default';
  if (!conversationStore.hasBucket(conversationId)) {
    conversationStore.setState(conversationId, { effort: defaultEffort });
  }
  const { state } = useConversationState(conversationId);
  const effort = state.effort;
  const modelProviderId = state.modelProviderId;

  const setEffort = useCallback<Dispatch<SetStateAction<EffortLevel>>>((value) => {
    conversationStore.setState(conversationId, (current) => ({
      effort: typeof value === 'function' ? value(current.effort) : value,
    }));
  }, [conversationId]);

  const setModelProviderId = useCallback<Dispatch<SetStateAction<string | null>>>((value) => {
    conversationStore.setState(conversationId, (current) => ({
      modelProviderId: typeof value === 'function' ? value(current.modelProviderId) : value,
    }));
  }, [conversationId]);

  const changeEffort = useCallback((level: EffortLevel) => {
    setEffort(level);
    // 全局设置：仅作为新会话默认种子，跨重启保留「上次用的档位」。
    void clientApi.updateSettings({ effort: level });
    // 会话级绑定：当前会话 meta 为该会话的权威 effort，加载时覆盖本地态。
    if (conversationId) void clientApi.conversationsUpdateModelEffort({ id: conversationId, effort: level });
  }, [conversationId]);

  const changeModelProviderId = useCallback((providerId: string | null) => {
    setModelProviderId(providerId);
    // 模型只按会话绑定，不写全局设置，避免「一次切换全局通用」。
    if (conversationId) void clientApi.conversationsUpdateModelEffort({ id: conversationId, modelProviderId: providerId });
    // 同步写入共享记忆，供 Quick 漂浮窗默认跟随主聊天当前/上次模型。
    writeLastModelProviderId(providerId);
  }, [conversationId]);

  return { effort, modelProviderId, setEffort, setModelProviderId, changeEffort, changeModelProviderId };
}
