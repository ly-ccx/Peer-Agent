import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { Overlay } from '../../app/components/Overlay';
import { clientApi } from '../../clientApi';

export type SearchConversationHit = {
  readonly id: string;
  readonly title?: string;
  readonly workspacePath?: string | null;
  readonly updatedAt?: string;
  readonly createdAt?: string;
};

type PaletteItem =
  | { readonly kind: 'conversation'; readonly conversation: SearchConversationHit }
  | { readonly kind: 'new-task' };

interface ConversationSearchPaletteProps {
  readonly open: boolean;
  readonly i18n: I18nRuntime;
  readonly activeWorkspace?: string | null;
  readonly onClose: () => void;
  readonly onSelectConversation: (hit: SearchConversationHit) => void | Promise<void>;
  readonly onNewTask: () => void | Promise<void>;
}

function workspaceShortName(workspacePath?: string | null): string {
  if (!workspacePath) return '';
  const normalized = String(workspacePath).replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normalized;
}

function normalizeSearchQuery(query?: string): string {
  return String(query || '').trim().toLowerCase();
}

/** Client-side ranker mirrors conversation-store searchConversations P0 rules. */
function rankConversationMatch(meta: SearchConversationHit, query: string): number {
  const q = normalizeSearchQuery(query);
  if (!q) return 0;
  const title = normalizeSearchQuery(meta?.title);
  if (title.includes(q)) {
    if (title === q) return 300;
    if (title.startsWith(q)) return 200;
    return 100;
  }
  return -1;
}

function recencyKey(meta: SearchConversationHit): string {
  return String(meta.updatedAt || meta.createdAt || '');
}

function filterAndRankConversations(
  items: readonly SearchConversationHit[],
  query: string,
  limit: number,
): SearchConversationHit[] {
  const q = normalizeSearchQuery(query);
  let ranked: SearchConversationHit[];
  if (q) {
    ranked = items
      .map((meta) => ({ meta, score: rankConversationMatch(meta, q) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return recencyKey(b.meta).localeCompare(recencyKey(a.meta));
      })
      .map((entry) => entry.meta);
  } else {
    ranked = [...items].sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)));
  }
  return ranked.slice(0, limit);
}

/**
 * Load active conversation metas once for the palette session.
 * Prefer dedicated search IPC with empty query (recent active list); fall back to list.
 * Filtering stays on the client so typing never blocks on IPC.
 */
async function loadActiveConversationsForSearch(limit = 500): Promise<readonly SearchConversationHit[]> {
  const searchApi = (clientApi as { conversationsSearch?: (p: {
    query?: string;
    status?: 'active';
    limit?: number;
  }) => Promise<readonly SearchConversationHit[]> }).conversationsSearch;

  if (typeof searchApi === 'function') {
    try {
      const list = await searchApi({
        query: '',
        status: 'active',
        limit,
      });
      if (Array.isArray(list) && list.length > 0) return list;
    } catch (error) {
      console.warn('[search-chats] conversationsSearch failed, falling back to conversationsList', error);
    }
  }

  const list = await clientApi.conversationsList({ status: 'active' });
  return filterAndRankConversations((list || []) as readonly SearchConversationHit[], '', limit);
}

function highlightTitle(title: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return title;
  const lowerTitle = title.toLowerCase();
  const lowerQuery = q.toLowerCase();
  const index = lowerTitle.indexOf(lowerQuery);
  if (index < 0) return title;
  const before = title.slice(0, index);
  const match = title.slice(index, index + q.length);
  const after = title.slice(index + q.length);
  return (
    <>
      {before}
      <mark className="conversation-search-mark">{match}</mark>
      {after}
    </>
  );
}

export function ConversationSearchPalette({
  open,
  i18n,
  activeWorkspace,
  onClose,
  onSelectConversation,
  onNewTask,
}: ConversationSearchPaletteProps) {
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<readonly SearchConversationHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadSeq = useRef(0);

  // Reset query + focus when opening; load the active catalog once per open.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    setLoading(true);
    const seq = ++loadSeq.current;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    void (async () => {
      try {
        const list = await loadActiveConversationsForSearch(500);
        if (seq !== loadSeq.current) return;
        setCatalog(list);
      } catch (error) {
        console.warn('[search-chats] catalog load failed', error);
        if (seq !== loadSeq.current) return;
        setCatalog([]);
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    })();
    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [open]);

  // Typing only re-ranks the in-memory catalog — no IPC, no debounce needed.
  const results = useMemo(
    () => filterAndRankConversations(catalog, query, 50),
    [catalog, query],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query, results]);

  const items = useMemo<readonly PaletteItem[]>(() => {
    const conversationItems: PaletteItem[] = results.map((conversation) => ({
      kind: 'conversation',
      conversation,
    }));
    // P0 Suggested: only "New task", always available at the end of the list.
    return [...conversationItems, { kind: 'new-task' }];
  }, [results]);

  useEffect(() => {
    if (activeIndex >= items.length) {
      setActiveIndex(Math.max(0, items.length - 1));
    }
  }, [activeIndex, items.length]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-search-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, items.length]);

  const activateItem = useCallback(async (item: PaletteItem, requestClose: () => void) => {
    if (item.kind === 'new-task') {
      requestClose();
      await onNewTask();
      return;
    }
    requestClose();
    await onSelectConversation(item.conversation);
  }, [onNewTask, onSelectConversation]);

  if (!open) return null;

  return (
    <Overlay
      onClose={onClose}
      ariaLabel={i18n.t('searchChats.open')}
      panelClassName="conversation-search-panel"
    >
      {({ requestClose }) => (
        <div
          className="conversation-search"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              requestClose();
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) => Math.min(items.length - 1, index + 1));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(0, index - 1));
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              const item = items[activeIndex];
              if (item) void activateItem(item, requestClose);
              return;
            }
            // ⌘1–⌘9 jump to first 9 conversation rows (not Suggested).
            if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
              const target = Number(event.key) - 1;
              const conversationItems = items.filter((item) => item.kind === 'conversation');
              const item = conversationItems[target];
              if (item) {
                event.preventDefault();
                void activateItem(item, requestClose);
              }
            }
          }}
        >
          <div className="conversation-search-input-row">
            <svg className="conversation-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={inputRef}
              className="conversation-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={i18n.t('searchChats.placeholder')}
              aria-label={i18n.t('searchChats.placeholder')}
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="conversation-search-kbd">{i18n.t('searchChats.shortcut')}</kbd>
          </div>

          <div className="conversation-search-body" ref={listRef}>
            <div className="conversation-search-section-label">{i18n.t('searchChats.section.chats')}</div>
            {results.length === 0 && !loading ? (
              <div className="conversation-search-empty">{i18n.t('searchChats.empty')}</div>
            ) : null}
            {results.map((conversation, index) => {
              const title = (conversation.title || '').trim() || i18n.t('searchChats.untitled');
              const workspaceName = workspaceShortName(conversation.workspacePath);
              const isForeign = Boolean(
                conversation.workspacePath
                && activeWorkspace
                && conversation.workspacePath !== activeWorkspace,
              );
              const isActive = activeIndex === index;
              return (
                <button
                  key={conversation.id}
                  type="button"
                  className={`conversation-search-item${isActive ? ' is-active' : ''}`}
                  data-search-index={index}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => { void activateItem({ kind: 'conversation', conversation }, requestClose); }}
                >
                  <div className="conversation-search-item-main">
                    <div className="conversation-search-item-title">
                      {highlightTitle(title, query)}
                    </div>
                    {workspaceName ? (
                      <div className={`conversation-search-item-meta${isForeign ? ' is-foreign' : ''}`}>
                        {workspaceName}
                      </div>
                    ) : null}
                  </div>
                  {index < 9 ? (
                    <kbd className="conversation-search-item-shortcut">⌘{index + 1}</kbd>
                  ) : null}
                </button>
              );
            })}

            <div className="conversation-search-section-label conversation-search-section-suggested">
              {i18n.t('searchChats.section.suggested')}
            </div>
            <button
              type="button"
              className={`conversation-search-item conversation-search-item-suggested${activeIndex === results.length ? ' is-active' : ''}`}
              data-search-index={results.length}
              onMouseEnter={() => setActiveIndex(results.length)}
              onClick={() => { void activateItem({ kind: 'new-task' }, requestClose); }}
            >
              <div className="conversation-search-item-main">
                <div className="conversation-search-item-title">{i18n.t('searchChats.newTask')}</div>
              </div>
            </button>
          </div>
        </div>
      )}
    </Overlay>
  );
}
