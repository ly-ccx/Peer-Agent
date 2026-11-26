import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { isImeKey } from '../../chat/state/compositionGuard';
import { interactionLayers } from '../../app/components/interactionLayers';
import { useInteractionLayer } from '../../app/hooks/useInteractionLayer';
import { useResourceWorkspace } from '../../workbench/ResourceWorkspaceContext';
import type { BotChatMessage, ConversationDisplayRow } from '../state/botConversationState';
import type { BotWorkIndex } from '../state/botWorkState';
import { BOT_WORK_PANEL_MIN_WIDTH, workPanelActivity, workPanelCards, workPanelGroups, workPanelMaterials, workPanelMaterialSections,
  type WorkPanelCard, type WorkPanelGroup, type WorkPanelLane, type WorkPanelNode } from '../state/botWorkPanelState';
import { useBotWorkPanelData } from '../state/useBotWorkPanelData';
import { useBotWorkPanelObjectives } from '../state/useBotWorkPanelObjectives';
import { BotWorkSessionRow } from './BotWorkSessionRow';
import type { ObligationGrantView } from './ObligationGrantCard';
import { BotWorkMaterials } from './BotWorkMaterials';
import '../styles/bot-work-panel.css';

interface BoardActions {
  readonly onOpenTask: (id: string) => void;
  readonly onOpenBlocker: (id: string) => void;
  readonly onOpenCard: (card: WorkPanelCard) => void;
  readonly onOpenGrant: (id: string) => void;
  readonly onOpenObjective: (id: string) => void;
}

/** A stable conversation container; panel visibility never remounts the thread or Composer. */
export function BotWorkPanel({ workspaceId, workIndex, rows, messages, recovering, headerTarget, i18n, botName, avatar,
  onOpenSettings, onOpenHistory, onRefreshWork, obligationGrants, children, ...actions }: BoardActions & {
  readonly workspaceId: string;
  readonly workIndex: BotWorkIndex;
  readonly rows: readonly ConversationDisplayRow[];
  readonly messages: readonly BotChatMessage[];
  readonly recovering: boolean;
  readonly headerTarget: HTMLElement | null;
  readonly i18n: I18nRuntime;
  readonly botName: string;
  readonly avatar: ReactNode;
  readonly onOpenSettings: () => void;
  readonly onOpenHistory: () => void;
  readonly onRefreshWork: () => Promise<void>;
  readonly obligationGrants: readonly ObligationGrantView[];
  readonly children: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const explicitFocus = useRef(false);
  const [wide, setWide] = useState(false);
  const [choices, setChoices] = useState<{ wide?: boolean; compact?: boolean }>({});
  const open = choices[wide ? 'wide' : 'compact'] ?? wide;
  const close = () => {
    if (panel.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    setChoices(current => ({ ...current, [wide ? 'wide' : 'compact']: false }));
  };
  const leave = (action: () => void) => {
    if (!wide) close();
    action();
  };
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth === 0) return;
      const fontScale = (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;
      const next = element.clientWidth >= BOT_WORK_PANEL_MIN_WIDTH * fontScale;
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
  useInteractionLayer(open && !wide, { roots: [panel], trigger, modal: false, outside: true, onClose: close });
  const resources = useResourceWorkspace();
  const workspacePath = resources?.owner?.workspaceId === workspaceId && resources.ready ? resources.owner.path : null;
  const data = useBotWorkPanelData(workspaceId, workspacePath, open);
  const objectives = useBotWorkPanelObjectives(workspaceId, open);
  const references = recovering ? undefined : workPanelActivity(rows)?.resourceReferences;
  const materials = useMemo(() => workPanelMaterialSections(workPanelMaterials(workspaceId, workIndex, data.items, messages,
    { resourceReferences: references })), [workspaceId, workIndex, data.items, messages, references]);
  const cards = useMemo(() => workPanelCards(messages), [messages]);
  const groups = useMemo(() => workPanelGroups(workIndex, objectives.items, obligationGrants, cards),
    [workIndex, objectives.items, obligationGrants, cards]);
  const byPlan = useMemo(() => new Map(data.items.map(item => [item.taskId, item])), [data.items]);
  const needsYou = groups[0]?.lane === 'needsYou';
  const toggle = <button ref={trigger} type="button" className="bot-profile is-icon bot-work-panel-toggle"
    aria-label={[i18n.t(open ? 'projectAgent.workPanel.close' : 'projectAgent.workPanel.open'), needsYou ? i18n.t('projectAgent.workPanel.needsYou') : null].filter(Boolean).join(', ')}
    title={i18n.t(open ? 'projectAgent.workPanel.close' : 'projectAgent.workPanel.open')}
    aria-expanded={open} aria-controls={id} data-needs-user={needsYou} onClick={() => {
      if (open) close();
      else { explicitFocus.current = true; setChoices(current => ({ ...current, [wide ? 'wide' : 'compact']: true })); }
    }}><PeerIcon name="blocks" size={16} />{needsYou ? <span className="bot-work-panel-notice" aria-hidden="true" /> : null}</button>;
  return <div ref={root} className="bot-work-layout" data-work-panel-open={open} data-work-panel-wide={wide}
    style={{ '--bot-work-panel-min-width': `${BOT_WORK_PANEL_MIN_WIDTH / 16}rem` } as CSSProperties}>
    {headerTarget ? createPortal(toggle, headerTarget) : <div className="bot-work-panel-local-trigger">{toggle}</div>}
    <div className="bot-work-primary">{children}</div>
    <div className="bot-work-panel-space motion-inline-space" aria-hidden="true" />
    <aside ref={panel} id={id} inert={!open} aria-hidden={!open} data-motion-open={open}
      className="bot-work-panel motion-inline-panel" aria-label={i18n.t('projectAgent.workPanel.title')} onKeyDown={event => {
        if (wide && event.key === 'Escape' && !event.defaultPrevented && !isImeKey(event.nativeEvent)
          && !interactionLayers.topInteractive() && panel.current?.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      <header className="bot-work-panel-head">
        <div className="bot-work-panel-identity">
          <span className="bot-work-panel-avatar" aria-hidden="true">{avatar}</span>
          <div><h2 title={botName}>{botName}</h2>
            {workspacePath ? <p title={workspacePath}>{workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || workspacePath}</p> : null}</div>
        </div>
        <div className="bot-work-panel-actions">
          <button type="button" className="ui-button is-icon" aria-label={i18n.t('projectAgent.workPanel.manage')}
            title={i18n.t('projectAgent.workPanel.manage')} onClick={() => leave(onOpenSettings)}><PeerIcon name="settings" size={16} /></button>
          <button ref={closeButton} type="button" className="ui-button is-icon" aria-label={i18n.t('projectAgent.workPanel.close')}
            title={i18n.t('projectAgent.workPanel.close')} onClick={close}><PeerIcon name="panelRight" size={16} /></button>
        </div>
      </header>
      <div className="bot-work-panel-scroll">
        {!workIndex.available ? <ReadFailure message={i18n.t('projectAgent.workPanel.unavailable')} retry={() => void onRefreshWork()} i18n={i18n} /> : null}
        <BotWorkMatterList id={id} groups={groups} byPlan={byPlan} i18n={i18n} showEmpty={workIndex.available && !objectives.loading && !objectives.error}
          actions={{ onOpenTask: value => leave(() => actions.onOpenTask(value)), onOpenBlocker: value => leave(() => actions.onOpenBlocker(value)),
            onOpenCard: card => leave(() => actions.onOpenCard(card)), onOpenGrant: value => leave(() => actions.onOpenGrant(value)),
            onOpenObjective: value => leave(() => actions.onOpenObjective(value)) }} />
        {objectives.error ? <ReadFailure message={i18n.t('projectAgent.workPanel.objectivesUnavailable')} retry={objectives.reload} i18n={i18n} /> : null}
        {!groups.length && objectives.loading ? <p className="bot-work-panel-note bot-reading-shimmer" role="status">{i18n.t('resources.loading')}</p> : null}
        <button type="button" className="ui-button is-compact bot-work-panel-history" onClick={() => leave(onOpenHistory)}>
          <PeerIcon name="history" size={14} />{i18n.t('projectAgent.workPanel.history')}</button>
        {workspacePath || groups.length || materials.outputs.length || materials.references.length ? <div className="bot-work-panel-foundation">
          <details><summary>{i18n.t('projectAgent.workPanel.outputs')} <span>{materials.outputs.length}</span></summary>
            {data.error ? <ReadFailure message={i18n.t(workspacePath ? 'resources.readFailed' : 'projectAgent.workPanel.scopeUnavailable')}
              retry={workspacePath ? data.reload : undefined} i18n={i18n} /> : null}
            {!data.loaded && data.loading ? <p className="bot-work-panel-note bot-reading-shimmer" role="status">{i18n.t('resources.loading')}</p> : null}
            {workspacePath ? <button type="button" className="ui-button is-compact" onClick={() => leave(() =>
              resources?.openComparison({ workspaceId, path: '.', kind: 'directory' }, { fromRef: 'HEAD', comparison: 'working' }))}>
              {i18n.t('projectAgent.workPanel.projectChanges')}</button> : null}
            <BotWorkMaterials materials={materials.outputs} i18n={i18n} onOpenTask={value => leave(() => actions.onOpenTask(value))} />
            {!materials.outputs.length && data.loaded && !data.error ? <p className="bot-work-panel-note">{i18n.t('projectAgent.workPanel.emptyOutputs')}</p> : null}
            {data.loaded ? <button type="button" className="ui-button is-compact" disabled={data.loading} onClick={data.loadMore}>
              {i18n.t('projectAgent.workPanel.loadMore')}</button> : null}
          </details>
          <details><summary>{i18n.t('projectAgent.workPanel.references')} <span>{materials.references.length}</span></summary>
            <BotWorkMaterials materials={materials.references} i18n={i18n} onOpenTask={actions.onOpenTask} />
            {!materials.references.length ? <p className="bot-work-panel-note">{i18n.t('projectAgent.workPanel.emptyReferences')}</p> : null}
          </details>
        </div> : null}
      </div>
    </aside>
  </div>;
}

export function BotWorkMatterList({ id, groups, byPlan, showEmpty, i18n, actions }: {
  readonly id: string;
  readonly groups: readonly WorkPanelGroup[];
  readonly byPlan: ReadonlyMap<string, TaskOverviewItem>;
  readonly showEmpty: boolean;
  readonly i18n: I18nRuntime;
  readonly actions: BoardActions;
}) {
  if (!groups.length) return showEmpty ? <div className="bot-work-panel-empty-state">
    <h3>{i18n.t('projectAgent.workPanel.empty')}</h3><p>{i18n.t('projectAgent.workPanel.emptyHint')}</p>
  </div> : null;
  return <div className="bot-work-panel-matters">{groups.map(group => <section key={group.lane}
    className="bot-work-panel-section" data-lane={group.lane} aria-labelledby={`${id}-${group.lane}`}>
    <header><h3 id={`${id}-${group.lane}`}>{i18n.t(`projectAgent.workPanel.${group.lane}`)} <span>{group.count}</span></h3></header>
    <MatterTree nodes={group.roots} lane={group.lane} {...{ i18n, byPlan, actions }} />
  </section>)}</div>;
}

function MatterTree({ nodes, lane, i18n, byPlan, actions }: {
  readonly nodes: readonly WorkPanelNode[];
  readonly lane: WorkPanelLane;
  readonly i18n: I18nRuntime;
  readonly byPlan: ReadonlyMap<string, TaskOverviewItem>;
  readonly actions: BoardActions;
}) {
  return <ul className="bot-work-panel-tree">{nodes.map(node => <li key={node.id}>
    {node.kind === 'session' ? <>
      <BotWorkSessionRow session={node.session} parent={node.parent} overview={byPlan.get(node.session.planId ?? '')}
        variant={node.parent ? 'agent' : 'task'} lane={lane} question={node.cards[0]?.content} i18n={i18n}
        onOpen={node.cards[0] ? () => actions.onOpenCard(node.cards[0]) : lane === 'needsYou' ? actions.onOpenBlocker : actions.onOpenTask} />
      {node.cards.slice(1).map(card => <CardLink key={card.id} card={card} i18n={i18n} onOpen={actions.onOpenCard} />)}
    </> : node.kind === 'card' ? <CardLink card={node.card} i18n={i18n} onOpen={actions.onOpenCard} />
      : node.kind === 'grant' ? <button type="button" className="bot-work-panel-link" onClick={() => actions.onOpenGrant(node.grant.grantId)}>
        <PeerIcon name="info" size={14} />{i18n.t('projectAgent.workPanel.obligationEntry', { count: node.grant.items.length })}
      </button> : <button type="button" className="bot-work-panel-link" onClick={() => actions.onOpenObjective(node.objective.objectiveId)}>
        <PeerIcon name="circle" size={14} /><span><strong>{node.objective.title}</strong><small>{i18n.t('projectAgent.workPanel.objective')}</small></span>
      </button>}
    {node.children.length ? <MatterTree nodes={node.children} {...{ lane, i18n, byPlan, actions }} /> : null}
  </li>)}</ul>;
}

function CardLink({ card, onOpen, i18n }: { readonly card: WorkPanelCard; readonly onOpen: BoardActions['onOpenCard']; readonly i18n: I18nRuntime }) {
  return <button type="button" className="bot-work-panel-link" onClick={() => onOpen(card)}>
    <PeerIcon name="info" size={14} /><span><strong>{i18n.t(card.kind === 'approval' ? 'projectAgent.attention.approval' : 'projectAgent.attention.question')}</strong>
      {card.content ? <small>{card.content}</small> : null}</span>
  </button>;
}

function ReadFailure({ message, retry, i18n }: { message: string; retry?: () => void; i18n: I18nRuntime }) {
  return <div className="bot-work-panel-feedback" role="status"><p>{message}</p>
    {retry ? <button type="button" className="ui-button is-compact" onClick={retry}>{i18n.t('resources.retryRead')}</button> : null}
  </div>;
}
