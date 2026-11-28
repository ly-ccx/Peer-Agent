import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { InputDraftTaskRef } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { ExecutorIcon, executorDisplayName } from '../ExecutorIcon';
import { PeerIcon } from '../../ui/icons';
import { useInteractionLayer } from '../../app/hooks/useInteractionLayer';
import {
  formatDrawerSessionStatus,
  formatDrawerStamp,
  readDrawerSession,
  type DrawerSession,
} from '../state/drawerState';
import { recencyBucketOf, type RecencyBucketKey, type SidebarTaskEntry } from '../state/botNavigationState';

export type TouchBarTrayMode = 'active' | 'history' | null;
type HistoryCategory = 'all' | 'settled' | 'canceled' | 'failed';

export interface TouchBarTrayProps {
  readonly mode: Exclude<TouchBarTrayMode, null>;
  readonly workspaceId: string;
  readonly botName: string;
  readonly activeTasks: readonly SidebarTaskEntry[];
  readonly historyTotalHint: number;
  readonly i18n: I18nRuntime;
  readonly triggerRef: React.RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onOpenTask: (sessionId: string) => void;
  readonly onCiteTask: (ref: InputDraftTaskRef) => void;
}

const HISTORY_PAGE_SIZE = 20;

function statusGlyph(status: string, reason?: string): { icon: 'check' | 'close' | 'warning' | 'loader' | 'circle'; tone: string; spin?: boolean } {
  if (status === 'accepted' || reason === 'settled') return { icon: 'check', tone: 'good' };
  if (status === 'failed' || reason === 'verification_failed') return { icon: 'warning', tone: 'danger' };
  if (status === 'waiting_user') return { icon: 'warning', tone: 'warn' };
  if (status === 'cancelled' || status === 'superseded' || status === 'paused') return { icon: 'close', tone: 'muted' };
  if (status === 'queued') return { icon: 'circle', tone: 'muted' };
  return { icon: 'loader', tone: 'azure', spin: true };
}

export function TouchBarTray({
  mode,
  workspaceId,
  botName,
  activeTasks,
  historyTotalHint,
  i18n,
  triggerRef,
  onClose,
  onOpenTask,
  onCiteTask,
}: TouchBarTrayProps) {
  const isZh = i18n.locale.startsWith('zh');
  const panelRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useInteractionLayer(true, {
    roots: [panelRef],
    trigger: triggerRef,
    modal: false,
    outside: true,
    onClose,
  });

  // History server-backed query state
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [category, setCategory] = useState<HistoryCategory>('all');
  const [historyRows, setHistoryRows] = useState<readonly DrawerSession[]>([]);
  const [totalCount, setTotalCount] = useState<number>(historyTotalHint);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [retrySeq, setRetrySeq] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 180);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (mode === 'history') {
      requestAnimationFrame(() => searchInputRef.current?.focus({ preventScroll: true }));
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== 'history') return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    void clientApi.projectAgentListSessions({
      workspaceId,
      scope: 'history',
      category,
      query: debouncedQuery || undefined,
      limit: HISTORY_PAGE_SIZE,
    }).then((result) => {
      if (cancelled) return;
      if (!result?.ok) {
        setError(true);
        setLoading(false);
        return;
      }
      const parsed = (result.sessions ?? [])
        .map(readDrawerSession)
        .filter((row): row is DrawerSession => row !== null);
      setHistoryRows(parsed);
      setTotalCount(typeof result.totalCount === 'number' ? result.totalCount : parsed.length);
      setNextCursor(result.nextCursor ?? null);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setError(true);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [mode, workspaceId, category, debouncedQuery, retrySeq]);

  const loadMoreHistory = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await clientApi.projectAgentListSessions({
        workspaceId,
        scope: 'history',
        category,
        query: debouncedQuery || undefined,
        cursor: nextCursor,
        limit: HISTORY_PAGE_SIZE,
      });
      if (result?.ok) {
        const more = (result.sessions ?? [])
          .map(readDrawerSession)
          .filter((row): row is DrawerSession => row !== null);
        setHistoryRows((prev) => {
          const seen = new Set(prev.map(r => r.sessionId));
          return [...prev, ...more.filter(r => !seen.has(r.sessionId))];
        });
        setNextCursor(result.nextCursor ?? null);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [workspaceId, category, debouncedQuery, nextCursor, loadingMore]);

  const groupedHistory = useMemo(() => {
    const labels: Record<RecencyBucketKey, string> = isZh
      ? { today: '今天', week: '本周', earlier: '更早' }
      : { today: 'Today', week: 'This week', earlier: 'Earlier' };
    const buckets: { key: RecencyBucketKey; label: string; items: DrawerSession[] }[] = [];
    for (const row of historyRows) {
      const key = recencyBucketOf(row.spawnedAt);
      let group = buckets.find((b) => b.key === key);
      if (!group) {
        group = { key, label: labels[key], items: [] };
        buckets.push(group);
      }
      group.items.push(row);
    }
    return buckets;
  }, [historyRows, isZh]);

  if (mode === 'active') {
    return (
      <section
        ref={panelRef}
        className="bot-touchbar-tray"
        aria-label={isZh ? `${botName} 进行中的任务` : `${botName} active tasks`}
      >
        <header className="bot-tray-head">
          <div className="bot-tray-title-wrap">
            <span className="bot-tray-title">{isZh ? `${botName} · 进行中的任务` : `${botName} · Active tasks`}</span>
            <span className="bot-tray-sub">{isZh ? `${activeTasks.length} 项` : `${activeTasks.length}`}</span>
          </div>
          <button type="button" className="bot-tray-close" aria-label={isZh ? '收起' : 'Close'} onClick={onClose}>
            <PeerIcon name="close" size={14} />
          </button>
        </header>
        <div className="bot-tray-list">
          {activeTasks.length === 0 ? (
            <div className="bot-tray-empty">
              {isZh ? '当前没有进行中的任务。' : 'No active tasks right now.'}
            </div>
          ) : activeTasks.map((task) => {
            const g = statusGlyph(task.status, task.followUp?.reason);
            return (
              <div
                key={task.sessionId}
                className="bot-tray-row"
                role="button"
                tabIndex={0}
                onClick={() => { onClose(); onOpenTask(task.sessionId); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClose();
                    onOpenTask(task.sessionId);
                  }
                }}
              >
                <span className="bot-tray-glyph" data-tone={g.tone} aria-hidden="true">
                  <PeerIcon name={g.icon} size={14} className={g.spin ? 'motion-spin' : undefined} />
                </span>
                <div className="bot-tray-row-main">
                  <div className="bot-tray-row-title-line">
                    <ExecutorIcon title={executorDisplayName('peer', isZh)} />
                    <span className="bot-tray-row-title">{task.title}</span>
                  </div>
                  <span className="bot-tray-row-sub">
                    {task.followUp?.reason === 'verification_failed'
                      ? i18n.t('projectAgent.chat.work.verificationFailed')
                      : (task.phaseLabel || task.status)}
                  </span>
                </div>
                <div className="bot-tray-row-right">
                  <span className="bot-tray-row-time">{formatDrawerStamp(task.updatedAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <footer className="bot-tray-footer">
          <span>{isZh ? '点击任务进入全宽工作台 · 输入草稿自动保留' : 'Click a task for full-width view · Draft preserved'}</span>
          <span>Esc</span>
        </footer>
      </section>
    );
  }

  return (
    <section
      ref={panelRef}
      className="bot-touchbar-tray"
      aria-label={isZh ? `${botName} 历史任务` : `${botName} task history`}
    >
      <header className="bot-tray-head">
        <div className="bot-tray-title-wrap">
          <span className="bot-tray-title">{isZh ? `${botName} · 历史任务` : `${botName} · Task history`}</span>
          <span className="bot-tray-sub">
            {isZh ? `共 ${totalCount} 条已收口记录` : `${totalCount} settled`}
          </span>
        </div>
        <button type="button" className="bot-tray-close" aria-label={isZh ? '收起历史任务' : 'Close history'} onClick={onClose}>
          <PeerIcon name="close" size={14} />
        </button>
      </header>
      <div className="bot-tray-controls">
        <div className="bot-tray-search">
          <PeerIcon name="search" size={13} />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isZh ? `筛选 ${botName} 的历史任务…` : `Filter ${botName} history…`}
            aria-label={isZh ? '筛选历史任务' : 'Filter task history'}
          />
        </div>
        <div className="bot-tray-segments" role="tablist" aria-label={isZh ? '按状态筛选' : 'Filter by status'}>
          {([
            ['all', isZh ? '全部' : 'All'],
            ['settled', isZh ? '已签收' : 'Done'],
            ['canceled', isZh ? '已取消' : 'Canceled'],
            ['failed', isZh ? '失败' : 'Failed'],
          ] as const).map(([val, label]) => (
            <button
              key={val}
              type="button"
              role="tab"
              aria-selected={category === val}
              className={`bot-tray-seg${category === val ? ' is-active' : ''}`}
              onClick={() => setCategory(val)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="bot-tray-list" aria-busy={loading}>
        {error ? (
          <div className="bot-tray-empty">
            <p>{isZh ? '历史任务暂时无法读取。' : 'Task history is temporarily unavailable.'}</p>
            <button type="button" className="bot-tray-retry" onClick={() => setRetrySeq(n => n + 1)}>
              {isZh ? '重试读取' : 'Retry'}
            </button>
          </div>
        ) : loading ? (
          <div className="bot-tray-empty">{isZh ? '正在读取历史任务…' : 'Loading task history…'}</div>
        ) : groupedHistory.length === 0 ? (
          <div className="bot-tray-empty">
            {debouncedQuery || category !== 'all'
              ? (isZh ? '没有找到匹配的历史任务' : 'No matching tasks')
              : (isZh ? '还没有已收口的历史任务' : 'No completed tasks yet')}
          </div>
        ) : (
          <>
            {groupedHistory.map((group) => (
              <div key={group.key} className="bot-tray-group">
                <div className="bot-tray-group-label">{group.label}</div>
                {group.items.map((row) => {
                  const g = statusGlyph(row.status, row.followUp?.reason);
                  const subtitle = row.summary || formatDrawerSessionStatus(row, i18n);
                  const title = row.title && row.title !== row.sessionId
                    ? row.title
                    : i18n.t('projectAgent.chat.work.related');
                  return (
                    <div
                      key={row.sessionId}
                      className="bot-tray-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => { onClose(); onOpenTask(row.sessionId); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onClose();
                          onOpenTask(row.sessionId);
                        }
                      }}
                    >
                      <span className="bot-tray-glyph" data-tone={g.tone} aria-hidden="true">
                        <PeerIcon name={g.icon} size={14} />
                      </span>
                      <div className="bot-tray-row-main">
                        <div className="bot-tray-row-title-line">
                          <ExecutorIcon title={executorDisplayName('peer', isZh)} />
                          <span className="bot-tray-row-title">{title}</span>
                        </div>
                        <span className="bot-tray-row-sub">{subtitle}</span>
                      </div>
                      <div className="bot-tray-row-right">
                        <button
                          type="button"
                          className="bot-tray-cite"
                          title={isZh ? '引用该任务到下方输入框' : 'Cite task in composer'}
                          onClick={(event) => {
                            event.stopPropagation();
                            onCiteTask({
                              sessionId: row.sessionId,
                              title,
                              status: row.status,
                              anchorMessageId: row.anchorMessageId || undefined,
                            });
                            onClose();
                          }}
                        >
                          <span>@ {isZh ? '引用' : 'Cite'}</span>
                        </button>
                        <span className="bot-tray-row-time">{formatDrawerStamp(row.spawnedAt)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
            {nextCursor ? (
              <button
                type="button"
                className="bot-tray-load-more"
                disabled={loadingMore}
                onClick={() => void loadMoreHistory()}
              >
                {loadingMore
                  ? (isZh ? '加载中…' : 'Loading…')
                  : (isZh ? '加载更早的历史任务' : 'Load earlier tasks')}
              </button>
            ) : null}
          </>
        )}
      </div>
      <footer className="bot-tray-footer">
        <span>{isZh ? '点击进入全宽详情 · 悬停点「@ 引用」带入当前对话' : 'Click for full view · Hover to @ cite into composer'}</span>
        <span>Esc</span>
      </footer>
    </section>
  );
}
