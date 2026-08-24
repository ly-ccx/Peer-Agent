import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { normalizeConversationListPage } from '../state/conversationListPagination';
import {
  mergeConversationLists,
  nextRevealedTaskCount,
  shouldFetchWorkspaceTaskPage,
  WORKSPACE_TASK_PREVIEW_SIZE,
  workspaceListPath,
} from '../state/workspaceTaskPreview';

interface WorkspaceTaskPageState {
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly fetched: boolean;
}

export function useWorkspaceTaskPages<T extends { id: string }>(options: {
  readonly conversations: readonly T[];
  readonly status: 'active' | 'archived';
}): {
  readonly mergedConversations: readonly T[];
  readonly ensurePage: (workspaceKey: string) => void;
  readonly loadMore: (workspaceKey: string, loadedCount: number) => void;
  readonly revealedCount: (workspaceKey: string) => number;
  readonly pageHasMore: (workspaceKey: string) => boolean;
  readonly forgetConversation: (id: string) => void;
} {
  const { conversations, status } = options;
  const [extra, setExtra] = useState<readonly T[]>([]);
  const [pages, setPages] = useState<Readonly<Record<string, WorkspaceTaskPageState>>>({});
  const [revealed, setRevealed] = useState<Readonly<Record<string, number>>>({});
  const pagesRef = useRef(pages);
  const revealedRef = useRef(revealed);
  const inflightRef = useRef(new Set<string>());
  pagesRef.current = pages;
  revealedRef.current = revealed;

  useEffect(() => {
    setExtra([]);
    setPages({});
    setRevealed({});
    inflightRef.current.clear();
  }, [status]);

  const fetchPage = useCallback(async (workspaceKey: string, append: boolean) => {
    if (inflightRef.current.has(workspaceKey)) return;
    const current = pagesRef.current[workspaceKey];
    if (append && current && !current.hasMore) return;
    inflightRef.current.add(workspaceKey);
    try {
      const page = await clientApi.conversationsList({
        workspacePath: workspaceListPath(workspaceKey),
        status,
        limit: WORKSPACE_TASK_PREVIEW_SIZE,
        cursor: append ? current?.nextCursor : undefined,
        paginated: true,
        includeMessageCount: false,
      });
      const normalized = normalizeConversationListPage(page as Parameters<typeof normalizeConversationListPage>[0]);
      setExtra((prev) => mergeConversationLists(prev, normalized.items as T[]));
      setPages((prev) => ({
        ...prev,
        [workspaceKey]: {
          nextCursor: normalized.nextCursor,
          hasMore: normalized.hasMore,
          fetched: true,
        },
      }));
      if (append) {
        setRevealed((prev) => {
          const currentRevealed = prev[workspaceKey] ?? WORKSPACE_TASK_PREVIEW_SIZE;
          return {
            ...prev,
            [workspaceKey]: currentRevealed + normalized.items.length,
          };
        });
      }
    } catch {
      setPages((prev) => ({
        ...prev,
        [workspaceKey]: current ?? { nextCursor: null, hasMore: false, fetched: true },
      }));
    } finally {
      inflightRef.current.delete(workspaceKey);
    }
  }, [status]);

  const ensurePage = useCallback((workspaceKey: string) => {
    const current = pagesRef.current[workspaceKey];
    if (current?.fetched || inflightRef.current.has(workspaceKey)) return;
    void fetchPage(workspaceKey, false);
  }, [fetchPage]);

  const loadMore = useCallback((workspaceKey: string, loadedCount: number) => {
    const currentRevealed = revealedRef.current[workspaceKey] ?? WORKSPACE_TASK_PREVIEW_SIZE;
    const currentPage = pagesRef.current[workspaceKey];
    if (loadedCount > currentRevealed) {
      setRevealed((prev) => ({
        ...prev,
        [workspaceKey]: nextRevealedTaskCount(currentRevealed, loadedCount),
      }));
      return;
    }
    if (!shouldFetchWorkspaceTaskPage({
      revealedCount: currentRevealed,
      loadedCount,
      hasMore: currentPage?.hasMore === true,
      fetched: currentPage?.fetched === true,
    })) {
      return;
    }
    void fetchPage(workspaceKey, currentPage?.fetched === true);
  }, [fetchPage]);

  const revealedCount = useCallback((workspaceKey: string) => (
    revealed[workspaceKey] ?? WORKSPACE_TASK_PREVIEW_SIZE
  ), [revealed]);

  const pageHasMore = useCallback((workspaceKey: string) => (
    pages[workspaceKey]?.hasMore === true
  ), [pages]);

  const forgetConversation = useCallback((id: string) => {
    setExtra((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const mergedConversations = useMemo(
    () => mergeConversationLists(conversations, extra),
    [conversations, extra],
  );

  return {
    mergedConversations,
    ensurePage,
    loadMore,
    revealedCount,
    pageHasMore,
    forgetConversation,
  };
}
