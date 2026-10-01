import path from 'node:path';
import { createProjectInbox } from './project-inbox.mjs';
import { createInputQueue } from './input-queue.mjs';
import { createProjectAgentRunner } from './runner.mjs';
import { createProjectRecovery } from './recovery.mjs';
import { createCircuitBreaker } from './circuit-breaker.mjs';
import { createDigestQueue } from './digest.mjs';
import { createWatchPublisher } from './watch-publisher.mjs';
import { normalizeProjectAgentSettings } from './digest.mjs';
import { resolveRoleRoute } from '../model-router.mjs';

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
  createSink = () => ({ send() {} }),
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
  restoreWatches = null,
  stopWatches = null,
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
    if(typeof stopWatches==='function')void stopWatches(workspaceId);
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
      sink: createSink(),
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
      watch: async workspaceId => {if(typeof restoreWatches==='function')await restoreWatches(workspaceId);return publishWatch(workspaceId);},
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
    drain: drop,
    stop(workspaceId) { stoppedWorkspaces.add(workspaceId); drop(workspaceId); },
    restart(workspaceId) { stoppedWorkspaces.delete(workspaceId); return sync([workspaceId]); },
    isReady: recovery.isReady,
    recovery,
    runnerFor: (workspaceId) => runners.get(workspaceId) ?? null,
    inbox: inboxStore,
    inputQueue: queue,
  };
}
