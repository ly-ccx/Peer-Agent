import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile } from '@peer-agent/protocol';
import { useEffect, useState, type RefObject } from 'react';
import { Drawer } from '../../app/components/Drawer';
import { clientApi } from '../../clientApi';
import {
  briefFromMemories,
  conversationModelLabel,
  DRAWER_WIDTH,
  drawerLayout,
  groupDrawerSessions,
  readDrawerSession,
  readMemoryItems,
  type DrawerMemory,
  type DrawerMemoryItem,
  type DrawerSession,
  type DrawerTab,
} from '../state/drawerState';
import { BotSettingsTab } from './BotSettingsTab';
import { MemoryTab } from './MemoryTab';
import { ObjectivesTab } from './ObjectivesTab';
import { OverviewTab } from './OverviewTab';
import { SessionDetail } from './SessionDetail';
import { TasksTab } from './TasksTab';
import '../styles/bot-drawer.css';

const TABS: readonly { id: DrawerTab; key: 'projectAgent.drawer.tab.overview' | 'projectAgent.drawer.tab.tasks' | 'projectAgent.drawer.tab.objectives' | 'projectAgent.drawer.tab.memory' | 'projectAgent.drawer.tab.settings' }[] = [
  { id: 'overview', key: 'projectAgent.drawer.tab.overview' },
  { id: 'tasks', key: 'projectAgent.drawer.tab.tasks' },
  { id: 'objectives', key: 'projectAgent.drawer.tab.objectives' },
  { id: 'memory', key: 'projectAgent.drawer.tab.memory' },
  { id: 'settings', key: 'projectAgent.drawer.tab.settings' },
];

export function BotProfileDrawer({
  workspaceId,
  profile,
  memory,
  locateSessionId,
  triggerRef,
  i18n,
  isZh,
  onMemory,
  onProfile,
  onDeleted,
}: {
  readonly workspaceId: string;
  readonly profile: BotProfile;
  readonly memory: DrawerMemory;
  readonly locateSessionId: string | null;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly i18n: I18nRuntime;
  readonly isZh: boolean;
  readonly onMemory: (memory: DrawerMemory) => void;
  readonly onProfile: (profile: BotProfile) => void;
  readonly onDeleted: () => void;
}) {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1200 : window.innerWidth));
  const [path, setPath] = useState('');
  const [sessions, setSessions] = useState<readonly DrawerSession[]>([]);
  const [memories, setMemories] = useState<readonly DrawerMemoryItem[]>([]);
  const [modelLabel, setModelLabel] = useState('');
  const [detail, setDetail] = useState<DrawerSession | null>(null);
  const layout = drawerLayout(width);
  const close = () => {
    onMemory({ ...memory, open: false });
    triggerRef.current?.focus();
  };
  const selected = sessions.find((session) => session.sessionId === memory.sessionId) ?? null;

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!memory.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || layout === 'cover') return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [layout, memory, onMemory, triggerRef]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [got, listed, preview] = await Promise.all([
        clientApi.projectAgentGet({ workspaceId }),
        clientApi.projectAgentListSessions({ workspaceId }),
        clientApi.modelRoutingPreview().catch(() => null),
      ]);
      if (cancelled) return;
      setPath(got?.ok && typeof got.path === 'string' ? got.path : '');
      const nextSessions = (listed?.sessions ?? [])
        .map((item: unknown) => readDrawerSession(item))
        .filter((item): item is DrawerSession => item !== null);
      setSessions(nextSessions);
      setMemories(readMemoryItems([]));
      setModelLabel(conversationModelLabel(preview));
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, memory.open]);

  useEffect(() => {
    if (!memory.sessionId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void clientApi.projectAgentGetSession({ sessionId: memory.sessionId, detail: 'report' }).then((result) => {
      if (cancelled) return;
      setDetail(result?.ok ? readDrawerSession(result.session) : null);
    }).catch(() => {
      if (!cancelled) setDetail(null);
    });
    return () => {
      cancelled = true;
    };
  }, [memory.sessionId]);

  if (!memory.open) return null;

  const body = (
    <div className="bot-drawer-body">
      <header className="bot-drawer-head">
        <p>{profile.displayName}</p>
        <button
          type="button"
          onClick={close}
        >
          {i18n.t('projectAgent.drawer.close')}
        </button>
      </header>
      <div className="bot-drawer-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={memory.tab === tab.id}
            onClick={() => onMemory({ ...memory, open: true, tab: tab.id })}
          >
            {i18n.t(tab.key)}
          </button>
        ))}
      </div>
      {memory.tab === 'overview' ? (
        <OverviewTab
          path={path}
          brief={briefFromMemories(memories)}
          running={groupDrawerSessions(sessions).running}
          modelLabel={modelLabel}
          i18n={i18n}
          onReveal={() => {
            if (!path) return;
            void clientApi.openPath(path, path, { mode: 'reveal', target: 'self' });
          }}
          onOpenSession={(sessionId) => onMemory({ open: true, tab: 'tasks', sessionId })}
        />
      ) : null}
      {memory.tab === 'tasks' && !(memory.sessionId && (detail || selected)) ? (
        <TasksTab
          sessions={sessions}
          selectedId={memory.sessionId}
          i18n={i18n}
          onSelect={(sessionId) => onMemory({ ...memory, open: true, tab: 'tasks', sessionId })}
        />
      ) : null}
      {memory.tab === 'tasks' && memory.sessionId && (detail || selected) ? (
        <SessionDetail
          workspaceId={workspaceId}
          workspacePath={path}
          session={(detail ?? selected)!}
          i18n={i18n}
          isZh={isZh}
          onBack={() => onMemory({ ...memory, sessionId: null })}
        />
      ) : null}
      {memory.tab === 'objectives' ? <ObjectivesTab i18n={i18n} /> : null}
      {memory.tab === 'memory' ? <MemoryTab items={memories} i18n={i18n} /> : null}
      {memory.tab === 'settings' ? (
        <BotSettingsTab
          workspaceId={workspaceId}
          profile={profile}
          modelLabel={modelLabel}
          i18n={i18n}
          onProfile={onProfile}
          onDeleted={onDeleted}
        />
      ) : null}
      {locateSessionId ? <span className="bot-drawer-sr" data-locate-session={locateSessionId} /> : null}
    </div>
  );

  if (layout === 'cover') {
    return (
      <Drawer
        onClose={close}
        ariaLabel={i18n.t('projectAgent.drawer.title')}
        panelClassName="bot-drawer-panel"
      >
        {body}
      </Drawer>
    );
  }

  return (
    <aside className="bot-drawer-dock" style={{ width: DRAWER_WIDTH }} aria-label={i18n.t('projectAgent.drawer.title')}>
      {body}
    </aside>
  );
}
