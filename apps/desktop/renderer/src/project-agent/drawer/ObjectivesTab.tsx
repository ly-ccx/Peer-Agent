import { MotionDetails } from '../../app/components/MotionDetails';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { ObjectiveAutonomy, ProjectObjectiveView, ProjectObjectiveUpdateRequest } from '@peer-agent/protocol';
import { scheduleLabel } from '../../automations/automationPresentation';
import {objectiveWatchReasonKey} from './objectiveWatchStatus';
import { ResourceEditor } from '../../ui/resources/ResourceEditor';
import { ResourceFeedback } from '../../ui/resources/ResourceFeedback';
import { useResourceActions, useResourceRead } from '../../ui/resources/useResourceState';
import { EvidencePreview } from './EvidencePreview';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import {Switch} from '../../ui/boolean-controls/Switch';
import { Dropdown } from '../../app/components/Dropdown';

interface LegacyAutomation { readonly definition?: { readonly automationId?: string; readonly name?: string; readonly workspacePath?: string; }; }

interface ObjectivesTabProps {
  readonly workspaceId: string; readonly workspacePath: string; readonly i18n: I18nRuntime;
  readonly selectedId?: string; readonly onOpenSession?: (sessionId: string) => void; readonly onOpenAutomations?: () => void;
}
export function ObjectivesTab(props: ObjectivesTabProps) { return <ObjectivesScope key={props.workspaceId} {...props} />; }
function ObjectivesScope({ workspaceId, workspacePath, i18n, selectedId, onOpenSession, onOpenAutomations }: ObjectivesTabProps) {
  const resource = useResourceRead(workspaceId, async () => {
    const result = await clientApi.projectObjectivesList({ workspaceId });
    if (!result.ok || !result.items) throw Error(result.code || 'READ_FAILED');
    return result.items;
  });
  const legacy = useResourceRead(workspacePath, async () => {
    const rows = await clientApi.automationsList();
    return (rows as readonly LegacyAutomation[]).filter(item => item.definition?.workspacePath === workspacePath);
  });
  const items = legacy.value ?? [], objectives = resource.value ?? [];
  useEffect(() => clientApi.onProjectAgentChanged(event => {
    if (event.workspaceIds?.includes(workspaceId)) void resource.reload();
  }), [workspaceId, resource.reload]);
  const located = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selectedId) { located.current = undefined; return; }
    if (located.current === selectedId) return;
    const target = document.getElementById(`objective-${selectedId}`);
    if (target) { located.current = selectedId; target.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
  }, [selectedId, objectives]);
  return <div className="bot-drawer-tab bot-objectives-tab">
    <ResourceFeedback i18n={i18n} loading={resource.loading && !resource.loaded} error={resource.error} onReload={resource.reload} />
    {resource.loaded && !resource.error && !objectives.length && <div className="bot-objectives-intro">
      <span className="bot-objectives-icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="16" cy="16" r="11"/><circle cx="16" cy="16" r="6"/><circle cx="16" cy="16" r="1.5"/></svg></span>
      <div className="bot-objectives-copy"><h2>{i18n.t('projectAgent.drawer.objective.empty')}</h2><p>{i18n.t('projectAgent.drawer.objective.hint')}</p></div>
    </div>}
    {objectives.map(item => <ObjectiveCard key={item.objectiveId} item={item} workspaceId={workspaceId} i18n={i18n}
      selected={selectedId === item.objectiveId} locked={!resource.loaded || resource.error} reload={resource.reload} onOpenSession={onOpenSession} />)}
    <ResourceFeedback i18n={i18n} loading={legacy.loading && !legacy.loaded} error={legacy.error} onReload={legacy.reload} />
      {items.length > 0 && (
        <section className="bot-tasks-section">
          <div className="bot-tasks-heading">
            <h2>{i18n.t('projectAgent.drawer.legacyAutomations')}</h2>
            <span>{items.length}</span>
          </div>
          <ul className="bot-tasks-list">
            {items.map((item) => {
              const id = item.definition?.automationId || item.definition?.name || '';
              return (
                <li key={id}>
                  <button type="button" className="bot-task-row" disabled={!onOpenAutomations} onClick={() => onOpenAutomations?.()}>
                    <span className="bot-task-row-copy">
                      <span className="bot-task-row-title" title={item.definition?.name || id}>{item.definition?.name || id}</span>
                    </span>
                    <PeerIcon name="chevronRight" size={14} className="bot-task-row-arrow" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
  </div>;
}


function ObjectiveCard({ item, workspaceId, i18n, selected, locked: readLocked, reload, onOpenSession }: {
  readonly item: ProjectObjectiveView; readonly workspaceId: string; readonly i18n: I18nRuntime;
  readonly selected: boolean; readonly locked: boolean; readonly reload: () => Promise<boolean>;
  readonly onOpenSession?: (sessionId: string) => void;
}) {
  const actions = useResourceActions(`${workspaceId}:${item.objectiveId}`);
  const [editing, setEditing] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const action = actions.get('command');
  const locked = readLocked || action.pending;
  const closed = item.status === 'achieved' || item.status === 'abandoned';
  const t = (key: 'active'|'paused'|'achieved'|'abandoned'|'report_only'|'propose'|'act') => i18n.t(`projectAgent.drawer.objective.${key}`);
  const restoreEditorFocus = useRef(false);
  const closeEditor = () => { restoreEditorFocus.current = true; setEditing(false); };
  useLayoutEffect(() => { if (!editing && restoreEditorFocus.current) { restoreEditorFocus.current = false; trigger.current?.focus({ preventScroll: true }); } }, [editing]);
  async function command(method: 'pause'|'resume'|'delete'|'update', patch?: ProjectObjectiveUpdateRequest['patch']) {
    const request = { workspaceId, objectiveId: item.objectiveId, requestId: crypto.randomUUID() };
    const confirmed = await actions.run('command', async () => {
      const result = method === 'update' ? await clientApi.projectObjectivesUpdate({ ...request, patch: patch ?? {}, expectedVersion: item.version })
        : method === 'pause' ? await clientApi.projectObjectivesPause(request) : method === 'resume' ? await clientApi.projectObjectivesResume(request) : await clientApi.projectObjectivesDelete(request);
      if (!result.ok) throw Error(result.code);
    });
    if (confirmed) void reload();
  }
      const sessionIds=[...new Set(item.milestones.flatMap(m=>m.sessionIds))];
      const next=item.watches.map(w=>w.nextRunAt).filter((at):at is string=>!!at).sort()[0];
      return <section id={`objective-${item.objectiveId}`} key={item.objectiveId} className={`bot-objective${selected?' is-selected':''}`}>
        <header><h2>{item.title}</h2><span className="bot-objective-status">{item.pendingConfirmation?i18n.t('projectAgent.drawer.objective.pending'):t(item.status)}</span></header>
        {editing?<div className="bot-objective-edit">
          <ResourceEditor identity={`objective:${workspaceId}:${item.objectiveId}`} initial={{ title: item.title, outcome: item.outcome, _version: String(item.version) }} i18n={i18n}
            fields={[{ key: 'title', label: i18n.t('projectAgent.drawer.objective.title'), maxLength: 120 }, { key: 'outcome', label: i18n.t('projectAgent.drawer.objective.outcome'), multiline: true, maxLength: 2000 }]}
            read={async () => {
              const result = await clientApi.projectObjectivesList({ workspaceId });
              const current = result.items?.find(row => row.objectiveId === item.objectiveId);
              if (!result.ok || !current) throw Error('OBJECTIVE_UNAVAILABLE');
              return { title: current.title, outcome: current.outcome, _version: String(current.version) };
            }}
            write={async (draft, saved) => {
              const result = await clientApi.projectObjectivesUpdate({ workspaceId, objectiveId: item.objectiveId, requestId: crypto.randomUUID(), expectedVersion: Number(saved._version), patch: { title: draft.title, outcome: draft.outcome } });
              if (!result.ok || !result.item) throw Error(result.code);
              void reload(); return { title: result.item.title, outcome: result.item.outcome, _version: String(result.item.version) };
            }} onClose={closeEditor} />
        </div>:<p className="bot-objective-outcome">{item.outcome}</p>}
        <dl className="bot-objective-facts">
          <div><dt>{i18n.t('projectAgent.drawer.objective.last')}</dt><dd>{item.lastObservation?new Date(item.lastObservation.observedAt).toLocaleString(i18n.locale):i18n.t('projectAgent.drawer.objective.unchecked')}</dd></div>
          <div><dt>{i18n.t('projectAgent.drawer.objective.next')}</dt><dd>{next?new Date(next).toLocaleString(i18n.locale):item.watches.some(w=>w.kind==='event')?i18n.t('projectAgent.drawer.objective.event'):i18n.t('projectAgent.drawer.objective.unchecked')}</dd></div>
        </dl>
        {item.lastObservation && <p className="bot-objective-observation">{item.lastObservation.summary}</p>}
        {item.watches.some(w=>w.unavailableReason) && <p role="status">{[...new Set(item.watches.filter(w=>w.unavailableReason).map(w=>i18n.t(objectiveWatchReasonKey(w.unavailableReason))))].join('; ')}</p>}
        {item.usage && <p className="bot-objective-observation">{i18n.t('projectAgent.drawer.objective.autoUsage',{used:item.usage.autoSessions,limit:item.budget.maxAutoSessionsPerDay})}</p>}
        {item.usage && <p className="bot-objective-observation">{i18n.t('projectAgent.drawer.objective.usage',{used:item.usage.probes,limit:item.budget.maxProbeRunsPerDay})}</p>}
        <MotionDetails><summary><PeerIcon name="chevronRight" size={13} />{i18n.t('resources.triggerScope')}</summary>
          <p><code>{item.workspaceId}</code> · <code>{item.originMessageId}</code></p>
          {item.watches.map(watch => <section key={watch.watchId}><p>{watch.kind === 'schedule' ? i18n.t('resources.scheduleTrigger') : i18n.t('resources.eventTrigger')}</p>
            <p>{watch.kind === 'schedule' ? scheduleLabel(watch.schedule, i18n.locale.startsWith('zh') ? 'zh' : 'en')
              : watch.source.type === 'files' ? `${i18n.t('resources.triggerFiles')}: ${watch.source.paths.join(', ')}`
                : watch.source.type === 'git' ? `${i18n.t('resources.triggerGit')}: ${watch.source.ref} · ${i18n.t(watch.source.on === 'new_tag' ? 'resources.newTag' : 'resources.newCommits')}`
                  : `${i18n.t('resources.triggerTasks')}: ${i18n.t(watch.source.filter === 'failed' ? 'resources.taskFailed' : watch.source.filter === 'verified' ? 'resources.taskVerified' : 'resources.taskEnded')}`}</p>
            <p>{i18n.t(watch.notificationPolicy === 'failure_only' ? 'resources.failureOnly' : 'resources.changesOnly')}</p>
          </section>)}
        </MotionDetails>
        {item.lastObservation?.evidenceRefs.length ? <EvidencePreview refs={item.lastObservation.evidenceRefs} i18n={i18n} /> : null}
        <div className="bot-objective-controls">
          <label><span>{i18n.t('projectAgent.drawer.objective.autoAccept')}</span><Switch checked={item.autoAccept===true} disabled={locked||closed||editing} aria-label={i18n.t('projectAgent.drawer.objective.autoAccept')} onCheckedChange={value=>{void command('update',{autoAccept:value});}}/></label>
          <label><span>{i18n.t('projectAgent.drawer.objective.autonomy')}</span><Dropdown value={item.autonomy} disabled={locked||closed||editing} ariaLabel={i18n.t('projectAgent.drawer.objective.autonomy')}
            options={(['report_only','propose','act'] as const).map(value=>({value,label:t(value)}))} onChange={value=>{void command('update',{autonomy:value as ObjectiveAutonomy});}}/></label>
          <label><span>{i18n.t('projectAgent.drawer.objective.budget')}</span><Dropdown value={String(item.budget.maxAutoSessionsPerDay)} disabled={locked||closed||editing} ariaLabel={i18n.t('projectAgent.drawer.objective.budget')}
            options={[...new Set([0,1,2,3,item.budget.maxAutoSessionsPerDay])].sort((a,b)=>a-b).map(value=>({value:String(value),label:String(value)}))} onChange={value=>{void command('update',{budget:{...item.budget,maxAutoSessionsPerDay:Number(value)}});}}/></label>
          <label><span>{i18n.t('projectAgent.drawer.objective.probes')}</span><Dropdown value={String(item.budget.maxProbeRunsPerDay)} disabled={locked||closed||editing} ariaLabel={i18n.t('projectAgent.drawer.objective.probes')}
            options={[...new Set([12,24,60,144,1440,item.budget.maxProbeRunsPerDay])].sort((a,b)=>a-b).map(value=>({value:String(value),label:String(value)}))} onChange={value=>{void command('update',{budget:{...item.budget,maxProbeRunsPerDay:Number(value)}});}}/></label>
        </div>
        <div className="bot-objective-task-links"><span>{i18n.t('projectAgent.drawer.objective.tasks')} {sessionIds.length}</span>
          {item.milestones.map(m=><div key={m.id}><strong>{m.title}</strong>{m.sessionIds.map((id,index)=><button key={id} type="button" disabled={!onOpenSession} onClick={()=>onOpenSession?.(id)}>{m.sessionIds.length>1?`${m.title} ${index+1}`:m.title}<PeerIcon name="chevronRight" size={12}/></button>)}</div>)}
          {!sessionIds.length && <small>{i18n.t('projectAgent.drawer.objective.noTasks')}</small>}
        </div>
        <ResourceFeedback i18n={i18n} action={action} onReload={reload} />
        <footer className="bot-objective-actions">
          <button type="button" disabled={locked || editing} ref={trigger} onClick={()=>setEditing(true)}>{i18n.t('projectAgent.drawer.objective.edit')}</button>
          <button type="button" disabled={locked || editing} onClick={()=>{void command(item.status==='active'?'pause':'resume');}}>{i18n.t(item.status==='active'?'projectAgent.drawer.objective.pause':closed?'projectAgent.drawer.objective.reopen':'projectAgent.drawer.objective.resume')}</button>
          {!closed && <button type="button" disabled={locked || editing} onClick={()=>{void command('delete');}}>{i18n.t('projectAgent.drawer.objective.abandon')}</button>}
        </footer>
      </section>;
}
