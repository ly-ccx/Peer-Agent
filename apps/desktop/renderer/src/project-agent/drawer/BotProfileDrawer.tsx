import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile } from '@peer-agent/protocol';
import { useEffect, useState, useRef, type RefObject } from 'react';
import { useFocusScope } from '../../app/hooks/useFocusScope';
import { Drawer } from '../../app/components/Drawer';
import { OVERLAY_SELECTOR } from '../../app/components/overlayStack';
import { prefersReducedMotion } from '../../app/hooks/useMotionPresence';
import { clientApi } from '../../clientApi';
import {
  drawerLayout,
  groupDrawerSessions,
  readDrawerSession,
  readMemoryItems,
  type DrawerMemory,
  type DrawerMemoryItem,
  type DrawerSession,
  type DrawerTab,
} from '../state/drawerState';
import { HistorySheet, type HistoryConversation } from '../HistorySheet';
import { AgentProcessView } from './AgentProcessView';
import type { BotModelsControlState } from '../state/useBotModels';
import { BotDrawerSegments } from './BotDrawerSegments';
import type { BotInspect } from './agentProcess';
import { BotSettingsTab } from './BotSettingsTab';
import { MemoryTab } from './MemoryTab';
import { ObjectivesTab } from './ObjectivesTab';
import { OverviewTab } from './OverviewTab';
import { ConversationSceneDrawer, SessionDetail } from './SessionDetail';
import { TasksTab, type ClassicGoalRow } from './TasksTab';
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
  modelControls,
  memory,
  locateSessionId,
  inspect = null,
  sessions,
  sessionsAvailable,
  onRefreshSessions,
  onCloseInspect,
  triggerRef,
  i18n,
  isZh,
  onMemory,
  onProfile,
  onDeleted,
  onOpenConversation,
  onOpenAutomations,
}: {
  readonly workspaceId: string;
  readonly profile: BotProfile;
  readonly modelControls: BotModelsControlState;
  readonly memory: DrawerMemory;
  readonly locateSessionId: string | null;
  readonly inspect?: BotInspect | null;
  readonly sessions: readonly DrawerSession[];
  readonly sessionsAvailable: boolean;
  readonly onRefreshSessions: () => Promise<void>;
  readonly onCloseInspect: () => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly i18n: I18nRuntime;
  readonly isZh: boolean;
  readonly onMemory: (memory: DrawerMemory) => void;
  readonly onProfile: (profile: BotProfile) => void;
  readonly onDeleted: () => void;
  readonly onOpenConversation?: (conversationId: string) => void;
  readonly onOpenAutomations?: () => void;
}) {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1200 : window.innerWidth));
  const [path, setPath] = useState('');
  const [memories, setMemories] = useState<readonly DrawerMemoryItem[]>([]);
  const modelRoute = modelControls.views.project_agent?.resolution;
  const modelLabel = modelRoute?.ok
    ? modelControls.models.find(model => model.id === modelRoute.selection.modelProviderId)?.label || modelRoute.selection.modelId : '';
  const [detail, setDetail] = useState<DrawerSession | null>(null);
  const [history, setHistory] = useState<readonly HistoryConversation[]>([]);
  const [goals, setGoals] = useState<readonly ClassicGoalRow[]>([]);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [classicScene, setClassicScene] = useState<{ conversationId: string; title: string } | null>(null);
  const layout = drawerLayout(width);
  const [dockPhase, setDockPhase] = useState<'off' | 'in' | 'on' | 'out'>(memory.open ? 'in' : 'off');
  const bodyRef = useRef<HTMLDivElement>(null);
  const previousInspect = useRef(inspect);
  useEffect(() => {
    if (previousInspect.current && !inspect && memory.open) bodyRef.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus();
    previousInspect.current = inspect;
  }, [inspect, memory.open]);
  useFocusScope(bodyRef, layout === 'push' && memory.open && dockPhase !== 'off', { restore: triggerRef });
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
    if (layout !== 'push') return undefined;
    if (memory.open) {
      if (prefersReducedMotion()) {
        setDockPhase('on');
        return undefined;
      }
      setDockPhase('in');
      const frame = requestAnimationFrame(() => setDockPhase('on'));
      return () => cancelAnimationFrame(frame);
    }
    setDockPhase((current) => (current === 'off' ? 'off' : 'out'));
    return undefined;
  }, [layout, memory.open]);

  useEffect(() => {
    if (dockPhase !== 'out') return undefined;
    if (prefersReducedMotion()) {
      setDockPhase('off');
      return undefined;
    }
    const timer = setTimeout(() => setDockPhase('off'), 360);
    return () => clearTimeout(timer);
  }, [dockPhase]);

  useEffect(() => {
    if (!memory.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || layout === 'cover') return;
      if (document.querySelector(OVERLAY_SELECTOR)) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [layout, memory, onMemory, triggerRef]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const got = await clientApi.projectAgentGet({ workspaceId });
      if (cancelled) return;
      setPath(got?.ok && typeof got.path === 'string' ? got.path : '');
      const memories = await clientApi.projectMemoryList({ workspaceId });
      if (cancelled) return;
      setMemories(readMemoryItems(memories?.items));
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, memory.open]);

  useEffect(() => {
    if (!memory.open || !path) {
      setHistory([]);
      setGoals([]);
      return undefined;
    }
    let cancelled = false;
    void clientApi.projectAgentListHistory({ workspaceId, workspacePath: path }).then((result) => {
      if (cancelled || !result?.ok) return;
      setHistory(Array.isArray(result.history) ? result.history : []);
      setGoals(Array.isArray(result.goals) ? result.goals : []);
    }).catch(() => {
      if (!cancelled) {
        setHistory([]);
        setGoals([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [memory.open, path, workspaceId]);

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

  if (layout === 'cover' ? !memory.open : dockPhase === 'off') return null;

  const body = (
    <div className="bot-drawer-body" ref={bodyRef}>
      <div className="bot-drawer-chrome">
        <header className="bot-drawer-head">
          <p>{inspect ? i18n.t(inspect.evidence ? 'projectAgent.chat.evidence' : 'projectAgent.chat.openProcess') : profile.displayName}</p>
          <button
            type="button"
            onClick={close}
          >
            {i18n.t('projectAgent.drawer.close')}
          </button>
        </header>
        {inspect ? <button className="bot-inspect-back" type="button" onClick={onCloseInspect}>{i18n.t('projectAgent.drawer.inspectBack')}</button> : <BotDrawerSegments workspaceId={workspaceId} selected={memory.tab}
          items={TABS.map(tab => ({ id: tab.id, label: i18n.t(tab.key) }))}
          onChange={tab => onMemory({ ...memory, open: true, tab, sessionId: null })} />}
      </div>
      {inspect?.evidence ? (
        <section className="bot-inspect" aria-label={i18n.t('projectAgent.chat.evidence')}>
          <h3>{i18n.t('projectAgent.chat.evidence')}</h3>
          {inspect.evidence.ok ? (
            <pre>{inspect.evidence.summary}</pre>
          ) : (
            <p>{i18n.t('projectAgent.drawer.evidenceUnavailable')}</p>
          )}
          {inspect.evidence.truncated ? <p>{i18n.t('projectAgent.process.truncated')}</p> : null}
          <details><summary>{i18n.t('projectAgent.process.technical')}</summary><code>{inspect.evidence.evidenceRef}</code>{inspect.evidence.code ? <p>{inspect.evidence.code}</p> : null}</details>
        </section>
      ) : null}
      {inspect?.rounds ? <AgentProcessView rounds={inspect.rounds} i18n={i18n} /> : null}
      {!inspect ? <div key={memory.tab} id={`bot-pane-${workspaceId}`} role="tabpanel" aria-labelledby={`bot-tab-${workspaceId}-${memory.tab}`} tabIndex={0} className="bot-drawer-pane motion-enter-fade">
      {memory.tab === 'overview' ? (
        <OverviewTab
          path={path}
          profile={profile}
          sessionsAvailable={sessionsAvailable}
          onOpenTasks={() => onMemory({ open: true, tab: 'tasks', sessionId: null })}
          brief={memories.find(item => item.kind === 'responsibility' && item.status === 'active')?.text ?? ''}
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
      {memory.tab === 'tasks' && !sessionsAvailable ? <p role="status">{i18n.t('projectAgent.chat.work.unavailableHint')}</p> : null}
      {memory.tab === 'tasks' && sessionsAvailable && !(memory.sessionId && (detail || selected)) ? (
        <TasksTab
          sessions={sessions}
          onOpenObjective={(objectiveId) => onMemory({...memory,tab:'objectives',sessionId:null,objectiveId})}
          history={history}
          goals={goals}
          onResume={async (sessionId) => {
            const result = await clientApi.projectAgentResumeSession({ workspaceId, sessionId, requestId: crypto.randomUUID() });
            if (!result.ok) throw new Error(result.code || 'resume failed');
            await onRefreshSessions();
          }}
          selectedId={memory.sessionId}
          i18n={i18n}
          onSelect={(sessionId) => onMemory({ ...memory, open: true, tab: 'tasks', sessionId })}
          onOpenHistory={setHistoryId}
          onOpenClassic={(goal) => {
            if (!goal.conversationId) return;
            onOpenConversation?.(goal.conversationId);
            setClassicScene({ conversationId: goal.conversationId, title: goal.title });
          }}
        />
      ) : null}
      {memory.tab === 'tasks' && memory.sessionId && (detail || selected) ? (
        <SessionDetail
          workspaceId={workspaceId}
          workspacePath={path}
          session={sessionsAvailable ? (selected ?? detail)! : { ...(detail ?? selected)!, status: 'unavailable', statusLabel: i18n.t('projectAgent.chat.work.unavailable') }}
          i18n={i18n}
          isZh={isZh}
          onBack={() => onMemory({ ...memory, sessionId: null })}
        />
      ) : null}
      {memory.tab === 'objectives' ? (
        <ObjectivesTab key={workspaceId} workspaceId={workspaceId} workspacePath={path} i18n={i18n} selectedId={memory.objectiveId}
          onOpenSession={(sessionId) => onMemory({...memory,tab:'tasks',sessionId})} onOpenAutomations={onOpenAutomations} />
      ) : null}
      {memory.tab === 'memory' ? (
        <MemoryTab workspaceId={workspaceId} i18n={i18n} onItems={setMemories} />
      ) : null}
      {memory.tab === 'settings' ? (
        <BotSettingsTab
          workspaceId={workspaceId}
          profile={profile}
          modelControls={modelControls}
          i18n={i18n}
          onProfile={onProfile}
          onDeleted={onDeleted}
        />
      ) : null}
      </div> : null}
      {locateSessionId ? <span className="bot-drawer-sr" data-locate-session={locateSessionId} /> : null}
      <HistorySheet
        open={historyId !== null}
        workspaceId={workspaceId}
        items={history}
        i18n={i18n}
        onClose={() => setHistoryId(null)}
        onContinued={() => setHistoryId(null)}
      />
      {classicScene ? (
        <ConversationSceneDrawer
          workspaceId={workspaceId}
          workspacePath={path}
          conversationId={classicScene.conversationId}
          title={classicScene.title}
          i18n={i18n}
          isZh={isZh}
          onClose={() => setClassicScene(null)}
        />
      ) : null}
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
    <aside
      className={`bot-drawer-dock${dockPhase === 'on' ? ' is-open' : ''}`}
      aria-label={i18n.t('projectAgent.drawer.title')}
      inert={!memory.open}
      aria-hidden={!memory.open}
    >
      {body}
    </aside>
  );
}
