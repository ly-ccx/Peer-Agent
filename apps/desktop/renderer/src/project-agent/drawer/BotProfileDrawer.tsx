import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile } from '@peer-agent/protocol';
import { useEffect, useState, useRef, type RefObject } from 'react';
import { useFocusScope } from '../../app/hooks/useFocusScope';
import { Drawer } from '../../app/components/Drawer';
import { InteractionLayerContext, useInteractionLayer } from '../../app/hooks/useInteractionLayer';
import { interactionLayers } from '../../app/components/interactionLayers';
import { useMotionAllowed } from '../../app/hooks/useMotionAllowed';
import { watchVisualMotion } from '../../app/state/visualMotion';
import { clientApi } from '../../clientApi';
import { EvidenceView } from './EvidenceView';
import { PeerIcon } from '../../ui/icons';
import {
  drawerLayout,
  groupDrawerSessions,
  readMemoryItems,
  resizeDrawer,
  type DrawerMemory,
  type DrawerMemoryItem,
  type DrawerSession,
  type DrawerTab,
} from '../state/drawerState';
import { BotDrawerResizer } from './BotDrawerResizer';
import { HistorySheet, type HistoryConversation } from '../HistorySheet';
import { AgentProcessView } from './AgentProcessView';
import type { BotModelsControlState } from '../state/useBotModels';
import { BotDrawerSegments } from './BotDrawerSegments';
import type { BotInspect } from './agentProcess';
import { BotSettingsTab } from './BotSettingsTab';
import { MemoryTab } from './MemoryTab';
import { ObjectivesTab } from './ObjectivesTab';
import { OverviewTab } from './OverviewTab';
import { mergeTaskDetail } from '../state/taskDetailState';
import { useTaskReport } from '../state/useTaskReport';
import type { TaskConversationContext, TaskConversationRequest } from '../state/taskConversationState';
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
  onReplyDetailsTarget,
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
  taskContext,
  onTaskConversation,
  replayEntrance = true,
}: {
  readonly workspaceId: string;
  readonly profile: BotProfile;
  readonly modelControls: BotModelsControlState;
  readonly memory: DrawerMemory;
  readonly locateSessionId: string | null;
  readonly inspect?: BotInspect | null;
  readonly onReplyDetailsTarget?: (node: HTMLDivElement | null) => void;
  readonly sessions: readonly DrawerSession[];
  readonly sessionsAvailable: boolean;
  readonly onRefreshSessions: () => Promise<void>;
  readonly onCloseInspect: () => void;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly i18n: I18nRuntime;
  readonly isZh: boolean;
  readonly onMemory: (memory: DrawerMemory) => void;
  readonly onProfile: (profile: BotProfile) => void;
  readonly onDeleted: () => void;
  readonly onOpenConversation?: (conversationId: string) => void;
  readonly onOpenAutomations?: () => void;
  readonly taskContext: TaskConversationContext | null;
  readonly onTaskConversation: (request: Omit<TaskConversationRequest, 'id'>) => void;
  /** False when this drawer is replacing an already-open one, so it must not play the entrance again. */
  readonly replayEntrance?: boolean;
}) {
  const motionEnabled = useMotionAllowed();
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1200 : window.innerWidth));
  const [path, setPath] = useState('');
  const [memories, setMemories] = useState<readonly DrawerMemoryItem[]>([]);
  const modelRoute = modelControls.views.project_agent?.resolution;
  const modelLabel = modelRoute?.ok
    ? modelControls.models.find(model => model.id === modelRoute.selection.modelProviderId)?.label || modelRoute.selection.modelId : '';
  const [history, setHistory] = useState<readonly HistoryConversation[]>([]);
  const [goals, setGoals] = useState<readonly ClassicGoalRow[]>([]);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [classicScene, setClassicScene] = useState<{ conversationId: string; title: string } | null>(null);
  const layout = drawerLayout(width);
  const [dockPhase, setDockPhase] = useState<'off' | 'in' | 'on' | 'out'>(
    !memory.open ? 'off' : replayEntrance ? 'in' : 'on',
  );
  // 已经展开的抽屉换一页数据时不能从宽度 0 再播一遍。入场只在真正打开时发生。
  const [dockSettled, setDockSettled] = useState(!replayEntrance && memory.open);
  const [shownTab, setShownTab] = useState(memory.tab);
  const [paneEnter, setPaneEnter] = useState(false);
  if (shownTab !== memory.tab) {
    setShownTab(memory.tab);
    setPaneEnter(!prefersReducedMotion());
  }
  const bodyRef = useRef<HTMLDivElement>(null);
  const previousInspect = useRef(inspect);
  useEffect(() => {
    if (memory.open && previousInspect.current !== inspect) {
      if (previousInspect.current?.evidence && inspect?.replyId && !inspect.evidence) {
        (bodyRef.current?.querySelector<HTMLElement>('.bot-reply-details summary, .bot-reply-details button')
          ?? bodyRef.current?.querySelector<HTMLElement>('.bot-drawer-head button'))?.focus({ preventScroll: true });
      } else if (inspect) {
        bodyRef.current?.querySelector<HTMLElement>('.bot-drawer-head button')?.focus({ preventScroll: true });
      } else if (previousInspect.current) {
        bodyRef.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus({ preventScroll: true });
      }
    }
    previousInspect.current = inspect;
  }, [inspect, memory.open]);
  const close = () => {
    // A live reply can become a durable message while the drawer is open.
    // Restore its current footer, rather than a detached streaming button.
    if (inspect?.replyId && !triggerRef.current?.isConnected) {
      const replyId = bodyRef.current?.querySelector<HTMLElement>('[data-reply-id]')?.dataset.replyId;
      if (replyId) triggerRef.current = document.querySelector<HTMLButtonElement>(`#${CSS.escape(`bot-msg-${replyId}`)} .bot-reply-context > button`);
      if (!triggerRef.current) {
        triggerRef.current = document.querySelector<HTMLElement>('.bot-thread');
        if (triggerRef.current) triggerRef.current.tabIndex = -1;
      }
    }
    onMemory({ ...memory, open: false });
  };
  const layer = useInteractionLayer(layout === 'push' && memory.open && dockPhase !== 'off', { roots: [bodyRef], trigger: triggerRef, restoreFocus: false, onClose: close });
  useFocusScope(bodyRef, layout === 'push' && memory.open && dockPhase !== 'off', {
    restore: triggerRef, ownsScope: () => Boolean(layer.current) && interactionLayers.topInteractive() === layer.current,
  });
  const selected = sessions.find((session) => session.sessionId === memory.sessionId) ?? null;
  const reportRead = useTaskReport(workspaceId, memory.sessionId, memory.open, selected?.status, sessionsAvailable,
    `${selected?.sourceRevision || ''}:${selected?.observationRevision || ''}`);
  const taskDetail = mergeTaskDetail(selected, reportRead.detail);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (layout !== 'push') {
      if (!memory.open) {
        setDockPhase('off');
        setDockSettled(false);
        return undefined;
      }
      setDockPhase('on');
      if (prefersReducedMotion()) setDockSettled(true);
      return undefined;
    }
    if (memory.open) {
      if (!motionEnabled) {
        setDockPhase('on');
        setDockSettled(true);
        return undefined;
      }
      // 首次打开先提交收起态，再经双 rAF 切到展开，否则过渡起点不会被画出来。
      // 已经展开时停在 on。思考强度保存会让父组件重绘；若这里再设成 in，
      // width/opacity 会从 0 再播一遍，整块档案闪一下。
      setDockPhase((current) => (current === 'on' ? 'on' : 'in'));
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setDockPhase('on'));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setDockPhase((current) => (current === 'off' ? 'off' : 'out'));
    setDockSettled(false);
    return undefined;
  }, [layout, memory.open, motionEnabled]);

  useEffect(() => {
    if (dockPhase !== 'on' || dockSettled) return undefined;
    // 宽度过渡是 320ms。结束后拿掉 width/opacity 过渡，避免子节点更新把入场再播一遍。
    const timer = window.setTimeout(() => setDockSettled(true), 400);
    return () => window.clearTimeout(timer);
  }, [dockPhase, dockSettled]);

  useEffect(() => {
    if (!paneEnter) return undefined;
    const timer = window.setTimeout(() => setPaneEnter(false), 280);
    return () => window.clearTimeout(timer);
  }, [paneEnter, memory.tab]);

  useEffect(() => {
    if (dockPhase !== 'out') return undefined;
    if (!motionEnabled) {
      setDockPhase('off');
      return undefined;
    }
    const motion = watchVisualMotion([], () => setDockPhase('off'), { durationMs: 360 });
    return motion.cancel;
  }, [dockPhase, motionEnabled]);


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

  if (layout === 'cover' ? !memory.open : dockPhase === 'off') return null;

  const body = (
    <div className="bot-drawer-body" ref={bodyRef}>
      <div className="bot-drawer-chrome">
        <header className="bot-drawer-head">
          <p>{inspect ? i18n.t(inspect.evidence ? 'projectAgent.evidence.title' : inspect.replyId ? 'projectAgent.chat.context.title' : 'projectAgent.chat.openProcess') : profile.displayName}</p>
          <button
            type="button"
            onClick={close}
          >
            {i18n.t('projectAgent.drawer.close')}
          </button>
        </header>
        {inspect && (inspect.evidence || !inspect.replyId) ? <button className="bot-inspect-back" type="button" onClick={onCloseInspect}>{i18n.t(inspect.replyId ? 'projectAgent.chat.context.back' : 'projectAgent.drawer.inspectBack')}</button> : !inspect ? <BotDrawerSegments workspaceId={workspaceId} selected={memory.tab}
          items={TABS.map(tab => ({ id: tab.id, label: i18n.t(tab.key) }))}
          onChange={tab => onMemory({ ...memory, open: true, tab, sessionId: null })} /> : null}
      </div>
      {inspect?.evidence ? <EvidenceView evidence={inspect.evidence} i18n={i18n} /> : null}
      {inspect?.rounds ? <AgentProcessView rounds={inspect.rounds} i18n={i18n} /> : null}
      {inspect?.replyId ? <div className="bot-reply-details-slot" hidden={Boolean(inspect.evidence)} ref={onReplyDetailsTarget} /> : null}
      {!inspect ? <div key={memory.tab} id={`bot-pane-${workspaceId}`} role="tabpanel" aria-labelledby={`bot-tab-${workspaceId}-${memory.tab}`} tabIndex={0} className={paneEnter ? 'bot-drawer-pane motion-enter-fade' : 'bot-drawer-pane'} onAnimationEnd={(event) => { if (event.target === event.currentTarget) setPaneEnter(false); }}>
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
      {memory.tab === 'tasks' && sessionsAvailable && !taskDetail ? (
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
      {memory.tab === 'tasks' && memory.sessionId && taskDetail ? (
        <SessionDetail
          onSelect={sessionId=>onMemory({...memory,open:true,tab:'tasks',sessionId})}
          workspaceId={workspaceId}
          workspacePath={path}
          session={sessionsAvailable ? taskDetail! : { ...taskDetail!, status: 'unavailable', statusLabel: i18n.t('projectAgent.chat.work.unavailable') }}
          reportState={reportRead.state}
          hasReadReport={Boolean(reportRead.detail)}
          onRetryReport={reportRead.refresh}
          i18n={i18n}
          isZh={isZh}
          botName={profile.displayName}
          context={taskContext?.sessionId === memory.sessionId ? taskContext : null}
          onBack={() => onMemory({ ...memory, sessionId: null })}
          onConversation={onTaskConversation}
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
          onOpenBot={() => { setClassicScene(null); onTaskConversation({}); }}
        />
      ) : null}
    </div>
  );

  if (layout === 'cover') {
    return (
      <Drawer
        onClose={close}
        restoreFocusRef={triggerRef}
        ariaLabel={i18n.t(inspect?.replyId ? 'projectAgent.chat.context.title' : 'projectAgent.drawer.title')}
        panelClassName={dockSettled ? 'bot-drawer-panel is-settled' : 'bot-drawer-panel'}
      >
        {body}
      </Drawer>
    );
  }

  const dockOpen = dockPhase === 'on';
  return (
    <div className={`bot-drawer-dock-frame${dockOpen ? ' is-open' : ''}`} inert={!memory.open}>
      <BotDrawerResizer
        enabled={memory.open && dockPhase === 'on'}
        width={memory.width}
        isZh={isZh}
        onResize={(next) => onMemory(resizeDrawer(memory, next))}
      />
      <aside
        className={`bot-drawer-dock${dockOpen ? ' is-open' : ''}${dockOpen && dockSettled ? ' is-settled' : ''}`}
        style={memory.width === undefined ? undefined : { ['--pa-drawer-width' as string]: `${memory.width}px` }}
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget || event.propertyName !== 'width' || dockPhase !== 'on') return;
          setDockSettled(true);
        }}
        aria-label={i18n.t(inspect?.replyId ? 'projectAgent.chat.context.title' : 'projectAgent.drawer.title')}
        inert={!memory.open}
        aria-hidden={!memory.open}
      >
        <InteractionLayerContext.Provider value={layer}>{body}</InteractionLayerContext.Provider>
      </aside>
    </div>
  );
}
