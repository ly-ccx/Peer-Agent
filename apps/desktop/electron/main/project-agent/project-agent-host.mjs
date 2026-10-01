import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { projectConversationHistory } from '@peer-agent/runtime-core';

import {
  createApprovalStore,
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
  projectClassicGoals,
  projectHistory,
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
import { createManagedFolder } from './managed-folder.mjs';
import { evidenceBodyFromRecord } from './evidence-presenter.mjs';
import { readProjectInstructionLines } from './project-instruction-lines.mjs';
import { createProjectAgentIpcRegistrations } from '../ipc/register-project-agent-ipc.mjs';
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
export function createProjectAgentHost({
  rootDir = null,
  holdsLease = () => false,
  listWorkspaceIds = () => [],
  resolveConversationId = () => '',
  hasMessage = () => false,
  appendMessage = () => {},
  executeTurn,
  resolveModel = null,
  resolveContext = null,
  resolveRoster = null,
  onReplied = null,
  onInputsConsumed = null,
  routing = null,
  getWindows = () => [],
  now,
  retryDelays,
  onCurator = null,
  onMaintenance = null,
  onStatus = null,
  inbox = null,
  inputQueue = null,
  readSettings = null,
  digestQueue = null,
  schedule = null,
  clearSchedule = null,
  readFacts = null,
  subscribePlans = null,
  reconcileSessions = null,
  restoreQueue = null,
  recoverTasks = null,
  activateSessions = null,
  acquireLease = null,
  readMessages = null,
  onRecoveryPhase = null,
} = {}) {
  if (typeof executeTurn !== 'function') {
    throw new TypeError('ProjectAgentHost requires executeTurn');
  }
  const inboxStore = inbox || createProjectInbox({ rootDir, now });
  const queue = inputQueue || createInputQueue({
    rootDir,
    now,
    holdsLease,
    resolveConversationId,
    hasMessage,
    appendMessage,
  });
  const runners = new Map();
  const stagedInputs = new Map();
  const stoppedWorkspaces = new Set();
  const digests = digestQueue || createDigestQueue({
    file: rootDir ? path.join(rootDir, 'digest-queue.json') : null,
  });

  function resolveTurnModel(workspaceId, conversationId) {
    if (typeof resolveModel === 'function') {
      return resolveModel({ workspaceId, conversationId, role: 'project_agent' });
    }
    return resolveRoleRoute({
      role: 'project_agent',
      providers: routing?.providers,
      routing: routing?.routing,
      projectPolicy: routing?.projectPolicy,
      spentUsd: routing?.spentUsd,
    });
  }

  const watch = typeof readFacts === 'function' ? createWatchPublisher({ now }) : null;

  function drop(workspaceId) {
    recovery.drop(workspaceId);
    const runner = runners.get(workspaceId);
    if (!runner) return;
    runner.dispose();
    runners.delete(workspaceId);
  }

  function publishWatch(workspaceId) {
    if (!watch) return [];
    let facts = { sessions: [] };
    try {
      facts = readFacts(workspaceId) || { sessions: [] };
    } catch {
      return [];
    }
    const events = watch.publish(workspaceId, facts);
    if (events.length === 0) return [];
    const saved = inboxStore.append(workspaceId, events);
    return Array.isArray(saved?.appended) ? saved.appended : [];
  }

  function ensureRunner(workspaceId, conversationId) {
    const existing = runners.get(workspaceId);
    if (existing && existing.conversationId === conversationId) return existing;
    if (existing) drop(workspaceId);
    const runner = createProjectAgentRunner({
      workspaceId,
      conversationId,
      inbox: inboxStore,
      holdsLease: () => recovery.isReady(workspaceId),
      circuitBreaker: createCircuitBreaker({ rootDir, workspaceId, ...(now ? { now } : {}) }),
      onInputsCompleted: inputs => queue.completeExecution?.(workspaceId, inputs.map(input => input.inputId)),
      executeTurn,
      appendMessage,
      readMessages: () => typeof readMessages === 'function' ? readMessages(conversationId) : [],
      resolveModel: () => resolveTurnModel(workspaceId, conversationId),
      resolveContext: (info) => (
        typeof resolveContext === 'function'
          ? resolveContext({ ...info, workspaceId, conversationId })
          : null
      ),
      resolveRoster: () => typeof resolveRoster === 'function' ? resolveRoster(workspaceId) : null,
      onReplied: typeof onReplied === 'function' ? (message) => onReplied(workspaceId, message) : null,
      sink: createBroadcastSink({ getWindows }),
      now,
      retryDelays,
      onDigest: (item) => digests.hold(workspaceId, item),
      onDigestDelivered: (message) => {
        const date = message?.meta?.digestDate;
        if (typeof date === 'string') digests.acknowledge(workspaceId, date);
      },
      onCurator: typeof onCurator === 'function'
        ? (info) => onCurator({ ...info, workspaceId })
        : null,
      onStatus: typeof onStatus === 'function'
        ? (status) => onStatus(workspaceId, status)
        : null,
    });
    runners.set(workspaceId, runner);
    return runner;
  }

  const recovery = createProjectRecovery({ rootDir, holdsLease, ...(now ? { now } : {}), onPhase: onRecoveryPhase,
    ports: {
      lease(workspaceId) {
        if (!holdsLease(workspaceId) && typeof acquireLease === 'function') acquireLease(workspaceId);
        if (holdsLease(workspaceId) !== true) throw new Error('lease_unavailable');
      },
      async inputs(workspaceId) {
        const conversationId = resolveConversationId(workspaceId);
        if (!conversationId) throw new Error('conversation_unavailable');
        ensureRunner(workspaceId, conversationId);
        stagedInputs.set(workspaceId, await consumeInputs(workspaceId));
      },
      inbox: workspaceId => inboxStore.takeBatch(workspaceId),
      queue: workspaceId => typeof restoreQueue === 'function' ? restoreQueue(workspaceId) : undefined,
      tasks: workspaceId => typeof recoverTasks === 'function' ? recoverTasks(workspaceId) : undefined,
      watch: workspaceId => publishWatch(workspaceId),
      digest: workspaceId => armDigest(runners.get(workspaceId), workspaceId),
    },
  });

  async function consumeInputs(workspaceId) {
    const consumed = queue.consume(workspaceId);
    if (consumed.skipped) throw new Error(consumed.skipped);
    if (consumed.consumed?.length && typeof onInputsConsumed === 'function') await onInputsConsumed(workspaceId, consumed.consumed);
    return consumed.consumed || [];
  }

  function pendingInputs(workspaceId, conversationId, consumed) {
    if (typeof queue.pendingExecution !== 'function') return consumed;
    const messages = typeof readMessages === 'function' ? readMessages(conversationId) : [];
    const repliedTo = messages.filter(message => message.role === 'assistant' && message.kind === 'agent_reply').flatMap(message => message.replyTo || message.meta?.replyTo || []);
    return queue.pendingExecution(workspaceId, { repliedTo });
  }

  async function sync(workspaceIds) {
    const listed = Array.isArray(workspaceIds) ? workspaceIds : listWorkspaceIds();
    const wanted = [...new Set(listed)].filter(workspaceId => typeof workspaceId === 'string' && !stoppedWorkspaces.has(workspaceId) && resolveConversationId(workspaceId));
    const wantedIds = new Set(wanted);
    for (const workspaceId of runners.keys()) if (!wantedIds.has(workspaceId) || !holdsLease(workspaceId)) drop(workspaceId);
    const outcomes = await Promise.all(wanted.map(async workspaceId => {
      if (!holdsLease(workspaceId) && typeof acquireLease !== 'function') return { workspaceId, skipped: 'not-host' };
      const recovered = await recovery.recover(workspaceId);
      if (!recovered.ok) return { workspaceId, ...recovered };
      try {
        if (!recovered.reused && typeof activateSessions === 'function') await activateSessions(workspaceId);
        const conversationId = resolveConversationId(workspaceId), runner = ensureRunner(workspaceId, conversationId);
        const consumed = [...(stagedInputs.get(workspaceId) || []), ...await consumeInputs(workspaceId)];
        stagedInputs.delete(workspaceId);
        const pending = pendingInputs(workspaceId, conversationId, consumed);
        const due = armDigest(runner, workspaceId);
        publishWatch(workspaceId);
        if (pending.length) await runner.enqueueUserInputs(pending);
        else if (due || runner.parked() || inboxStore.takeBatch(workspaceId).events.length > 0) await runner.kick();
        return { workspaceId, ok: true };
      } catch (error) { drop(workspaceId); try { recovery.fail(workspaceId, error); } catch { /* Returned failure still identifies the project. */ } return { workspaceId, ok: false, error: error?.message || String(error) }; }
    }));
    return { workspaces: outcomes.filter(item => item.ok).map(item => item.workspaceId), outcomes };
  }

  function armDigest(runner, workspaceId) {
    if (typeof readSettings !== 'function') return false;
    const settings = normalizeProjectAgentSettings(readSettings()?.projectAgent);
    const at = typeof now === 'function' ? now() : new Date();
    if (typeof onMaintenance === 'function') onMaintenance({ workspaceId, at, digestTime: settings.digestTime });
    const due = digests.consider(workspaceId, at, settings.digestTime);
    if (!due?.timer) return false;
    const queued = runner.enqueueTimer(due.timer);
    return queued?.queued === true;
  }

  async function deliverDigests() {
    await sync();
    const settings = normalizeProjectAgentSettings(
      typeof readSettings === 'function' ? readSettings()?.projectAgent : null,
    );
    const at = typeof now === 'function' ? now() : new Date();
    const listed = listWorkspaceIds();
    const seen = new Set();
    const runs = [];
    for (const workspaceId of listed) {
      if (typeof workspaceId !== 'string' || seen.has(workspaceId)) continue;
      seen.add(workspaceId);
      if (!recovery.isReady(workspaceId)) continue;
      const conversationId = resolveConversationId(workspaceId);
      if (typeof conversationId !== 'string' || !conversationId.trim()) continue;
      const preview = digests.consider(workspaceId, at, settings.digestTime);
      if (!preview?.timer && !runners.has(workspaceId)) continue;
      const runner = ensureRunner(workspaceId, conversationId.trim());
      const due = armDigest(runner, workspaceId);
      const waiting = runner.mailbox().timers.some((timer) => timer?.kind === 'digest_due' && timer.wake === true);
      if (due || waiting) runs.push(runner.kick());
    }
    await Promise.all(runs);
  }

  const useSchedule = typeof schedule === 'function' ? schedule : setTimeout;
  const useClearSchedule = typeof clearSchedule === 'function' ? clearSchedule : clearTimeout;
  let digestHandle = null;
  let watchHandle = null;
  let watchSoonHandle = null;
  let hostDisposed = false;
  let unsubscribePlans = () => {};

  function clearDigestHandle() {
    if (digestHandle == null) return;
    useClearSchedule(digestHandle);
    digestHandle = null;
  }

  function nextDigestDelay() {
    const settings = normalizeProjectAgentSettings(
      typeof readSettings === 'function' ? readSettings()?.projectAgent : null,
    );
    const at = typeof now === 'function' ? now() : new Date();
    const date = at instanceof Date ? new Date(at.getTime()) : new Date(at);
    if (Number.isNaN(date.getTime())) return 60_000;
    const [hour, minute] = settings.digestTime.split(':').map((part) => Number(part));
    const next = new Date(date);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= date.getTime()) next.setDate(next.getDate() + 1);
    return Math.max(1000, next.getTime() - date.getTime());
  }

  function planDigestClock(delay) {
    clearDigestHandle();
    if (hostDisposed || typeof readSettings !== 'function') return;
    digestHandle = useSchedule(() => {
      digestHandle = null;
      return Promise.resolve()
        .then(() => deliverDigests())
        .catch(() => {})
        .finally(() => {
          if (!hostDisposed) planDigestClock(nextDigestDelay());
        });
    }, delay);
  }

  if (typeof readSettings === 'function') planDigestClock(0);

  function clearWatchHandle() {
    if (watchHandle == null) return;
    useClearSchedule(watchHandle);
    watchHandle = null;
  }

  function clearWatchSoon() {
    if (watchSoonHandle == null) return;
    useClearSchedule(watchSoonHandle);
    watchSoonHandle = null;
  }

  async function sweepWatch() {
    if (!watch || hostDisposed) return 30_000;
    await sync();
    if (typeof reconcileSessions === 'function') await reconcileSessions();
    const at = typeof now === 'function' ? now() : new Date();
    const atIso = at instanceof Date ? at.toISOString() : (typeof at === 'string' ? at : new Date().toISOString());
    let delay = 30_000;
    for (const workspaceId of listWorkspaceIds()) if (recovery.isReady(workspaceId)) delay = Math.min(delay, watch.nextDelay(workspaceId, atIso));
    return delay;
  }

  function planWatchClock(delay) {
    clearWatchHandle();
    if (hostDisposed || !watch) return;
    watchHandle = useSchedule(() => {
      watchHandle = null;
      return Promise.resolve()
        .then(() => sweepWatch())
        .then((next) => {
          if (!hostDisposed) planWatchClock(next);
        })
        .catch(() => {
          if (!hostDisposed) planWatchClock(30_000);
        });
    }, delay);
  }

  function scheduleSweepSoon() {
    if (hostDisposed || !watch || watchSoonHandle != null) return;
    watchSoonHandle = useSchedule(() => {
      watchSoonHandle = null;
      return Promise.resolve()
        .then(() => sweepWatch())
        .then((next) => {
          if (!hostDisposed) planWatchClock(next);
        })
        .catch(() => {});
    }, 1000);
  }

  if (watch) {
    if (typeof subscribePlans === 'function') {
      try {
        const unsubscribe = subscribePlans(() => { scheduleSweepSoon(); });
        if (typeof unsubscribe === 'function') unsubscribePlans = unsubscribe;
      } catch {
        unsubscribePlans = () => {};
      }
    }
    planWatchClock(0);
  }

  function dispose() {
    hostDisposed = true;
    clearDigestHandle();
    clearWatchHandle();
    clearWatchSoon();
    try { unsubscribePlans(); } catch { /* 订阅已经结束 */ }
    for (const workspaceId of [...runners.keys()]) drop(workspaceId);
  }

  return {
    sync,
    dispose,
    stop(workspaceId) { stoppedWorkspaces.add(workspaceId); drop(workspaceId); },
    restart(workspaceId) { stoppedWorkspaces.delete(workspaceId); return sync([workspaceId]); },
    isReady: recovery.isReady,
    recovery,
    runnerFor: (workspaceId) => runners.get(workspaceId) ?? null,
    inbox: inboxStore,
    inputQueue: queue,
  };
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
  const runtimeEnabled = () => enabled() && getSettings()?.projectAgent?.shell !== 'classic';
  const ownsProject = workspaceId => runtimeEnabled() && profileStore.read(workspaceId)?.status === 'active' && holdsLease(workspaceId) === true;
  const executionScheduler = agentTurnExecutor.executionScheduler ?? goalRunner?.executionScheduler ?? createExecutionScheduler();
  executionScheduler.configure({ rootDir: runtimeRoot, getConcurrency: () => getSettings()?.projectAgent?.concurrency, isWorkspaceReady: workspaceId => host?.isReady(workspaceId) === true });
  function readEvidenceBody(evidenceRef) {
    try {
      const record = goalPlanStore.findEvidenceIndexRecords?.([evidenceRef])?.[0];
      if (!record) return null;
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
  const supervisor = createSessionSupervisor({
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
    resolveAcceptancePolicy: (workspaceId) => profileStore.read(workspaceId)?.acceptancePolicy,
    readSessionFacts: (plan) => ({ autoHandoffOnPolicyAccept: profileStore.read(plan.delegationOrigin.workspaceId)?.autoHandoffOnPolicyAccept === true, hostAuthority: {
      ...(verification.facts(plan.delegationOrigin.sessionId) || {}),
      ...(typeof readUiDelivery === 'function' ? { uiDeliveryRequired: readUiDelivery(plan)?.required === true, uiDelivery: readUiDelivery(plan) } : {}),
    } }),
    emitEvent: (event) => inbox.append(event.workspaceId, [{ ...event, eventId: `supervisor:${event.kind}:${event.sessionId}:${event.verdictRef || event.anchorMessageId || event.supersededBy || event.reason || ''}` }]),
    readPlanApproval: (workspaceId) => profileStore.read(workspaceId)?.planApproval,
  });
  const uninstallDelegation = installDelegation({ supervisor, storeDir: runtimeRoot });
  const uninstallVerification = installSessionVerification(verification);
  const projectFacts = createDesktopProjectFacts({ supervisor, approvalStore, profileStore, conversationStore, runtimeRoot, memoryStore });
  const uninstallDelivery = installDeliveryFacts({
    read(view) {
      const settings = normalizeProjectAgentSettings(getSettings()?.projectAgent);
      const level = profileStore.read(view?.workspaceId)?.proactivity;
      return {
        ...projectFacts.delivery(view?.workspaceId),
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
    listClassicGoals(workspaceId) {
      try {
        const folder = typeof registry?.get === 'function' ? (registry.get(workspaceId)?.path || '') : '';
        if (!folder || typeof conversationStore?.listConversations !== 'function') return [];
        const conversations = conversationStore.listConversations() || [];
        const history = projectHistory(Array.isArray(conversations) ? conversations : [], { workspacePath: folder });
        const plans = typeof goalPlanStore?.listPlans === 'function' ? goalPlanStore.listPlans() : [];
        return projectClassicGoals(Array.isArray(plans) ? plans : [], {
          workspacePath: folder,
          conversationIds: history.map((item) => item.id),
        });
      } catch {
        return [];
      }
    },
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
    restoreQueue: workspaceId => supervisor.recoverQueue(workspaceId),
    recoverTasks: workspaceId => goalRunner?.recoverContextCheckpoints?.({ workspaceId, deferPump: true }),
    activateSessions: workspaceId => supervisor.resumeRecovered(workspaceId),
    listWorkspaceIds: () => directory.workspaceIds(),
    resolveConversationId,
    hasMessage,
    appendMessage,
    inbox,
    resolveModel: (input) => agentTurnExecutor.resolveGoalRole({ ...input, projectPolicy: profileStore.read(input.workspaceId)?.modelPolicy }),
    resolveRoster: (workspaceId) => supervisor.list({ workspaceId }),
    reconcileSessions: () => supervisor.reconcile(),
    ...createProjectLifecycleEffects({ profileStore, lifecycle, supervisor, conversationStore, resolveConversationId, broadcast,
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
  const projectAgent = createProjectAgentApplicationService({
    enabled: runtimeEnabled,
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
    readSearchCorpus() {
      const bots = typeof directory.list === 'function' ? directory.list() : [];
      const messages = [];
      for (const workspaceId of directory.workspaceIds()) {
        const conversationId = directory.conversationId(workspaceId);
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
      dispose: () => { host.dispose(); uninstallDelegation(); uninstallVerification(); uninstallDelivery(); uninstallProactivity(); uninstallMemory(); },
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
