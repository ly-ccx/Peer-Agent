import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';

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
type ModelEffortPatch = { effort?: EffortLevel; modelProviderId?: string | null };
type SaveModelEffortOptions = { passive?: boolean };

export interface ConversationModelEffort {
  effort: EffortLevel;
  modelProviderId: string | null;
  setEffort: Dispatch<SetStateAction<EffortLevel>>;
  setModelProviderId: Dispatch<SetStateAction<string | null>>;
  saveModelEffort: (patch: ModelEffortPatch, options?: SaveModelEffortOptions) => Promise<boolean>;
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
  const pendingWrites = useRef(new Map<string | null, Promise<boolean>>());

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

  const saveModelEffort = useCallback(async (
    patch: ModelEffortPatch,
    { passive = false }: SaveModelEffortOptions = {},
  ): Promise<boolean> => {
    const pending = pendingWrites.current;
    const previous = pending.get(conversationId);
    // User choices keep their order. A passive correction must run against the current snapshot.
    if (passive && previous) return false;
    const save = async () => {
      if (previous) await previous;
      if (conversationId && !conversationId.startsWith('draft-')) {
        const saved = await clientApi.conversationsUpdateModelEffort({ id: conversationId, ...patch });
        if (saved === null) return false;
      }
      const effortChanged = patch.effort !== conversationStore.getSnapshot(conversationId).effort;
      conversationStore.setState(conversationId, patch);
      writeLastModelProviderId(patch.modelProviderId);
      if (patch.effort !== undefined && effortChanged) {
        try {
          await clientApi.updateSettings({ effort: patch.effort });
        } catch {
          // The conversation update succeeded. Only the default for future drafts failed to save.
        }
      }
      return true;
    };
    // An execution can claim the conversation after the renderer's idle check.
    // Keep the last accepted selection so the controls can recover without a retry loop.
    const request = save().catch(() => false);
    pending.set(conversationId, request);
    try {
      return await request;
    } finally {
      if (pending.get(conversationId) === request) pending.delete(conversationId);
    }
  }, [conversationId]);

  return { effort, modelProviderId, setEffort, setModelProviderId, saveModelEffort };
}
