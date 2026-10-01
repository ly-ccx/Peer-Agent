import { shouldPauseForHostHandoff } from '@peer-agent/runtime-node';
import { createProjectAgentHost as createPortableProjectAgentHost } from '@peer-agent/runtime-node';
import {createDesktopObjectiveWatchHost} from './objective-watch-host.mjs';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { projectConversationHistory } from '@peer-agent/runtime-core';

import {
  createApprovalStore,
  applyStartupApprovalRecovery,
  createObjectiveStore,
  createObjectiveActions,
  createObjectiveService,
  createBotDirectory,
  createBotLifecycle,
  createBotProfileStore,
  createInputQueue,
  createMemoryStore,
  createEpisodeLog,
  createMemoryCurator,
  createMemoryMaintenance,
  createMemoryFileAnchors,
  isEffectiveMemory,
  createDigestQueue,
  createProjectAgentRunner,
  inQuietHours,
  createProjectInbox,
  createWatchPublisher,
  delegationFactsForWorkspace,
  normalizeProjectAgentSettings,
  createProjectRegistry,
  createSessionSupervisor,
  createExecutionScheduler,
  createCircuitBreaker,
  createProjectRecovery,
  resolveRoleRoute,
} from '@peer-agent/runtime-node';
import { createBroadcastSink } from '../agent-host/turn-sinks.mjs';
import { runMemoryCuratorTurn } from './memory-curator-turn.mjs';
import { createProjectAgentApplicationService } from './project-agent-application-service.mjs';
import { createClassicGoalProjection } from './classic-goal-projection.mjs';
import { createManagedFolder } from './managed-folder.mjs';
import { evidenceBodyFromRecord } from './evidence-presenter.mjs';
import { readProjectInstructionLines } from './project-instruction-lines.mjs';
import { createProjectAgentIpcRegistrations } from '../ipc/register-project-agent-ipc.mjs';
import { createProjectObjectivesIpcRegistrations } from '../ipc/register-project-objectives-ipc.mjs';
import { createProjectObjectivesService } from './project-objectives-service.mjs';
import { createProjectMemoryIpcRegistrations } from '../ipc/register-project-memory-ipc.mjs';
import { installSessionVerification, createSessionVerification } from './session-verification.mjs';
import { installProjectProactivity } from './proactivity-port.mjs';
import { installDeliveryFacts } from './delivery-facts-port.mjs';
import { installMemoryGate, memoryUseEnabled } from './memory-gate-port.mjs';
import { liveMemoryIndex } from './memory-index-port.mjs';
import { createProjectMemoryService } from './project-memory-service.mjs';
import { resolveArtifactOpenPath } from '../task-overview-aggregator.mjs';
import { installDelegation } from './delegation-port.mjs';
import { createDesktopProjectFacts } from './project-facts.mjs';
import { createProjectLifecycleEffects } from './project-lifecycle-effects.mjs';

/** Current user inputs become the model messages, including bounded image thumbnails. */
export function messagesFromUserInputs(plan) {
  const inputs = Array.isArray(plan?.userInputs) ? plan.userInputs : [];
  if (inputs.length === 0) return null;
  const projected = projectConversationHistory(inputs.map((item) => ({
    role: 'user',
    content: typeof item?.text === 'string' ? item.text : '',
    attachments: Array.isArray(item?.attachments) ? item.attachments : [],
  }))).messages;
  if (projected.length === 0) return null;
  return projected.map((message) => ({ role: message.role, content: message.content }));
}

function fileStamp(file) {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * 桌面装配：只为当前进程持有租约、并且已经有代理对话的项目创建 runner。
 * main / IPC 在 B2-13 接入。输入从 consume() 的返回值入队，不再听 onCommitted。
 */
export function createProjectAgentHost(options = {}) {
  return createPortableProjectAgentHost({ ...options, createSink: () => createBroadcastSink({ getWindows: options.getWindows }) });
}

export function registerDesktopProjectAgent({
  enabled,
  dataHome,
  conversationStore,
  goalPlanStore,
  goalRunner,
  agentTurnExecutor,
  workspace,
  broadcast,
  holdsLease,
  acquireLease = null,
  releaseLease = null,
  hostLeases = null,
  getSettings,
  mergeSettings,
  dialog,
  BrowserWindow,
  shell,
  listModels = () => [],
  readUiDelivery = null,
  onReady = null,
  onAppendedMessage = null,
  onViewing = null,
} = {}) {
  const runtimeRoot = path.join(dataHome, 'project-runtime');
  let host = null;
  let objectiveWatches=null;
  const runtimeEnabled = () => enabled() && getSettings()?.projectAgent?.shell !== 'classic';
  const ownsProject = workspaceId => runtimeEnabled() && profileStore.read(workspaceId)?.status === 'active' && holdsLease(workspaceId) === true;
  const executionScheduler = agentTurnExecutor.executionScheduler ?? goalRunner?.executionScheduler ?? createExecutionScheduler();
  executionScheduler.configure({ rootDir: runtimeRoot, getConcurrency: () => getSettings()?.projectAgent?.concurrency, isWorkspaceReady: workspaceId => host?.isReady(workspaceId) === true });
  function readEvidenceBody(evidenceRef) {
    try {
      const record = goalPlanStore.findEvidenceIndexRecords?.([evidenceRef])?.[0];
      if (!record) return objectiveWatches?.readEvidenceBody(evidenceRef) || null;
      const body = evidenceBodyFromRecord(record, ref => readRegisteredArtifact(dataHome, ref, record));
      return body?.text ? body : null;
    } catch { return null; }
  }
  const registry = createProjectRegistry({
    filePath: path.join(dataHome, 'projects', 'registry.json'),
  });
  const approvalStore = createApprovalStore({ rootDir: runtimeRoot });
  const profileStore = createBotProfileStore({ rootDir: dataHome });
  const memoryStore = createMemoryStore({ rootDir: dataHome });
  const memoryChanged = workspaceId => {
    liveMemoryIndex().rebuild();
    if (typeof broadcast === 'function') broadcast('project-agent:changed', { workspaceIds: [workspaceId] });
  };
  const fileAnchors = createMemoryFileAnchors({ resolveWorkspacePath: workspaceId => registry.get(workspaceId)?.path });
  const memoryMaintenance = createMemoryMaintenance({ rootDir: runtimeRoot, store: memoryStore, readAnchor: fileAnchors.read, onChanged: memoryChanged });
  const inbox = createProjectInbox({ rootDir: runtimeRoot });
  const verification = createSessionVerification({
    goalPlanStore,
    verifySession: (plan, focus) => goalRunner?.verifyDelegatedSession?.({ plan, focus }),
    appendMessage,
  });
  const objectiveStore = createObjectiveStore({rootDir:dataHome});
  const objectiveActions=createObjectiveActions({rootDir:runtimeRoot});
  let objectiveService;
  const supervisor = createSessionSupervisor({
    objectives: {prepareSpawn:(...args)=>objectiveService.prepareSpawn(...args),linkSession:(...args)=>objectiveService.linkSession(...args)},
    conversationStore,
    goalPlanStore,
    goalRunner,
    executionScheduler,
    canManageWorkspace: ownsProject,
    deferRecovery: true,
    approvalStore,
    memoryStore,
    resolveModel: (input) => agentTurnExecutor.resolveGoalRole({
      ...input,
      workerModelProviderId: input.workerModel?.modelProviderId,
      projectPolicy: profileStore.read(input.workspaceId)?.modelPolicy,
    }),
    resolveAcceptancePolicy: (workspaceId, plan) => plan?.delegationOrigin?.objectiveId ? objectiveService.acceptancePolicy(workspaceId,plan.delegationOrigin.objectiveId) : profileStore.read(workspaceId)?.acceptancePolicy,
    readSessionFacts: (plan) => ({ autoHandoffOnPolicyAccept: profileStore.read(plan.delegationOrigin.workspaceId)?.autoHandoffOnPolicyAccept === true, hostAuthority: {
      ...(verification.facts(plan.delegationOrigin.sessionId) || {}),
      ...(typeof readUiDelivery === 'function' ? { uiDeliveryRequired: readUiDelivery(plan)?.required === true, uiDelivery: readUiDelivery(plan) } : {}),
    } }),
    emitEvent: (event) => inbox.append(event.workspaceId, [{ ...event, eventId: `supervisor:${event.kind}:${event.sessionId}:${event.verdictRef || event.anchorMessageId || event.supersededBy || event.reason || ''}` }]),
    readPlanApproval: (workspaceId) => profileStore.read(workspaceId)?.planApproval,
  });
  objectiveService = createObjectiveService({store:objectiveStore,actions:objectiveActions,readSessions:workspaceId=>supervisor.sessionsForProject(workspaceId),canManageWorkspace:ownsProject,resolveConversationId,
    readConversation: id => conversationStore.getPersistedConversationHistory(id)?.messages || [],
    readSession: id => { const session=supervisor.get({sessionId:id,detail:'report'}); return session ? {...session,evidenceRefs:session.report?.evidenceRefs || []} : null; },
    resolveEvidence: ref => {
      const record=goalPlanStore.findEvidenceIndexRecords?.([ref])?.[0];
      const plan=record?.planId ? goalPlanStore.getPlan?.(record.planId) : null;
      return plan?.delegationOrigin ? {...record,workspaceId:plan.delegationOrigin.workspaceId,sessionId:plan.delegationOrigin.sessionId} : objectiveWatches?.resolveEvidence(ref) || null;
    },
    decorateView:(workspaceId,item)=>{const view=objectiveWatches?.decorateView(workspaceId,item)||item;return {...view,usage:{...view.usage,autoSessions:objectiveActions.usage(workspaceId,item.objectiveId)}};},
    onChanged: workspaceId => { if(typeof broadcast==='function')broadcast('project-agent:changed',{workspaceIds:[workspaceId]});objectiveWatches?.changed(workspaceId); },
  });
  objectiveWatches=createDesktopObjectiveWatchHost({rootDir:runtimeRoot,store:objectiveStore,ownsProject,isReady:workspaceId=>host?.isReady(workspaceId)===true,
    resolveWorkspacePath:workspaceId=>registry.get(workspaceId)?.path,readSessions:workspaceId=>supervisor.sessionsForProject(workspaceId).map(row=>({...row,verdict:supervisor.acceptance(row.sessionId)?.verdict})),agentTurnExecutor,projectPolicy:workspaceId=>profileStore.read(workspaceId)?.modelPolicy,inbox,
    wake:workspaceId=>{void host?.sync([workspaceId]).catch(()=>{});},onChanged:workspaceId=>broadcast?.('project-agent:changed',{workspaceIds:[workspaceId]})});
  const objectives = createProjectObjectivesService({service:objectiveService,store:objectiveStore,profileStore,conversationStore,
    enabled:runtimeEnabled,holdsLease,onAppendedMessage,
  });
  const uninstallDelegation = installDelegation({ supervisor, objectives:objectiveService, storeDir: runtimeRoot });
  const uninstallVerification = installSessionVerification(verification);
  const projectFacts = createDesktopProjectFacts({ supervisor, approvalStore, profileStore, conversationStore, runtimeRoot, memoryStore,objectiveProposals:workspaceId=>objectiveActions.pending(workspaceId).filter(row=>{const item=objectiveStore.get(workspaceId,row.objectiveId);return item?.status==='active'&&!item.pendingConfirmation&&item.autonomy!=='report_only'&&item.version===row.version;}) });
  const uninstallDelivery = installDeliveryFacts({
    read(view) {
      const settings = normalizeProjectAgentSettings(getSettings()?.projectAgent);
      const level = profileStore.read(view?.workspaceId)?.proactivity;
      return {
        ...projectFacts.delivery(view?.workspaceId),
        ...objectiveWatches?.deliveryFacts(view),
        proactivity: settings.proactivity,
        ...(typeof level === 'string' && level !== 'inherit' ? { botLevel: level } : {}),
        quietHours: inQuietHours(new Date(), settings.quietHours),
      };
    },
  });
  const uninstallProactivity = installProjectProactivity({
    set({ workspaceId, level }) {
      const profile = profileStore.read(workspaceId);
      if (!profile || profile.status === 'archived') return { ok: false, error: 'not_found' };
      const saved = profileStore.save({ ...profile, proactivity: level });
      if (!saved?.ok) return { ok: false, error: saved?.code || 'save_failed' };
      return { ok: true, level };
    },
  });
  const uninstallMemory = installMemoryGate({
    enabled(workspaceId) {
      const settings = typeof getSettings === 'function' ? getSettings() : null;
      const profile = workspaceId ? profileStore.read(workspaceId) : null;
      return memoryUseEnabled({ settings, profile });
    },
  });
  const memoryCurator = createMemoryCurator({
    store: memoryStore,
    episodes: createEpisodeLog({ rootDir: dataHome }),
    learnPreferences: () => getSettings()?.memory?.learnPreferences !== false,
    memoryEnabled: (workspaceId) => {
      const settings = typeof getSettings === 'function' ? getSettings() : null;
      const profile = workspaceId ? profileStore.read(workspaceId) : null;
      return memoryUseEnabled({ settings, profile });
    },
    resolveEvidence: ref => readEvidenceBody(ref)?.text || '',
    contradicts(workspaceId) {
      const folder = registry.get(workspaceId)?.path;
      if (typeof folder !== 'string' || !folder) return [];
      try {
        return readProjectInstructionLines(folder);
      } catch {
        return [];
      }
    },
    runTurn: (request) => runMemoryCuratorTurn({
      request,
      getSettings,
      resolveRoute: (input) => (
        typeof agentTurnExecutor?.resolveGoalRole === 'function'
          ? agentTurnExecutor.resolveGoalRole({ role: 'memory_curator', ...input })
          : null
      ),
      runTurn: (input) => agentTurnExecutor.runTurn(input),
    }),
    resolveFileAnchors: fileAnchors.capture,
    onWrote: memoryChanged,
  });
  const classicGoals = createClassicGoalProjection({ registry, conversationStore, goalPlanStore });
  const directory = createBotDirectory({
    rootDir: dataHome,
    registry,
    readMessages: (conversationId) => (
      conversationStore.getPersistedConversationHistory(conversationId)?.messages || []
    ),
    listSessions: (workspaceId) => supervisor.list({ workspaceId }),
    getSession: (sessionId) => supervisor.get({ sessionId }),
    listApprovals: (workspaceId) => approvalStore.list({ workspaceId }),
    readCards: (workspaceId) => projectFacts.cards(workspaceId),
    listClassicGoals: classicGoals.one,
    readClassicGoalsBatch: classicGoals.batch,
  });
  const lifecycle = createBotLifecycle({
    rootDir: dataHome,
    enabled: runtimeEnabled,
    registry,
    conversationStore,
    memoryStore,
    spawn: async (request) => {
      await host.sync([request.workspaceId]);
      if (!host.isReady(request.workspaceId)) return { error: 'recovery_pending' };
      const anchorMessageId = `lifecycle-${request.kind}-${request.workspaceId}`;
      if (!hasMessage(request.conversationId, anchorMessageId)) appendMessage(request.conversationId, {
        id: anchorMessageId, role: 'user', kind: 'user_input', content: request.task.brief,
      });
      return supervisor.spawn({ ...request.task, anchorMessageIds: [anchorMessageId] }, {
        workspaceId: request.workspaceId, parentConversationId: request.conversationId, workspacePath: request.workspacePath,
      });
    },
    removeWorkspace: (folder) => workspace.removeWorkspace(folder),
    moveToTrash: (folder) => shell.trashItem(folder),
    resumeWorkspace: workspaceId => host.restart(workspaceId),
    stopWorkspace: async workspaceId => {
      if (!ownsProject(workspaceId)) return { ok: false, code: 'HOST_OFFLINE' };
      host.stop(workspaceId);
      await objectiveWatches.stopWorkspace(workspaceId);
      const result = await supervisor.cancelWorkspace(workspaceId);
      if (!result.ok) return { ok: false, code: result.error || 'STOP_FAILED' };
      releaseLease?.(workspaceId);
      return { ok: true };
    },
  });
  if (runtimeEnabled()) {
    try {
      const settings = typeof getSettings === 'function' ? getSettings() : null;
      const workspaces = Array.isArray(settings?.workspaces) ? settings.workspaces : [];
      lifecycle.ensureBots(workspaces);
    } catch (error) {
      console.warn('[project-agent] ensure bots failed:', error);
    }
  }

  function resolveConversationId(workspaceId) {
    return directory.conversationId(workspaceId);
  }

  function hasMessage(conversationId, messageId) {
    const history = conversationStore.getPersistedConversationHistory(conversationId);
    return history?.messages?.some((message) => message?.id === messageId) === true;
  }

  function appendMessage(conversationId, message) {
    conversationStore.appendMessage(conversationId, message);
    if (typeof onAppendedMessage !== 'function') return;
    try {
      onAppendedMessage({ conversationId, message });
    } catch (error) {
      console.warn('[project-agent-notifier] append hook failed:', error);
    }
  }

  function workspaceIdForConversation(conversationId) {
    const id = typeof conversationId === 'string' ? conversationId : '';
    if (!id) return '';
    for (const workspaceId of directory.workspaceIds()) {
      if (directory.conversationId(workspaceId) === id) return workspaceId;
    }
    return '';
  }

  const inputQueue = createInputQueue({
    rootDir: runtimeRoot,
    holdsLease: ownsProject,
    resolveConversationId,
    hasMessage,
    appendMessage,
  });
  host = createProjectAgentHost({
    rootDir: runtimeRoot,
    holdsLease: ownsProject,
    acquireLease: workspaceId => { if (runtimeEnabled() && profileStore.read(workspaceId)?.status === 'active') return acquireLease?.(workspaceId); },
    readMessages: conversationId => conversationStore.getPersistedConversationHistory(conversationId)?.messages || [],
    restoreQueue: workspaceId => { applyStartupApprovalRecovery({approvalStore, goalPlanStore, canRecover: row => row.workspaceId === workspaceId}); return supervisor.recoverQueue(workspaceId); },
    recoverTasks: workspaceId => goalRunner?.recoverContextCheckpoints?.({ workspaceId, deferPump: true }),
    restoreWatches:objectiveWatches.restore,stopWatches:objectiveWatches.stopWorkspace,
    activateSessions: workspaceId => supervisor.resumeRecovered(workspaceId),
    listWorkspaceIds: () => directory.workspaceIds(),
    readOwnedWorkspaceIds: ids => runtimeEnabled() ? ids.filter(id => holdsLease(id) === true) : [],
    resolveConversationId,
    hasMessage,
    appendMessage,
    inbox,
    resolveModel: (input) => agentTurnExecutor.resolveGoalRole({ ...input, projectPolicy: profileStore.read(input.workspaceId)?.modelPolicy }),
    resolveContext:({workspaceId})=>({objectives:objectiveService.list({}, {workspaceId,conversationId:resolveConversationId(workspaceId)}).items?.slice(0,16)||[],objectiveProposals:objectiveActions.list(workspaceId).filter(row=>row.mode==='proposal'&&['proposed','reserved'].includes(row.state)).slice(0,16)}),
    resolveRoster: (workspaceId) => supervisor.list({ workspaceId }),
    reconcileSessions: () => supervisor.reconcile(),
    ...createProjectLifecycleEffects({ objectiveService,profileStore, lifecycle, supervisor, conversationStore, resolveConversationId, broadcast,
      resolveEvidence: ref => readEvidenceBody(ref)?.text || '' }),
    executeTurn: (input) => {
      const history = conversationStore.getPersistedConversationHistory(input.conversationId)?.messages || [];
      const messages = projectConversationHistory(history.filter((message) => message.kind === 'user_input' || message.kind === 'agent_reply' || !message.kind && ['user', 'assistant'].includes(message.role))).messages;
      return agentTurnExecutor.runTurn({
        ...input,
        messages,
        ephemeral: true,
        ...(input.plan?.reminder ? { runtimeReminders: [input.plan.reminder] } : {}),
        workspacePath: registry.get(input.workspaceId)?.path,
      });
    },
    onCurator: (info) => memoryCurator.consider(info),
    onMaintenance: info => {
      if (ownsProject(info.workspaceId) && memoryUseEnabled({ settings: getSettings(), profile: profileStore.read(info.workspaceId) })) memoryMaintenance.runDue(info);
    },
    onStatus: (workspaceId) => {
      if (typeof broadcast === 'function') broadcast('project-agent:changed', { workspaceIds: [workspaceId] });
    },
    inputQueue,
    readSettings: getSettings,
    getWindows: () => BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()),
    readFacts: (workspaceId) => delegationFactsForWorkspace(
      (goalPlanStore.listPlans?.() || [])
        .filter(meta => conversationStore.getConversation(meta.conversationId)?.workspaceId === workspaceId)
        .map(meta => goalPlanStore.getPlan(meta.planId)).filter(Boolean),
      workspaceId,
    ),
    subscribePlans: (listener) => (
      typeof goalPlanStore?.subscribeChanges === 'function'
        ? goalPlanStore.subscribeChanges(() => { listener(); })
        : () => {}
    ),
  });
  const uninstallYield = hostLeases?.setYieldHandler?.(async (workspaceId, reason) => {
    host.drain(workspaceId);
    const sessions = supervisor.sessionsForProject(workspaceId);
    if (reason !== 'lost') for (const session of sessions) {
      if (shouldPauseForHostHandoff(goalPlanStore.getPlan(session.planId))) goalRunner.pause(session.planId, 'host_handoff');
    }
    await agentTurnExecutor.stop?.(workspaceId);
    await objectiveWatches.stopWorkspace(workspaceId);
    await Promise.allSettled(sessions.map(session => goalRunner.waitForIdle?.(session.planId)));
  });
  objectiveWatches.start(()=>directory.workspaceIds());
  const projectAgent = createProjectAgentApplicationService({
    enabled: runtimeEnabled,
    requestTakeover: workspaceId => {
      const result = hostLeases?.requestTakeover?.(workspaceId);
      if (!result) return { reason: 'invalid' };
      if (result.reason === 'free' && acquireLease?.(workspaceId)?.acquired !== true) return { reason: 'invalid' };
      void host.sync([workspaceId]).catch(() => {});
      return result;
    },
    directory,
    lifecycle,
    profileStore,
    inputQueue,
    sessions: supervisor,
    listModels,
    retryTurn: async ({ workspaceId, turnId }) => {
      if (holdsLease(workspaceId) !== true) return { ok: false, code: 'HOST_OFFLINE' };
      const conversationId = resolveConversationId(workspaceId);
      const messages = conversationStore.getPersistedConversationHistory(conversationId)?.messages || [];
      const card = messages.find((message) => message.turnId === turnId && message.card === 'agent_unavailable');
      if (!card) return { ok: false, code: 'NOT_FOUND' };
      if (projectFacts.cards(workspaceId).find((item) => item.cardId === `card:agent_unavailable:${turnId}`)?.resolvedState === 'resolved') return { ok: true, replayed: true };
      const later = messages.slice(messages.indexOf(card) + 1);
      if (later.some((message) => message.kind === 'agent_turn')) return { ok: false, code: 'STALE_TURN' };
      const runner = host.runnerFor(workspaceId);
      if (runner?.parked()) await runner.retry();
      else {
        const turn = messages.find((message) => message.id === turnId && message.kind === 'agent_turn');
        await host.sync([workspaceId]);
        const restored = host.runnerFor(workspaceId);
        if (!restored) return { ok: false, code: 'RECOVERY_FAILED' };
        if (restored.parked()) await restored.retry();
        else if (turn?.userInputs?.length) await restored.enqueueUserInputs(turn.userInputs);
        else await restored.retry();
      }
      if (host.runnerFor(workspaceId)?.status() === 'error') return { ok: false, code: 'TURN_FAILED' };
      projectFacts.resolve(workspaceId, card.cards?.[0]?.cardId || `card:agent_unavailable:${turnId}`);
      return { ok: true };
    },
    approvals: approvalStore,
    readEvidenceBody,
    bindWorkspace: (sender) => workspace.addWorkspace(sender),
    rememberWorkspace({ workspaceId, path: folder, name }) {
      const settings = getSettings() || {};
      const workspaces = Array.isArray(settings.workspaces) ? [...settings.workspaces] : [];
      if (workspaces.some((item) => item?.path === folder || item?.id === workspaceId)) return;
      mergeSettings({
        workspaces: [...workspaces, {
          id: workspaceId,
          path: folder,
          name,
          addedAt: new Date().toISOString(),
          linkedFolders: [],
        }],
        activeWorkspace: folder,
      });
    },
    createManaged: (name) => createManagedFolder({
      name,
      managedRoot: getSettings()?.projectAgent?.managedRoot || null,
      registry,
    }),
    chooseAvatar: async (sender) => {
      const parent = sender ? BrowserWindow.fromWebContents(sender) : undefined;
      const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
        title: '选择头像',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      return canceled ? null : (filePaths?.[0] ?? null);
    },
    wake: (workspaceId) => {
      void host.sync([workspaceId]).catch(() => {});
    },
    agentOnline: (workspaceId) => typeof holdsLease === 'function' && holdsLease(workspaceId) === true,
    readAgentStatus: (workspaceId) => host.runnerFor(workspaceId)?.status(),
    onViewing,
    broadcast,
    conversationStore,
    goalPlanStore,
    readSearchCorpus(catalog) {
      const bots = Array.isArray(catalog) ? catalog : (typeof directory.list === 'function' ? directory.list() : []);
      const messages = [];
      for (const bot of bots) {
        const workspaceId = bot.workspaceId;
        const conversationId = bot.profile?.agentConversationId;
        if (!conversationId) continue;
        let history = [];
        try {
          history = conversationStore.getPersistedConversationHistory(conversationId)?.messages || [];
        } catch {
          history = [];
        }
        for (const message of history) messages.push({ workspaceId, message });
      }
      const tasks = [];
      try {
        const plans = typeof goalPlanStore?.listPlans === 'function' ? goalPlanStore.listPlans() : [];
        for (const plan of Array.isArray(plans) ? plans : []) {
          const origin = plan?.delegationOrigin;
          const title = typeof plan?.title === 'string' ? plan.title.trim() : '';
          if (!origin?.workspaceId || !origin?.sessionId || !title) continue;
          tasks.push({
            workspaceId: origin.workspaceId,
            sessionId: origin.sessionId,
            title,
            updatedAt: typeof plan.updatedAt === 'string' ? plan.updatedAt : '',
          });
        }
      } catch {
        // 计划读失败时搜索仍返回机器人和消息。
      }
      let memories = [];
      try {
        memories = (memoryStore.list({ status: 'active' }) || []).filter(item => isEffectiveMemory(item));
      } catch {
        memories = [];
      }
      return { bots, messages, tasks, memories };
    },
    corpusStamp() {
      const parts = [];
      const ids = typeof directory.workspaceIds === 'function' ? directory.workspaceIds() : [];
      for (const workspaceId of ids) {
        const conversationId = directory.conversationId(workspaceId);
        if (conversationId) parts.push(fileStamp(path.join(dataHome, 'conversations', `${conversationId}.jsonl`)));
        parts.push(fileStamp(path.join(dataHome, 'projects', workspaceId, 'profile.json')));
        if (typeof memoryStore.projectFile === 'function') parts.push(fileStamp(memoryStore.projectFile(workspaceId)));
      }
      if (typeof memoryStore.userFile === 'function') parts.push(fileStamp(memoryStore.userFile()));
      parts.push(fileStamp(path.join(dataHome, 'goal-plans', 'index.jsonl')));
      parts.push(fileStamp(path.join(dataHome, 'goal-plans', '.changes.jsonl')));
      return parts.join('|');
    },
  });
  if (typeof onReady === 'function') {
    onReady({
      projectAccess: {directory,inputQueue,getSession:sessionId=>supervisor.get({sessionId,detail:'report'}),
        wake:workspaceId=>{void host.sync([workspaceId]).catch(()=>{});}},
      listItems: () => directory.list(),
      submitInput: (input) => {
        try {
          const saved = inputQueue.submitInput(input);
          void host.sync([saved.workspaceId]).catch(() => {});
          return saved;
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      },
      botName: (workspaceId) => {
        const got = directory.get(workspaceId);
        if (!got?.ok) return '';
        return got.profile?.displayName || got.item?.profile?.displayName || '';
      },
      workspaceIdForConversation,
      host,
      supervisor,
      objectives,
      objectiveWatches,
      dispose: () => { uninstallYield?.(); host.dispose();void objectiveWatches.dispose(); uninstallDelegation(); uninstallVerification(); uninstallDelivery(); uninstallProactivity(); uninstallMemory(); },
    });
  }
  const memory = createProjectMemoryService({
    store: memoryStore,
    onChanged: memoryChanged,
    profileStore,
    getSettings: typeof getSettings === 'function' ? getSettings : () => ({}),
    mergeSettings: typeof mergeSettings === 'function' ? mergeSettings : () => {},
    showSaveDialog: async (options) => {
      if (!dialog || typeof dialog.showSaveDialog !== 'function') return { canceled: true };
      const parent = typeof BrowserWindow?.getFocusedWindow === 'function'
        ? BrowserWindow.getFocusedWindow() ?? undefined
        : undefined;
      return dialog.showSaveDialog(parent, options);
    },
  });
  return [
    ...createProjectAgentIpcRegistrations({ projectAgent }),
    ...createProjectMemoryIpcRegistrations({ memory }),
    ...createProjectObjectivesIpcRegistrations({ objectives }),
  ];
}

function readRegisteredArtifact(dataHome, ref, record) {
  if (typeof ref !== 'string' || !/^local-(?:shell|browser)-artifact:\/\//.test(ref)) return '';
  const target = resolveArtifactOpenPath(ref, {
    shell: path.join(dataHome, 'shell-artifacts'),
    browser: path.join(dataHome, 'browser-artifacts'),
  }, record?.createdAt);
  if (!target) return '';
  try {
    if (statSync(target).isDirectory() || /\.(png|jpe?g|webp|gif)$/i.test(target)) return ref;
    return readFileSync(target, 'utf8');
  } catch {
    return '';
  }
}
