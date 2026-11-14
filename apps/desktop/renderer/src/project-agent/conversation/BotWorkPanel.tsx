import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import { isImeKey } from '../../chat/state/compositionGuard';
import { interactionLayers } from '../../app/components/interactionLayers';
import { useInteractionLayer } from '../../app/hooks/useInteractionLayer';
import { useResourceWorkspace } from '../../workbench/ResourceWorkspaceContext';
import type { BotInspect } from '../drawer/agentProcess';
import type { BotChatMessage, ConversationDisplayRow } from '../state/botConversationState';
import type { BotWorkIndex } from '../state/botWorkState';
import { BOT_WORK_PANEL_MIN_WIDTH, workPanelActivity, workPanelMaterials, workPanelNeedsUser, workPanelSessions } from '../state/botWorkPanelState';
import { replyActivityLabel } from '../state/replyActivityLabel';
import { useBotWorkPanelData } from '../state/useBotWorkPanelData';
import { taskConversationContext } from '../state/taskConversationState';
import { BotWorkSessionRow } from './BotWorkSessionRow';
import { ObligationGrantList, type ObligationGrantView, type ObligationWriterState } from './ObligationGrantCard';
import { BotWorkMaterials } from './BotWorkMaterials';
import '../styles/bot-work-panel.css';

/** A stable conversation container; panel visibility never remounts the thread or Composer. */
export function BotWorkPanel({ workspaceId, workIndex, rows, messages, recovering, headerTarget, i18n,
  onOpenTask, onInspect, onRefreshWork, obligationGrants = [], obligationError = null, obligationWriter = null, obligationSubmittingId = null,
  onObligationConfirm, onObligationReject, onObligationRetry, children }: {
  readonly workspaceId: string;
  readonly workIndex: BotWorkIndex;
  readonly rows: readonly ConversationDisplayRow[];
  readonly messages: readonly BotChatMessage[];
  readonly recovering: boolean;
  readonly headerTarget: HTMLElement | null;
  readonly i18n: I18nRuntime;
  readonly onOpenTask: (id: string) => void;
  readonly onInspect?: (inspect: BotInspect) => void;
  readonly onRefreshWork: () => Promise<void>;
  readonly obligationGrants?: readonly ObligationGrantView[];
  readonly obligationError?: string | null;
  readonly obligationWriter?: ObligationWriterState | null;
  readonly obligationSubmittingId?: string | null;
  readonly onObligationConfirm?: (grantId: string) => void;
  readonly onObligationReject?: (grantId: string) => void;
  readonly onObligationRetry?: () => void;
  readonly children: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const allMaterialsButton = useRef<HTMLButtonElement>(null);
  const explicitFocus = useRef(false);
  const viewFocus = useRef(false);
  const [wide, setWide] = useState(false);
  const [choices, setChoices] = useState<{ wide?: boolean; compact?: boolean }>({});
  const [view, setView] = useState<'overview' | 'materials'>('overview');
  const [taskLimit, setTaskLimit] = useState(4);
  const [agentLimit, setAgentLimit] = useState(4);
  const open = choices[wide ? 'wide' : 'compact'] ?? wide;
  const close = () => {
    if (panel.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    setChoices(current => ({ ...current, [wide ? 'wide' : 'compact']: false }));
  };
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const fontScale = (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;
      const next = element.clientWidth >= BOT_WORK_PANEL_MIN_WIDTH * fontScale;
      // Only rescue focus from content that is actually about to become hidden.
      if (!next && choices.compact !== true && panel.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
      setWide(next);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [choices.compact]);
  useLayoutEffect(() => {
    if (open && explicitFocus.current) { explicitFocus.current = false; closeButton.current?.focus({ preventScroll: true }); }
  }, [open]);
  useLayoutEffect(() => {
    if (!viewFocus.current) return;
    viewFocus.current = false;
    (view === 'materials' ? backButton : allMaterialsButton).current?.focus({ preventScroll: true });
  }, [view]);
  useInteractionLayer(open && !wide, { roots: [panel], trigger, modal: false, outside: true, onClose: close });
  const resources = useResourceWorkspace();
  const workspacePath = resources?.owner?.workspaceId === workspaceId && resources.ready ? resources.owner.path : null;
  const data = useBotWorkPanelData(workspaceId, workspacePath, open);
  const activity = recovering ? undefined : workPanelActivity(rows);
  const focusLabel = replyActivityLabel(activity, i18n);
  const publicUpdate = activity?.segments.filter(segment => segment.kind === 'text').at(-1)?.text;
  const references = activity?.resourceReferences;
  const materials = useMemo(() => workPanelMaterials(workspaceId, workIndex, data.items, messages, { resourceReferences: references }),
    [workspaceId, workIndex, data.items, messages, references]);
  const sessions = useMemo(() => workPanelSessions(workIndex), [workIndex]);
  const questions = useMemo(() => new Map(sessions.agents.filter(workPanelNeedsUser).map(session => [session.sessionId,
    taskConversationContext(workspaceId, session.sessionId, messages, workIndex)?.question?.content])),
    [workspaceId, sessions.agents, messages, workIndex]);
  const byPlan = useMemo(() => new Map(data.items.map(item => [item.taskId, item])), [data.items]);
  const blockers = sessions.agents.filter(session => workPanelNeedsUser(session)
    || ['technical_block', 'local_persistence_failed'].includes(session.followUp?.reason || '') || session.followUp?.reason === 'verification_failed').length;
  const needsYou = sessions.agents.some(workPanelNeedsUser) || obligationGrants.length > 0;
  const setMaterialsView = (next: 'overview' | 'materials') => {
    viewFocus.current = true;
    setView(next);
  };
  const toggle = <button ref={trigger} type="button" className="bot-profile is-icon bot-work-panel-toggle"
    aria-label={[i18n.t(open ? 'projectAgent.workPanel.close' : 'projectAgent.workPanel.open'), needsYou ? i18n.t('projectAgent.workPanel.needsYou') : null].filter(Boolean).join(', ')}
    title={i18n.t(open ? 'projectAgent.workPanel.close' : 'projectAgent.workPanel.open')}
    aria-expanded={open} aria-controls={id} data-needs-user={needsYou} onClick={() => {
      if (open) close();
      else { explicitFocus.current = true; setChoices(current => ({ ...current, [wide ? 'wide' : 'compact']: true })); }
    }} data-obligation-count={obligationGrants.length}><PeerIcon name="blocks" size={16} />{needsYou ? <span className="bot-work-panel-notice" aria-hidden="true" /> : null}
  </button>;
  return <div ref={root} className="bot-work-layout" data-work-panel-open={open} data-work-panel-wide={wide}
    style={{ '--bot-work-panel-min-width': `${BOT_WORK_PANEL_MIN_WIDTH / 16}rem` } as CSSProperties}>
    {headerTarget ? createPortal(toggle, headerTarget) : <div className="bot-work-panel-local-trigger">{toggle}</div>}
    <div className="bot-work-primary">{children}</div>
    <div className="bot-work-panel-space motion-inline-space" aria-hidden="true" />
    <aside ref={panel} id={id} inert={!open} aria-hidden={!open} data-motion-open={open}
      className="bot-work-panel motion-inline-panel" aria-labelledby={`${id}-title`} onKeyDown={event => {
      if (wide && event.key === 'Escape' && !event.defaultPrevented && !isImeKey(event.nativeEvent)
        && !interactionLayers.topInteractive() && panel.current?.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <header className="bot-work-panel-head"><h2 id={`${id}-title`}><PeerIcon name="blocks" size={16} />{i18n.t('projectAgent.workPanel.title')}</h2>
        <button ref={closeButton} type="button" className="ui-button is-icon" aria-label={i18n.t('projectAgent.workPanel.close')} onClick={close}><PeerIcon name="panelRight" size={16} /></button>
      </header>
      <ObligationGrantList variant="panel" grants={obligationGrants} error={obligationError} writer={obligationWriter} submittingId={obligationSubmittingId}
        i18n={i18n} onConfirm={onObligationConfirm || (() => {})} onReject={onObligationReject || (() => {})} onRetry={onObligationRetry || (() => {})} />
      <div className="bot-work-panel-scroll motion-enter-fade" hidden={view !== 'overview'}>
        <section className="bot-work-panel-attention" aria-label={i18n.t('projectAgent.workPanel.attention')}>
          <h3><PeerIcon name="circle" size={13} />{i18n.t('projectAgent.workPanel.attention')}</h3>
          <p className="bot-work-panel-focus">{recovering ? i18n.t('projectAgent.workPanel.recovering') : focusLabel ?? i18n.t('projectAgent.workPanel.quiet')}</p>
          {activity && onInspect ? <button type="button" className="bot-work-panel-focus-source" onClick={() => onInspect({ replyId: activity.turnId, evidence: null, rounds: null })}>
            <span>{publicUpdate || i18n.t('projectAgent.process.heading')}</span><PeerIcon name="arrowUpRight" size={13} /></button>
            : <p className="bot-work-panel-note">{i18n.t('projectAgent.workPanel.quietHint')}</p>}
        </section>
        {!workIndex.available ? <div className="bot-work-panel-feedback" role="status"><p>{i18n.t('projectAgent.workPanel.unavailable')}</p>
          <button type="button" className="ui-button is-compact" onClick={() => { void onRefreshWork(); }}>{i18n.t('resources.retryRead')}</button></div> : <>
          <section className="bot-work-panel-section" aria-labelledby={`${id}-tasks`}>
            <header><h3 id={`${id}-tasks`}>{i18n.t('projectAgent.workPanel.tasks')}<span>{sessions.tasks.length}</span></h3></header>
            {sessions.tasks.length ? sessions.tasks.slice(0, taskLimit).map(session => <BotWorkSessionRow key={session.sessionId} session={session}
              question={questions.get(session.sessionId)} overview={data.error ? undefined : byPlan.get(session.planId ?? '')} variant="task" i18n={i18n} onOpen={onOpenTask} />)
              : <p className="bot-work-panel-empty">{i18n.t('projectAgent.workPanel.emptyTasks')}</p>}
            {sessions.tasks.length > taskLimit ? <button type="button" className="bot-work-panel-text-button" onClick={() => setTaskLimit(value => value + 10)}>{i18n.t('projectAgent.workPanel.showMore')}</button> : null}
            {workIndex.byId.size >= 50 ? <p className="bot-work-panel-note">{i18n.t('projectAgent.workPanel.recentTasks')}</p> : null}
          </section>
          <section className="bot-work-panel-section" aria-labelledby={`${id}-agents`}>
            <header><h3 id={`${id}-agents`}>{i18n.t('projectAgent.workPanel.agents')}<span>{sessions.agents.length}</span></h3>
              {blockers ? <span className="bot-work-panel-section-meta">{i18n.t('projectAgent.workPanel.blockers', { count: blockers })}</span> : null}</header>
            {sessions.agents.length ? sessions.agents.slice(0, agentLimit).map(session => <BotWorkSessionRow key={session.sessionId} session={session}
              question={questions.get(session.sessionId)} parent={workIndex.byId.get(session.parentSessionId ?? '')}
              overview={data.error ? undefined : byPlan.get(session.planId ?? '')} variant="agent" i18n={i18n} onOpen={onOpenTask} />)
              : <p className="bot-work-panel-empty">{i18n.t('projectAgent.workPanel.emptyAgents')}</p>}
            {sessions.agents.length > agentLimit ? <button type="button" className="bot-work-panel-text-button" onClick={() => setAgentLimit(value => value + 10)}>{i18n.t('projectAgent.workPanel.showMore')}</button> : null}
          </section>
        </>}
        <section className="bot-work-panel-section" aria-labelledby={`${id}-materials`}>
          <header><h3 id={`${id}-materials`}>{i18n.t('projectAgent.workPanel.materials')}<span>{materials.length}</span></h3>
            <button ref={allMaterialsButton} type="button" className="bot-work-panel-text-button" onClick={() => setMaterialsView('materials')}>{i18n.t('projectAgent.workPanel.allMaterials')}<PeerIcon name="chevronRight" size={12} /></button></header>
          <MaterialReadFeedback data={data} workspacePath={workspacePath} i18n={i18n} />
          <BotWorkMaterials materials={materials.slice(0, 3)} i18n={i18n} onOpenTask={onOpenTask} />
          {!materials.length && data.loaded && !data.error ? <p className="bot-work-panel-empty">{i18n.t('projectAgent.workPanel.emptyMaterials')}</p> : null}
        </section>
      </div>
      <div className="bot-work-panel-scroll motion-enter-fade" hidden={view !== 'materials'}>
        <button ref={backButton} type="button" className="bot-work-panel-back" onClick={() => setMaterialsView('overview')}><PeerIcon name="back" size={14} />{i18n.t('projectAgent.workPanel.back')}</button>
        <p className="bot-work-panel-note">{i18n.t('projectAgent.workPanel.materialScope')}</p>
        <button type="button" className="ui-button is-compact" disabled={!resources?.ready} onClick={() => resources?.openReference({ workspaceId, path: '.', kind: 'directory' })}>
          <PeerIcon name="folder" size={14} />{i18n.t('projectAgent.workPanel.browseFiles')}</button>
        <MaterialReadFeedback data={data} workspacePath={workspacePath} i18n={i18n} />
        <BotWorkMaterials materials={materials} i18n={i18n} onOpenTask={onOpenTask} />
        {!materials.length && data.loaded && !data.error ? <p className="bot-work-panel-empty">{i18n.t('projectAgent.workPanel.emptyMaterials')}</p> : null}
        {data.loaded ? <><p className="bot-work-panel-note">{i18n.t('projectAgent.workPanel.materialWindow', { limit: data.windowLimit })}</p>
          <button type="button" className="ui-button is-compact" disabled={data.loading} onClick={data.loadMore}>{i18n.t('projectAgent.workPanel.loadMore')}</button></> : null}
      </div>
    </aside>
  </div>;
}

function MaterialReadFeedback({ data, workspacePath, i18n }: {
  readonly data: ReturnType<typeof useBotWorkPanelData>;
  readonly workspacePath: string | null;
  readonly i18n: I18nRuntime;
}) {
  if (!workspacePath) return <p className="bot-work-panel-note" role="status">{i18n.t('projectAgent.workPanel.scopeUnavailable')}</p>;
  if (data.error) return <div className="bot-work-panel-feedback" role="status"><p>{i18n.t('resources.readFailed')}</p>
    <button type="button" className="ui-button is-compact" disabled={data.loading} onClick={data.reload}>{i18n.t('resources.retryRead')}</button></div>;
  if (!data.loaded && data.loading) return <p className="bot-work-panel-note bot-reading-shimmer" role="status">{i18n.t('resources.loading')}</p>;
  return null;
}
