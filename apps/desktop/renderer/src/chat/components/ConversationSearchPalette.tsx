import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { Overlay } from '../../app/components/Overlay';
import { clientApi } from '../../clientApi';
import {
  groupSearchConversationsByWorkspace,
  type SearchConversationHit,
} from './conversationSearchGrouping';

export type { SearchConversationHit } from './conversationSearchGrouping';

type PaletteItem =
  | { readonly kind: 'conversation'; readonly conversation: SearchConversationHit }
  | { readonly kind: 'new-task' };

export interface ProjectSearchHit {
  readonly id: string;
  readonly kind: 'bot' | 'message' | 'task' | 'memory';
  readonly workspaceId: string;
  readonly title: string;
  readonly text: string;
  readonly messageId?: string;
  readonly sessionId?: string;
  readonly memoryId?: string;
  readonly updatedAt?: string;
}

interface ConversationSearchPaletteProps {
  readonly open: boolean;
  readonly i18n: I18nRuntime;
  readonly activeWorkspace?: string | null;
  readonly mode?: 'classic' | 'bots';
  readonly onClose: () => void;
  readonly onSelectConversation: (hit: SearchConversationHit) => void | Promise<void>;
  readonly onSelectHit?: (hit: ProjectSearchHit) => void;
  readonly onNewTask: () => void | Promise<void>;
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

const SEARCH_KIND_LABEL = {
  bot: 'projectAgent.search.section.bots',
  message: 'projectAgent.search.section.messages',
  task: 'projectAgent.search.section.tasks',
  memory: 'projectAgent.search.section.memory',
} as const;

function BotSearchSections({
  hits,
  loading,
  query,
  activeIndex,
  i18n,
  onHover,
  onSelect,
}: {
  readonly hits: readonly ProjectSearchHit[];
  readonly loading: boolean;
  readonly query: string;
  readonly activeIndex: number;
  readonly i18n: I18nRuntime;
  readonly onHover: (index: number) => void;
  readonly onSelect: (hit: ProjectSearchHit) => void;
}) {
  const kinds = ['bot', 'message', 'task', 'memory'] as const;
  return (
    <>
      {hits.length === 0 && !loading ? (
        <div className="conversation-search-empty">{i18n.t('projectAgent.search.empty')}</div>
      ) : null}
      {kinds.map((kind) => {
        const rows = hits
          .map((hit, index) => ({ hit, index }))
          .filter((row) => row.hit.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind} className="conversation-search-workspace-group">
            <div className="conversation-search-section-label">{i18n.t(SEARCH_KIND_LABEL[kind])}</div>
            {rows.map(({ hit, index }) => (
              <button
                key={hit.id}
                type="button"
                className={`conversation-search-item${activeIndex === index ? ' is-active' : ''}`}
                data-search-index={index}
                onMouseEnter={() => onHover(index)}
                onClick={() => onSelect(hit)}
              >
                <div className="conversation-search-item-main">
                  <div className="conversation-search-item-title">{highlightTitle(hit.title || hit.text, query)}</div>
                </div>
                {index < 9 ? <kbd className="conversation-search-item-shortcut">⌘{index + 1}</kbd> : null}
              </button>
            ))}
          </section>
        );
      })}
    </>
  );
}

export function ConversationSearchPalette({
  open,
  i18n,
  activeWorkspace,
  mode = 'classic',
  onClose,
  onSelectConversation,
  onSelectHit,
  onNewTask,
}: ConversationSearchPaletteProps) {
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<readonly SearchConversationHit[]>([]);
  const [botHits, setBotHits] = useState<readonly ProjectSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const loadSeq = useRef(0);

  // Reset query + focus when opening; load the active catalog once per open.
  useEffect(() => {
    if (!open || mode === 'bots') return;
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
  }, [mode, open]);

  useEffect(() => {
    if (!open || mode !== 'bots') return undefined;
    setQuery('');
    setActiveIndex(0);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [mode, open]);

  useEffect(() => {
    if (!open || mode !== 'bots') return undefined;
    setLoading(true);
    const seq = ++loadSeq.current;
    const handle = window.setTimeout(() => {
      void clientApi.projectAgentSearch({ query }).then((result) => {
        if (seq !== loadSeq.current) return;
        const hits = Array.isArray(result?.hits) ? result.hits : [];
        setBotHits(hits.filter((hit): hit is ProjectSearchHit => (
          Boolean(hit)
          && (hit.kind === 'bot' || hit.kind === 'message' || hit.kind === 'task' || hit.kind === 'memory')
          && typeof hit.workspaceId === 'string'
        )));
        setLoading(false);
      }).catch(() => {
        if (seq !== loadSeq.current) return;
        setBotHits([]);
        setLoading(false);
      });
    }, 80);
    return () => window.clearTimeout(handle);
  }, [mode, open, query]);

  // Typing only re-ranks the in-memory catalog — no IPC, no debounce needed.
  const rankedResults = useMemo(
    () => filterAndRankConversations(catalog, query, 50),
    [catalog, query],
  );
  const workspaceGroups = useMemo(
    () => groupSearchConversationsByWorkspace(rankedResults, activeWorkspace),
    [activeWorkspace, rankedResults],
  );
  const results = useMemo(
    () => workspaceGroups.flatMap((group) => group.conversations),
    [workspaceGroups],
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
              const last = mode === 'bots' ? Math.max(0, botHits.length - 1) : items.length - 1;
              setActiveIndex((index) => Math.min(last, index + 1));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(0, index - 1));
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              if (mode === 'bots') {
                const hit = botHits[activeIndex];
                if (hit) {
                  requestClose();
                  onSelectHit?.(hit);
                }
                return;
              }
              const item = items[activeIndex];
              if (item) void activateItem(item, requestClose);
              return;
            }
            // ⌘1–⌘9 jump to the first 9 results. In the classic palette that is
            // still a conversation row, not the suggested new-task row.
            if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
              const target = Number(event.key) - 1;
              if (mode === 'bots') {
                const hit = botHits[target];
                if (hit) {
                  event.preventDefault();
                  requestClose();
                  onSelectHit?.(hit);
                }
                return;
              }
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
              placeholder={mode === 'bots' ? i18n.t('projectAgent.search.placeholder') : i18n.t('searchChats.placeholder')}
              aria-label={mode === 'bots' ? i18n.t('projectAgent.search.placeholder') : i18n.t('searchChats.placeholder')}
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="conversation-search-kbd">{i18n.t('searchChats.shortcut')}</kbd>
          </div>

          <div className="conversation-search-body" ref={listRef}>
            {mode === 'bots' ? (
              <BotSearchSections
                hits={botHits}
                loading={loading}
                query={query}
                activeIndex={activeIndex}
                i18n={i18n}
                onHover={setActiveIndex}
                onSelect={(hit) => {
                  onSelectHit?.(hit);
                  requestClose();
                }}
              />
            ) : null}
            {mode === 'bots' ? null : <div className="conversation-search-section-label">{i18n.t('searchChats.section.chats')}</div>}
            {mode !== 'bots' && results.length === 0 && !loading ? (
              <div className="conversation-search-empty">{i18n.t('searchChats.empty')}</div>
            ) : null}
            {mode === 'bots' ? null : workspaceGroups.map((group, groupIndex) => {
              const groupStartIndex = workspaceGroups
                .slice(0, groupIndex)
                .reduce((total, previous) => total + previous.conversations.length, 0);
              const groupLabel = group.workspaceName || i18n.t('searchChats.workspace.unassigned');
              return (
                <section
                  key={group.workspacePath || '__unassigned__'}
                  className="conversation-search-workspace-group"
                  aria-label={groupLabel}
                >
                  <div className="conversation-search-workspace-label">
                    <span>{groupLabel}</span>
                    {group.isActiveWorkspace ? (
                      <span className="conversation-search-workspace-current">
                        {i18n.t('searchChats.workspace.current')}
                      </span>
                    ) : null}
                  </div>
                  {group.conversations.map((conversation, groupItemIndex) => {
                    const index = groupStartIndex + groupItemIndex;
                    const title = (conversation.title || '').trim() || i18n.t('searchChats.untitled');
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
                        </div>
                        {index < 9 ? (
                          <kbd className="conversation-search-item-shortcut">⌘{index + 1}</kbd>
                        ) : null}
                      </button>
                    );
                  })}
                </section>
              );
            })}

            {mode === 'bots' ? null : (
              <div className="conversation-search-section-label conversation-search-section-suggested">
                {i18n.t('searchChats.section.suggested')}
              </div>
            )}
            {mode === 'bots' ? null : (
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
            )}
          </div>
        </div>
      )}
    </Overlay>
  );
}
