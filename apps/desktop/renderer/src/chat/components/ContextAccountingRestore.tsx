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
  providerId,
  model,
  modelProviderId,
  canRestore,
}: {
  readonly conversationId: string | null;
  readonly providerId: string | null;
  readonly model: string | null | undefined;
  readonly modelProviderId: string | null;
  readonly canRestore: boolean;
}) {
  const contextAccounting = useConversationContextAccounting(conversationId);
  const attemptedKeysRef = useRef(new Set<string>());

  useEffect(() => {
    if (!canRestore || !conversationId || conversationId.startsWith('draft-')) return;
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
    const restoreContext = clientApi.chatContextRestored;
    if (!requiresRestore || typeof restoreContext !== 'function') return;
    const restoreKey = contextAccountingRestoreKey(restoreInput);
    let cancelled = false;
    // The parent load effect can mark a cached conversation as reattaching in this commit.
    void Promise.resolve()
      .then(async () => {
        if (cancelled) return;
        const current = conversationStore.getSnapshot(conversationId);
        if (current.streamStatus !== 'confirmed' || current.isStreaming) return;
        const snap: ContextAccountingSnapshot | null = await restoreContext({
          conversationId,
          modelProviderId: providerId ?? modelProviderId,
        });
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
    conversationId,
    contextAccounting,
    providerId,
    model,
    modelProviderId,
    canRestore,
  ]);

  return null;
}
