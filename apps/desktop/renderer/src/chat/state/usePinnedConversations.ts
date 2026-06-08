import type { AuthState, Conversation } from '@zeus-atlas/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getWorkId } from './runtimeHelpers';

const STORAGE_PREFIX = 'zeus-atlas:pinned-conversations:';

function readPinnedIds(storageKey: string): ReadonlySet<Conversation['id']> {
  try {
    const rawValue = window.localStorage.getItem(storageKey);
    if (!rawValue) return new Set();
    const parsedValue: unknown = JSON.parse(rawValue);
    if (!Array.isArray(parsedValue)) return new Set();
    return new Set(parsedValue.filter((value): value is number => typeof value === 'number'));
  } catch {
    return new Set();
  }
}

function writePinnedIds(storageKey: string, pinnedIds: ReadonlySet<Conversation['id']>) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...pinnedIds]));
  } catch {
    // Local preference persistence must not block the chat surface.
  }
}

export function usePinnedConversations(authState: AuthState | null) {
  const storageKey = useMemo(() => {
    const workId = getWorkId(authState);
    return workId ? `${STORAGE_PREFIX}${workId}` : null;
  }, [authState]);
  const [pinnedConversationIds, setPinnedConversationIds] = useState<ReadonlySet<Conversation['id']>>(() => new Set());
  const [loadedStorageKey, setLoadedStorageKey] = useState<string | null>(null);

  useEffect(() => {
    setPinnedConversationIds(storageKey ? readPinnedIds(storageKey) : new Set());
    setLoadedStorageKey(storageKey);
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey || loadedStorageKey !== storageKey) return;
    writePinnedIds(storageKey, pinnedConversationIds);
  }, [loadedStorageKey, pinnedConversationIds, storageKey]);

  const togglePinnedConversation = useCallback((conversation: Conversation) => {
    setPinnedConversationIds((current) => {
      const next = new Set(current);
      if (next.has(conversation.id)) {
        next.delete(conversation.id);
      } else {
        next.add(conversation.id);
      }
      return next;
    });
  }, []);

  const forgetPinnedConversation = useCallback((conversation: Conversation) => {
    setPinnedConversationIds((current) => {
      const next = new Set(current);
      next.delete(conversation.id);
      return next;
    });
  }, []);

  return {
    forgetPinnedConversation,
    pinnedConversationIds,
    togglePinnedConversation,
  };
}
