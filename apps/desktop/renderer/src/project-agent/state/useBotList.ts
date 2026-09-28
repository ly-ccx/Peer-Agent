import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { filterBotList, type BotListItem } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { PROJECT_AGENT_SHELL_EVENT, projectAgentShellOf } from '../onboarding/botShell';
import {
  applyBotRefresh,
  BOT_LIST_WIDTH_STORAGE_KEY,
  mergeBotSearch,
  readBotListWidth,
  retainSelectedId,
  visibleBotList,
} from './botListState';

function readStoredWidth(): number {
  try {
    return readBotListWidth(globalThis.localStorage?.getItem(BOT_LIST_WIDTH_STORAGE_KEY));
  } catch {
    return readBotListWidth(null);
  }
}

function writeStoredWidth(value: number) {
  try {
    globalThis.localStorage?.setItem(BOT_LIST_WIDTH_STORAGE_KEY, String(value));
  } catch {
    // 本机偏好写不进去时，这次会话仍用内存里的宽度。
  }
}

export type BotListStatus = 'loading' | 'ready' | 'disabled' | 'error';

export interface BotCreateResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly workspaceId?: string;
}

/**
 * App 只读这个钩子。界面真值在设置里的 projectAgent.shell。
 * 还没读到设置时先进入机器人列表。
 */
export function useBotListShell() {
  const [active, setActive] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void clientApi.getSettings().then((settings) => {
      if (!cancelled) setActive(projectAgentShellOf(settings) === 'bots');
    }).catch(() => {});
    const onShell = (event: Event) => {
      const shell = (event as CustomEvent<string>).detail;
      setActive(shell !== 'classic');
    };
    window.addEventListener(PROJECT_AGENT_SHELL_EVENT, onShell);
    return () => {
      cancelled = true;
      window.removeEventListener(PROJECT_AGENT_SHELL_EVENT, onShell);
    };
  }, []);

  return { active };
}

export function useBotList() {
  const [catalog, setCatalog] = useState<readonly BotListItem[]>([]);
  const [searchHits, setSearchHits] = useState<readonly BotListItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [needsYouOnly, setNeedsYouOnly] = useState(false);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [status, setStatus] = useState<BotListStatus>('loading');
  const [width, setWidthState] = useState(readStoredWidth);
  const [creating, setCreating] = useState(false);
  const catalogRef = useRef<readonly BotListItem[]>([]);

  const replaceCatalog = useCallback((next: readonly BotListItem[]) => {
    const sorted = sortReadyCatalog(next);
    catalogRef.current = sorted;
    setCatalog(sorted);
    setOpenedId((current) => retainSelectedId(current, sorted));
    setHighlightedId((current) => retainSelectedId(current, sorted));
  }, []);

  const reload = useCallback(async () => {
    const result = await clientApi.projectAgentList();
    if (!result?.ok) {
      setStatus(result?.code === 'PROJECT_AGENT_DISABLED' ? 'disabled' : 'error');
      return;
    }
    replaceCatalog(result.items ?? []);
    setStatus('ready');
  }, [replaceCatalog]);

  useEffect(() => {
    let cancelled = false;
    void reload().catch(() => {
      if (!cancelled) setStatus('error');
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const refreshIds = useCallback(async (workspaceIds: readonly string[]) => {
    if (workspaceIds.length === 0) {
      await reload();
      return;
    }
    const updates = [];
    for (const workspaceId of workspaceIds) {
      const result = await clientApi.projectAgentGet({ workspaceId });
      if (result?.ok && result.item) updates.push({ workspaceId, item: result.item });
      else if (result?.code === 'ARCHIVED' || result?.code === 'NOT_FOUND') updates.push({ workspaceId, item: null });
    }
    if (updates.length === 0) return;
    replaceCatalog(applyBotRefresh(catalogRef.current, updates));
  }, [reload, replaceCatalog]);

  useEffect(() => {
    const onChange = (event: { workspaceIds?: readonly string[] }) => {
      void refreshIds(event?.workspaceIds ?? []).catch(() => {});
    };
    const offChanged = clientApi.onProjectAgentChanged(onChange);
    // 新消息只发 conversation-changed。预览和未读靠同一条局部刷新跟上。
    const offConversation = clientApi.onProjectAgentConversationChanged(onChange);
    return () => {
      offChanged?.();
      offConversation?.();
    };
  }, [refreshIds]);

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setSearchHits(null);
      return undefined;
    }
    let cancelled = false;
    void clientApi.projectAgentSearch({ query: text }).then((result) => {
      if (cancelled) return;
      if (!result?.ok) return;
      setSearchHits(mergeBotSearch(catalogRef.current, result.items ?? []));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [query, catalog]);

  const trimmedQuery = query.trim();
  const searched = trimmedQuery
    ? (searchHits ?? filterBotList(catalog, { query: trimmedQuery }))
    : catalog;
  const visible = useMemo(
    () => visibleBotList(searched, { needsYouOnly }),
    [searched, needsYouOnly],
  );

  const setWidth = useCallback((next: number) => {
    setWidthState(next);
    writeStoredWidth(next);
  }, []);

  const openBot = useCallback((workspaceId: string) => {
    setOpenedId(workspaceId);
    setHighlightedId(workspaceId);
    setMenuOpen(false);
    void clientApi.projectAgentMarkRead({ workspaceId }).catch(() => {});
  }, []);

  const finishCreate = useCallback(async (result: { ok?: boolean; code?: string; workspaceId?: string }): Promise<BotCreateResult> => {
    if (result?.code === 'CANCELLED') return { ok: false, code: 'CANCELLED' };
    if (!result?.ok || !result.workspaceId) return { ok: false, code: result?.code || 'FAILED' };
    setQuery('');
    setNeedsYouOnly(false);
    setSheetOpen(false);
    setOpenedId(result.workspaceId);
    setHighlightedId(result.workspaceId);
    try {
      await reload();
    } catch {
      setStatus('error');
    }
    setOpenedId(result.workspaceId);
    setHighlightedId(result.workspaceId);
    return { ok: true, workspaceId: result.workspaceId };
  }, [reload]);

  const createBind = useCallback(async () => {
    setCreating(true);
    try {
      return await finishCreate(await clientApi.projectAgentCreate({ kind: 'bind' }));
    } finally {
      setCreating(false);
    }
  }, [finishCreate]);

  const createManaged = useCallback(async (name: string) => {
    setCreating(true);
    try {
      return await finishCreate(await clientApi.projectAgentCreate({ kind: 'managed', name }));
    } finally {
      setCreating(false);
    }
  }, [finishCreate]);

  return {
    status,
    catalog,
    visible,
    query,
    setQuery,
    needsYouOnly,
    setNeedsYouOnly,
    openedId,
    highlightedId,
    setHighlightedId,
    openBot,
    sheetOpen,
    setSheetOpen,
    menuOpen,
    setMenuOpen,
    width,
    setWidth,
    creating,
    createBind,
    createManaged,
    searching: query.trim().length > 0,
  };
}

function sortReadyCatalog(items: readonly BotListItem[]): BotListItem[] {
  return visibleBotList(items);
}
