import path from 'node:path';
import { statSync } from 'node:fs';
import { createTuiEvidenceReader } from './tui-evidence-reader.ts';
import { randomUUID } from 'node:crypto';
import { createConversationStore } from '@peer-agent/conversation-store';
import {
  createHostLease, createProjectRegistry, createBotProfileStore, createBotDirectory,
  createProjectAgentHost, createSessionSupervisor, createExecutionScheduler,
  createProjectInbox, createInputQueue, createApprovalStore, createGoalPlanStore, applyStartupApprovalRecovery,
  createProjectGoalRunnerHost, createGoalWorktreeAdapter, createGoalTaskBranchAdapter,
  createAutomationWorktreeAdapter, createObjectiveStore, createObjectiveActions,
  createObjectiveService, createDesktopObjectiveWatchHost, createSessionVerification,
  createDesktopProjectFacts, createDesktopReplyComposer, createProjectLifecycleEffects,
  createBotLifecycle, createMemoryStore, createMemoryCurator, createEpisodeLog,
  createMemoryMaintenance, createMemoryFileAnchors, runMemoryCuratorTurn,
  createOneTimeApprovalBook, createCallbackSink, inQuietHours, loadMigratedSettings,
  isEffectiveMemory, delegationFactsForWorkspace, readProjectInstructionLines,
  encodeProviderToolResult,
  shouldPauseForHostHandoff,
} from '@peer-agent/runtime-node';
import { resolveGitBranchPrefix } from '@peer-agent/system-context';
import { createProjectToolProvider } from './project-tool-provider.ts';
import { createTuiTurnExecutor } from './tui-turn-executor.ts';
import type { PendingApproval } from '../tui-host.ts';

/** Local composition for the terminal. All durable algorithms are shared with desktop. */
export function createTuiProjectHost(options: {
  dataHome: string;
  workspacePath: string;
  appVersion?: string;
  getSettings?: () => any;
  executeTurn?: (request: any) => Promise<any>;
  createRuntime?: Parameters<typeof createTuiTurnExecutor>[0]['createRuntime'];
  onChanged?: () => void;
  autoStart?: boolean;
}) {
  const { dataHome } = options, runtimeRoot = path.join(dataHome, 'project-runtime');
  const getSettings = options.getSettings ?? (() => loadMigratedSettings(path.join(dataHome, 'settings.json')));
  const registry = createProjectRegistry({ filePath: path.join(dataHome, 'projects/registry.json') });
  const profiles = createBotProfileStore({ rootDir: dataHome } as never);
  const conversations = createConversationStore({ storeDir: path.join(dataHome, 'conversations'), usageLogFile: path.join(dataHome, 'usage-request-log.jsonl') });
  const plans = createGoalPlanStore({ storeDir: path.join(dataHome, 'goal-plans') });
  const approvals = createApprovalStore({ rootDir: runtimeRoot });
  const memory = createMemoryStore({ rootDir: dataHome } as never);
  const inbox = createProjectInbox({ rootDir: runtimeRoot } as never);
  const objectivesStore = createObjectiveStore({ rootDir: dataHome } as never);
  const objectiveActions = createObjectiveActions({ rootDir: runtimeRoot } as never);
  const readEvidence = createTuiEvidenceReader({ dataHome, plans, readWatchEvidence: ref => watches?.readEvidenceBody(ref) });
  const liveApprovals = new Map<string, PendingApproval>();
  const oneTimeApprovals = createOneTimeApprovalBook();
  let selectedId = registry.findByPath(options.workspacePath)?.workspaceId ?? '';
  let host: ReturnType<typeof createProjectAgentHost>;
  let toolProvider: ReturnType<typeof createProjectToolProvider>;
  let watches: ReturnType<typeof createDesktopObjectiveWatchHost>;
  let objectives: ReturnType<typeof createObjectiveService>;
  let closed = false;
  const changed = () => options.onChanged?.();
  const memoryEnabled = (workspaceId: string) => getSettings().memory?.enabled !== false && profiles.read(workspaceId)?.memoryEnabled !== false;
  const readMessages = (id: string): any[] => conversations.getPersistedConversationHistory?.(id)?.messages as any[] ?? [];
  const holds = (id: string): boolean => !closed && id === selectedId && profiles.read(id)?.status === 'active' && leases.holds(id);
  const scheduler = createExecutionScheduler({ rootDir: runtimeRoot, getConcurrency: () => getSettings().projectAgent?.concurrency,
    isWorkspaceReady: (id: string) => host?.isReady(id) === true } as never);
  const leases = createHostLease({ rootDir: runtimeRoot, hostId: `tui-${randomUUID()}`, surface: 'tui', appVersion: options.appVersion ?? '',
    projectAgentEnabled: () => !closed, botWorkspaceIds: () => selectedId && profiles.read(selectedId)?.status === 'active' ? [selectedId] : [] } as never);
  const executor = createTuiTurnExecutor({ dataHome, getSettings, holdsLease: holds,
    resolveWorkspacePath: id => registry.get(id)?.path ?? options.workspacePath,
    readMessages, readMemory: id => memory.list({workspaceId: id, status: 'active'}).filter(item => isEffectiveMemory(item)),
    memoryEnabled, getProviders: () => toolProvider ? [toolProvider] : [], scheduler, oneTimeApprovals, goalPlanStore: plans, createRuntime: options.createRuntime,
    onApproval(approval, streamId) { if (approval) liveApprovals.set(streamId, approval); else liveApprovals.delete(streamId); changed(); },
    persistTurn(input, output) {
      if (!input.conversationId || !input.assistantMessageId) return;
      (conversations.updateMessageById as (id: string, messageId: string, patch: object) => unknown)(input.conversationId, input.assistantMessageId, {
        content: output.text, interrupted: output.interrupted,
        segments: [...output.calls.map(call => ({type: 'tool-call', tool: call.name, toolCallId: call.toolCallId,
          args: call.input, status: call.execution.result.status, result: encodeProviderToolResult({result: call.execution.result,
            execution: call.execution, conversationId: input.conversationId, toolCallId: call.toolCallId}).content})),
          ...(output.text ? [{type: 'text', content: output.text}] : [])],
      } as never);
      if (output.usage && !output.interrupted) conversations.recordRuntimeTurnUsage?.(input.conversationId, {usage: output.usage,
        attribution: {id: `tui:${input.assistantMessageId}`, at: new Date().toISOString(), role: input.turnProfile?.role,
          workspaceId: input.turnProfile?.workspaceId, modelProviderId: input.modelProviderId} } as never);
      changed();
    },
  });
  const turns = options.executeTurn ? {...executor, runTurn: options.executeTurn} : executor;
  const worktree = createGoalWorktreeAdapter({goalPlanStore: plans, rootDir: path.join(dataHome, 'goal-plans/worktrees'),
    worktreeAdapter: createAutomationWorktreeAdapter({rootDir: path.join(dataHome, 'goal-plans/worktrees'), artifactDir: path.join(dataHome, 'goal-plans/artifacts')})} as never);
  const taskBranch = createGoalTaskBranchAdapter({goalPlanStore: plans, resolvePrefix: () => resolveGitBranchPrefix({gitBranchPrefix: getSettings().gitBranchPrefix})} as never);
  const goalHost = createProjectGoalRunnerHost({goalPlanStore: plans, conversationStore: conversations,
    agentTurnExecutor: turns, llmChatService: turns, broadcast: changed, hostLeases: {holds},
    goalWorktreeAdapter: worktree, goalTaskBranchAdapter: taskBranch, workspaceRoot: options.workspacePath,
    createSink: () => createCallbackSink(), resolveConversationModelProviderId: ({conversationId}: any) => conversations.getConversation(conversationId)?.modelProviderId,
    toDesktopProviderMessages: (messages: any) => messages, desktopContinuityContextFromProjection: () => [],
  } as never);
  const goalRunner = goalHost.goalRunner as typeof goalHost.goalRunner & { verifyDelegatedSession(input: object): Promise<any> };
  const verification = createSessionVerification({goalPlanStore: plans,
    verifySession: (plan: any, focus: string) => goalRunner.verifyDelegatedSession({plan, focus}),
    appendMessage: (id: string, message: any) => conversations.appendMessage(id, message)} as never);
  const supervisor = createSessionSupervisor({conversationStore: conversations, goalPlanStore: plans, goalRunner,
    executionScheduler: scheduler, deferRecovery: true, approvalStore: approvals, memoryStore: memory, canManageWorkspace: holds,
    objectives: {prepareSpawn: (...args: any[]) => (objectives.prepareSpawn as any)(...args), linkSession: (...args: any[]) => (objectives.linkSession as any)(...args)},
    resolveModel: (input: any) => turns.resolveGoalRole({...input, workerModelProviderId: input.workerModel?.modelProviderId, projectPolicy: profiles.read(input.workspaceId)?.modelPolicy}),
    resolveAcceptancePolicy: (id: string, plan: any) => plan?.delegationOrigin?.objectiveId ? objectives.acceptancePolicy(id, plan.delegationOrigin.objectiveId) : profiles.read(id)?.acceptancePolicy,
    readSessionFacts: (plan: any) => ({autoHandoffOnPolicyAccept: profiles.read(plan.delegationOrigin.workspaceId)?.autoHandoffOnPolicyAccept === true,
      hostAuthority: verification.facts(plan.delegationOrigin.sessionId)}),
    readPlanApproval: (id: string) => profiles.read(id)?.planApproval,
    emitEvent: (event: any) => {inbox.append(event.workspaceId, [{...event, eventId: `supervisor:${event.kind}:${event.sessionId}:${event.verdictRef || event.anchorMessageId || event.reason || ''}`}]); changed();},
  } as never);
  const resolveConversationId = (id: string) => profiles.read(id)?.agentConversationId ?? '';
  objectives = createObjectiveService({store: objectivesStore, actions: objectiveActions, canManageWorkspace: holds, resolveConversationId,
    readSessions: (id: string) => supervisor.sessionsForProject(id), readConversation: readMessages,
    readSession: (id: string) => {const session=supervisor.get({sessionId:id,detail:'report'}) as any;return session ? {...session,evidenceRefs:session.report?.evidenceRefs ?? []} : null;},
    resolveEvidence: (ref: string) => {const record=plans.findEvidenceIndexRecords([ref])[0];const plan=record?.planId ? plans.getPlan(record.planId) : null;return plan?.delegationOrigin ? {...record,workspaceId:plan.delegationOrigin.workspaceId,sessionId:plan.delegationOrigin.sessionId} : watches?.resolveEvidence(ref);},
    decorateView: (id: string,item:any) => {const view=watches?.decorateView(id,item) ?? item;return {...view,usage:{...view.usage,autoSessions:objectiveActions.usage(id,item.objectiveId)}};},
    onChanged: changed} as never);
  watches = createDesktopObjectiveWatchHost({rootDir: runtimeRoot, store: objectivesStore, ownsProject: holds,
    isReady: (id: string) => host?.isReady(id) === true, resolveWorkspacePath: (id: string) => registry.get(id)?.path,
    readSessions: (id: string) => supervisor.sessionsForProject(id).map((row:any)=>({...row,verdict:supervisor.acceptance(row.sessionId)?.verdict})), agentTurnExecutor: turns,
    projectPolicy: (id: string) => profiles.read(id)?.modelPolicy, inbox, wake: () => void tick(), onChanged: changed} as never);
  const facts = createDesktopProjectFacts({supervisor, approvalStore: approvals, profileStore: profiles, conversationStore: conversations,
    runtimeRoot, memoryStore: memory, objectiveProposals: (id: string) => objectiveActions.pending(id)} as never);
  const directory = createBotDirectory({rootDir: dataHome, registry, readMessages, listSessions: (id: string) => supervisor.list({workspaceId: id}),
    getSession: (id: string) => supervisor.get({sessionId: id}), listApprovals: (id: string) => approvals.list({workspaceId: id}), readCards: facts.cards} as never);
  const lifecycle = createBotLifecycle({rootDir: dataHome, enabled: () => !closed, registry, conversationStore: conversations, memoryStore: memory,
    spawn: async (input: any) => {
      await tick(); const anchor = `lifecycle-${input.kind}-${input.workspaceId}`;
      if (!readMessages(input.conversationId).some(row => row.id === anchor)) conversations.appendMessage(input.conversationId,{id: anchor, role:'user',kind:'user_input',content:input.task.brief} as never);
      return supervisor.spawn({...input.task,anchorMessageIds:[anchor]},{workspaceId:input.workspaceId,parentConversationId:input.conversationId,workspacePath:input.workspacePath});
    }} as never);
  toolProvider = createProjectToolProvider({rootDir: dataHome, supervisor, objectives, verification,
    replyComposer: createDesktopReplyComposer({readDelivery: (view: any) => ({...facts.delivery(view.workspaceId), ...watches.deliveryFacts(view),
      proactivity: getSettings().projectAgent?.proactivity, botLevel: profiles.read(view.workspaceId)?.proactivity,
      quietHours: inQuietHours(new Date(), getSettings().projectAgent?.quietHours)})} as never),
    proactivity: {set: ({workspaceId, level}: any) => profiles.save({...profiles.read(workspaceId),proactivity:level})},
    checkModel: (input: any) => turns.resolveGoalRole({role:'session_worker', ...input}), memoryEnabled});
  const fileAnchors = createMemoryFileAnchors({resolveWorkspacePath: (id: string) => registry.get(id)?.path} as never);
  const maintenance = createMemoryMaintenance({rootDir:runtimeRoot, store:memory, readAnchor:fileAnchors.read, onChanged:changed} as never);
  const curator = createMemoryCurator({store:memory, episodes:createEpisodeLog({rootDir:dataHome}), memoryEnabled,
    learnPreferences: () => getSettings().memory?.learnPreferences !== false,
    runTurn: (request: any) => runMemoryCuratorTurn({request,getSettings,resolveRoute: turns.resolveGoalRole,runTurn: turns.runTurn} as never),
    resolveEvidence:(ref: string)=>readEvidence(ref)?.text || '',
    contradicts:(id: string)=>readProjectInstructionLines(registry.get(id)?.path),
    resolveFileAnchors:fileAnchors.capture, onWrote:changed} as never);
  const inputs = createInputQueue({rootDir:runtimeRoot, holdsLease:holds, resolveConversationId,
    hasMessage:(id: string, messageId: string) => readMessages(id).some(row=>row.id===messageId),
    appendMessage:(id: string, message: any) => {conversations.appendMessage(id,message);changed();}} as never);
  host = createProjectAgentHost({rootDir:runtimeRoot, holdsLease:holds, acquireLease:(id: string)=>leases.acquire(id),
    listWorkspaceIds:()=> selectedId ? [selectedId] : [], resolveConversationId,
    appendMessage:(id: string,message: any)=>{conversations.appendMessage(id,message);changed();}, readMessages,
    executeTurn:(request: any)=>turns.runTurn({...request,ephemeral:true,messages:readMessages(request.conversationId)
      .filter(message=>['user_input','agent_reply'].includes(message.kind)).map(message=>({role:message.role,content:message.content}))}),
    resolveModel:(input: any)=>turns.resolveGoalRole({...input,projectPolicy:profiles.read(input.workspaceId)?.modelPolicy}),
    resolveContext:({workspaceId}: any)=>{const result=objectives.list({}, {workspaceId,conversationId:resolveConversationId(workspaceId)});return {objectives:result.ok && 'items' in result ? result.items : []};},
    resolveRoster:(id: string)=>supervisor.list({workspaceId:id}), restoreQueue:(id: string)=>{applyStartupApprovalRecovery({approvalStore:approvals,goalPlanStore:plans,canRecover:row=>row.workspaceId===id});return supervisor.recoverQueue(id);},
    recoverTasks:(id: string)=>goalRunner.recoverContextCheckpoints({workspaceId:id,deferPump:true} as never), activateSessions:supervisor.resumeRecovered,
    restoreWatches:watches.restore,stopWatches:watches.stopWorkspace, reconcileSessions:supervisor.reconcile,
    readSettings:getSettings, inputQueue:inputs, inbox, onStatus:changed,
    onCurator:(input: any)=>curator.consider(input), onMaintenance:(input: any)=>{if(holds(input.workspaceId)&&memoryEnabled(input.workspaceId))maintenance.runDue(input);},
    readFacts:(id: string)=>delegationFactsForWorkspace(plans.listPlans().map((row: any)=>plans.getPlan(row.planId)),id),
    ...createProjectLifecycleEffects({profileStore:profiles,lifecycle,supervisor,conversationStore:conversations,resolveConversationId,broadcast:changed,objectiveService:objectives,resolveEvidence:(ref: string)=>readEvidence(ref)?.text || ''} as never),
  } as never);
  const running = new Set<Promise<unknown>>();
  let wakeStamp = '';
  function currentWakeStamp() {
    return ['input-queue.jsonl','inbox.jsonl','host.lease'].map(name => {
      try { const stat = statSync(path.join(runtimeRoot, selectedId, name)); return `${stat.mtimeMs}:${stat.size}`; }
      catch { return 'missing'; }
    }).join('|');
  }
  async function tick() {
    if (closed || !selectedId) return;
    const next = currentWakeStamp();
    if (running.size && next === wakeStamp) return Promise.allSettled([...running]);
    wakeStamp = next;
    const job = host.sync([selectedId]).finally(()=>{running.delete(job);});
    running.add(job);
    return job;
  }
  async function stopExecution(id: string, reason = 'handoff') {
    host.drain(id);
    const sessions = supervisor.sessionsForProject(id);
    for (const row of sessions) {
      scheduler.cancelPlan(row.planId);
      if (reason !== 'lost' && shouldPauseForHostHandoff(plans.getPlan(row.planId))) goalRunner.pause(row.planId,'host_handoff');
    }
    await executor.stop(id); await Promise.allSettled([...running]); await watches.stopWorkspace(id);
    await Promise.allSettled(sessions.map(row => goalRunner.waitForIdle(row.planId)));
  }
  leases.setYieldHandler(async (id: string, reason: string) => { await stopExecution(id, reason); changed(); });
  const timer = options.autoStart === false ? null : setInterval(()=>void tick().catch(()=>changed()),1000);
  timer?.unref();
  if(options.autoStart!==false){watches.start(()=>selectedId?[selectedId]:[]);void tick();}
  return { registry, profiles, directory, conversations, plans, approvals, memory, objectives, supervisor, host, leases, executor, inputs, lifecycle, readEvidence,
    workspaceId:()=>selectedId, holdsLease:holds, tick,
    async selectWorkspace(id: string) {if(id===selectedId)return;const old=selectedId;if(old){await stopExecution(old);leases.release(old);}selectedId=id;host.restart(id);await tick();changed();},
    async takeover() {if(!selectedId)return {requested:false};const request=leases.requestTakeover(selectedId);if(request.reason==='free')leases.acquire(selectedId);await tick();return request;},
    async decideApproval(approvalId: string, decision: 'approve'|'deny') {
      if(!holds(selectedId))return {ok:false,error:'desktop_approval_required'};
      const record=approvals.list({workspaceId:selectedId}).find(row=>row.approvalId===approvalId);
      if(!record)return {ok:false,error:'not_found'};
      const planApproval=record.capabilityId==='goal.plan' || record.approvalId.startsWith('plan:');
      const live=[...liveApprovals.values()].find(row=>row.toolCallId===approvalId);
      if(record.state==='open'&&live){live.resolve(decision==='approve'?'allow-once':'deny');return {ok:true};}
      if(!['open','stale'].includes(record.state))return {ok:true,replayed:true};
      if(decision==='approve'){
        const session=record.sessionId ? supervisor.get({sessionId:record.sessionId}) : null;
        if(session && ['paused','superseded'].includes(session.status))return {ok:false,error:'session_paused'};
        if(record.state==='open' && !planApproval)return {ok:false,error:'approval_not_live'};
        if(!planApproval)oneTimeApprovals.remember({...record,at:Date.now()});
        const resumed=await supervisor.resumeFromApproval(record) as unknown as {ok: boolean; reason?: string};
        if(!resumed.ok)return {ok:false,error:resumed.reason};
      }
      else if(planApproval)await supervisor.cancel({sessionId:record.sessionId,reason:'plan_approval_denied'});
      approvals.append({...record,state:decision==='approve'?'approved':'denied',decidedAt:new Date().toISOString(),decidedBy:'local_ui'});changed();return {ok:true};
    },
    async close() {if(timer)clearInterval(timer);if(selectedId)await stopExecution(selectedId);closed=true;host.dispose();watches.dispose();toolProvider.dispose();leases.close();},
  };
}
