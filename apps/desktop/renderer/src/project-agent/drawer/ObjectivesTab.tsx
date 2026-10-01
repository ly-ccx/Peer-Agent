import { useEffect, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { ObjectiveAutonomy, ProjectObjectiveView, ProjectObjectiveUpdateRequest } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import { Dropdown } from '../../app/components/Dropdown';

interface LegacyAutomation { readonly definition?: { readonly automationId?: string; readonly name?: string; readonly workspacePath?: string; }; }

export function ObjectivesTab({workspaceId,workspacePath,i18n,selectedId,onOpenSession,onOpenAutomations}:{
  readonly workspaceId:string; readonly workspacePath:string; readonly i18n:I18nRuntime;
  readonly selectedId?:string; readonly onOpenSession?:(sessionId:string)=>void; readonly onOpenAutomations?:()=>void;
}) {
  const [items,setItems]=useState<readonly LegacyAutomation[]>([]);
  const [objectives,setObjectives]=useState<readonly ProjectObjectiveView[]>([]);
  const [error,setError]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState<string|null>(null);
  const [editing,setEditing]=useState<string|null>(null),[title,setTitle]=useState(''),[outcome,setOutcome]=useState('');
  const t=(key: 'active'|'paused'|'achieved'|'abandoned'|'report_only'|'propose'|'act')=>i18n.t(`projectAgent.drawer.objective.${key}`);
  async function reload(){const result=await clientApi.projectObjectivesList({workspaceId});if(!result.ok)throw Error(result.code);setObjectives(result.items || []);}
  useEffect(()=>{
    let active=true;setLoading(true);setError(false);setObjectives([]);setEditing(null);
    const refresh=()=>{void clientApi.projectObjectivesList({workspaceId}).then(result=>{if(!active)return;if(!result.ok)throw Error(result.code);setObjectives(result.items || []);}).catch(()=>{if(active)setError(true);}).finally(()=>{if(active)setLoading(false);});};
    refresh();
    const off=clientApi.onProjectAgentChanged(event=>{if(event.workspaceIds.includes(workspaceId))refresh();});
    return()=>{active=false;off();};
  },[workspaceId]);
  useEffect(()=>{
    let active=true;setItems([]);
    void clientApi.automationsList().then(rows=>{if(active)setItems((Array.isArray(rows)?rows as readonly LegacyAutomation[]:[]).filter(item=>item.definition?.workspacePath===workspacePath));}).catch(()=>{});
    return()=>{active=false;};
  },[workspacePath]);
  useEffect(()=>{if(selectedId)document.getElementById(`objective-${selectedId}`)?.scrollIntoView({block:'nearest'});},[selectedId,objectives]);
  async function command(item:ProjectObjectiveView,method:'pause'|'resume'|'delete'|'update',patch?:ProjectObjectiveUpdateRequest['patch']){
    setBusy(item.objectiveId);setError(false);
    const request={workspaceId,objectiveId:item.objectiveId,requestId:crypto.randomUUID()};
    try{
      const result=method==='update'?await clientApi.projectObjectivesUpdate({...request,patch:patch || {},expectedVersion:item.version})
        :method==='pause'?await clientApi.projectObjectivesPause(request):method==='resume'?await clientApi.projectObjectivesResume(request):await clientApi.projectObjectivesDelete(request);
      if(!result.ok)throw Error(result.code);await reload();setEditing(null);
    }catch{setError(true);}finally{setBusy(null);}
  }
  return <div className="bot-drawer-tab bot-objectives-tab">
    {error && <p className="bot-objective-error" role="alert">{i18n.t('projectAgent.drawer.objective.failed')}</p>}
    {loading && <p role="status">{i18n.t('projectAgent.drawer.objective.loading')}</p>}
    {!loading && !objectives.length && <div className="bot-objectives-intro">
      <span className="bot-objectives-icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="16" cy="16" r="11"/><circle cx="16" cy="16" r="6"/><circle cx="16" cy="16" r="1.5"/></svg></span>
      <div className="bot-objectives-copy"><h2>{i18n.t('projectAgent.drawer.objective.empty')}</h2><p>{i18n.t('projectAgent.drawer.objective.hint')}</p></div>
    </div>}
    {objectives.map(item=>{
      const locked=busy!==null,closed=item.status==='achieved'||item.status==='abandoned';
      const sessionIds=[...new Set(item.milestones.flatMap(m=>m.sessionIds))];
      const next=item.watches.map(w=>w.nextRunAt).filter((at):at is string=>!!at).sort()[0];
      return <section id={`objective-${item.objectiveId}`} key={item.objectiveId} className={`bot-objective${selectedId===item.objectiveId?' is-selected':''}`}>
        <header><h2>{item.title}</h2><span className="bot-objective-status">{item.pendingConfirmation?i18n.t('projectAgent.drawer.objective.pending'):t(item.status)}</span></header>
        {editing===item.objectiveId?<div className="bot-objective-edit">
          <label>{i18n.t('projectAgent.drawer.objective.title')}<input value={title} maxLength={120} onChange={event=>setTitle(event.target.value)}/></label>
          <label>{i18n.t('projectAgent.drawer.objective.outcome')}<textarea value={outcome} maxLength={2000} onChange={event=>setOutcome(event.target.value)}/></label>
          <div className="bot-objective-actions"><button type="button" disabled={locked||!title.trim()||!outcome.trim()} onClick={()=>{void command(item,'update',{title,outcome});}}>{i18n.t('projectAgent.drawer.objective.save')}</button><button type="button" disabled={locked} onClick={()=>setEditing(null)}>{i18n.t('projectAgent.drawer.objective.cancel')}</button></div>
        </div>:<p className="bot-objective-outcome">{item.outcome}</p>}
        <dl className="bot-objective-facts">
          <div><dt>{i18n.t('projectAgent.drawer.objective.last')}</dt><dd>{item.lastObservation?new Date(item.lastObservation.observedAt).toLocaleString(i18n.locale):i18n.t('projectAgent.drawer.objective.unchecked')}</dd></div>
          <div><dt>{i18n.t('projectAgent.drawer.objective.next')}</dt><dd>{next?new Date(next).toLocaleString(i18n.locale):item.watches.some(w=>w.kind==='event')?i18n.t('projectAgent.drawer.objective.event'):i18n.t('projectAgent.drawer.objective.unchecked')}</dd></div>
        </dl>
        {item.lastObservation && <p className="bot-objective-observation">{item.lastObservation.summary}</p>}
        {item.watches.some(w=>w.unavailableReason) && <p role="status">{item.watches.filter(w=>w.unavailableReason).map(w=>w.unavailableReason).join('; ')}</p>}
        <div className="bot-objective-controls">
          <label><span>{i18n.t('projectAgent.drawer.objective.autonomy')}</span><Dropdown value={item.autonomy} disabled={locked||closed} ariaLabel={i18n.t('projectAgent.drawer.objective.autonomy')}
            options={(['report_only','propose','act'] as const).map(value=>({value,label:t(value)}))} onChange={value=>{void command(item,'update',{autonomy:value as ObjectiveAutonomy});}}/></label>
          <label><span>{i18n.t('projectAgent.drawer.objective.budget')}</span><Dropdown value={String(item.budget.maxAutoSessionsPerDay)} disabled={locked||closed} ariaLabel={i18n.t('projectAgent.drawer.objective.budget')}
            options={[0,1,2,3].map(value=>({value:String(value),label:String(value)}))} onChange={value=>{void command(item,'update',{budget:{...item.budget,maxAutoSessionsPerDay:Number(value)}});}}/></label>
          <label><span>{i18n.t('projectAgent.drawer.objective.probes')}</span><Dropdown value={String(item.budget.maxProbeRunsPerDay)} disabled={locked||closed} ariaLabel={i18n.t('projectAgent.drawer.objective.probes')}
            options={[...new Set([12,24,60,144,1440,item.budget.maxProbeRunsPerDay])].sort((a,b)=>a-b).map(value=>({value:String(value),label:String(value)}))} onChange={value=>{void command(item,'update',{budget:{...item.budget,maxProbeRunsPerDay:Number(value)}});}}/></label>
        </div>
        <div className="bot-objective-task-links"><span>{i18n.t('projectAgent.drawer.objective.tasks')} {sessionIds.length}</span>
          {item.milestones.map(m=><div key={m.id}><strong>{m.title}</strong>{m.sessionIds.map((id,index)=><button key={id} type="button" onClick={()=>onOpenSession?.(id)}>{m.sessionIds.length>1?`${m.title} ${index+1}`:m.title}<PeerIcon name="chevronRight" size={12}/></button>)}</div>)}
          {!sessionIds.length && <small>{i18n.t('projectAgent.drawer.objective.noTasks')}</small>}
        </div>
        <footer className="bot-objective-actions">
          <button type="button" disabled={locked} onClick={()=>{setEditing(item.objectiveId);setTitle(item.title);setOutcome(item.outcome);}}>{i18n.t('projectAgent.drawer.objective.edit')}</button>
          <button type="button" disabled={locked} onClick={()=>{void command(item,item.status==='active'?'pause':'resume');}}>{i18n.t(item.status==='active'?'projectAgent.drawer.objective.pause':closed?'projectAgent.drawer.objective.reopen':'projectAgent.drawer.objective.resume')}</button>
          {!closed && <button type="button" disabled={locked} onClick={()=>{void command(item,'delete');}}>{i18n.t('projectAgent.drawer.objective.abandon')}</button>}
        </footer>
      </section>;
    })}
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
                  <button type="button" className="bot-task-row" onClick={() => onOpenAutomations?.()}>
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
