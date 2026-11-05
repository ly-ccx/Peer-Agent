import { useEffect, useRef } from 'react';
import type { ContextAccountingSnapshot } from '@peer-agent/protocol';

import { clientApi } from '../../clientApi';
import { useConversationContextAccounting } from '../hooks/useConversationState';
import { conversationStore } from '../state/conversationStore';
import { contextAccountingRestoreKey, shouldStartContextAccountingRestore } from '../state/contextRestore';

/**
 * 上下文计量恢复只属于用量叶子。
 * 挂在 ChatSurface 里，但自己订阅 contextAccounting，避免快照刷新把整棵消息表面叫醒。
 */
export function ContextAccountingRestore({
  conversationId,
  loadStatus,
  isDraftConversation,
  providerId,
  model,
  modelProviderId,
  isBusy,
}: {
  readonly conversationId: string | null;
  readonly loadStatus: 'idle' | 'loading' | 'ready';
  readonly isDraftConversation: boolean;
  readonly providerId: string | null;
  readonly model: string | null | undefined;
  readonly modelProviderId: string | null;
  readonly isBusy: boolean;
}) {
  const contextAccounting = useConversationContextAccounting(conversationId);
  const attemptedKeysRef = useRef(new Set<string>());

  useEffect(() => {
    if (loadStatus !== 'ready' || !conversationId || isDraftConversation) return;
    const restoreInput = {
      conversationId,
      snapshot: contextAccounting,
      providerId: providerId ?? modelProviderId,
      model,
    };
    const requiresRestore = shouldStartContextAccountingRestore({
      attemptedKeys: attemptedKeysRef.current,
      ...restoreInput,
    });
    if (!requiresRestore || isBusy) return;
    if (typeof clientApi.chatContextRestored !== 'function') return;
    const restoreKey = contextAccountingRestoreKey(restoreInput);
    let cancelled = false;
    void clientApi.chatContextRestored({
      conversationId,
      modelProviderId: providerId ?? modelProviderId,
    })
      .then((snap: ContextAccountingSnapshot | null) => {
        if (cancelled) return;
        attemptedKeysRef.current.add(restoreKey);
        if (!snap) return;
        attemptedKeysRef.current.add(contextAccountingRestoreKey({
          ...restoreInput,
          snapshot: snap,
        }));
        conversationStore.setState(conversationId, { contextAccounting: snap });
      })
      .catch(() => {
        if (cancelled) return;
        attemptedKeysRef.current.add(restoreKey);
      });
    return () => { cancelled = true; };
  }, [
    loadStatus,
    conversationId,
    isDraftConversation,
    contextAccounting,
    providerId,
    model,
    modelProviderId,
    isBusy,
  ]);

  return null;
}
