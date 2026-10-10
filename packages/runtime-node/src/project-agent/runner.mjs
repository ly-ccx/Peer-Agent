import { createRunnerCoordination } from './runner-coordination.mjs';
import { randomUUID } from 'node:crypto';
import { classifyProjectAgentFailure, projectAgentFailureKind } from '@peer-agent/protocol';
import { acceptedReplyResult, agentTurnMessage, finishAgentTurn, planAgentTurn, unavailableCard } from './agent-turn-plan.mjs';
import { createTurnActivity } from './turn-activity.mjs';
import { readRetryContinuity } from './retry-continuity.mjs';

/**
 * 与桌面 llm-chat-service 的同提供方重试退避一致（ADR 30）：
 * 首次之外再试 3 次。这里只在 executeTurn 显式返回 retryable 时使用。
 * 生产 sendMessage 已经在内部做过这组重试，适配层应返回 retryable: false，避免再乘一层。
 */
export const SAME_PROVIDER_RETRY_DELAYS_MS = Object.freeze([500, 1_500, 3_000]);

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * 每个项目一个单线程代理。用户输入开用户回合，收件箱开唤醒回合。
 * 用户输入会在下一处安全点中止唤醒；用户回合本身不抢占。
 * 一轮 executeTurn 是一次模型会话。只有 `continued === true` 且本轮有工具调用、
 * 还没有 post_reply、也没到预算时，才开始下一轮。
 */
export function createProjectAgentRunner({
  workspaceId,
  conversationId,
  inbox,
  holdsLease = () => true,
  executeTurn,
  appendMessage,
  readMessages = () => [],
  resolveModel = () => ({ ok: false, missing: '没有可用的模型' }),
  resolveContext = () => null,
  resolveRoster = () => null,
  sink = null,
  now = () => new Date().toISOString(),
  retryDelays = SAME_PROVIDER_RETRY_DELAYS_MS,
  onStatus = null,
  onDigest = null,
  onDigestDelivered = null,
  onCurator = null,
  onReplied = null,
  coordinationStore = null,
  circuitBreaker = null,
  onInputsCompleted = null,
  onActivity = null,
  schedule = setTimeout,
  clearSchedule = clearTimeout,
} = {}) {
  const workspace = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  const conversation = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!WORKSPACE_ID.test(workspace)) throw new TypeError('workspaceId is invalid');
  if (!conversation) throw new TypeError('conversationId is required');
  if (!inbox || typeof inbox.takeBatch !== 'function' || typeof inbox.commitBatch !== 'function') {
    throw new TypeError('ProjectAgentRunner requires an inbox');
  }
  if (typeof executeTurn !== 'function') throw new TypeError('ProjectAgentRunner requires executeTurn');
  if (typeof appendMessage !== 'function') throw new TypeError('ProjectAgentRunner requires appendMessage');

  const delays = Object.freeze(
    (Array.isArray(retryDelays) ? retryDelays : SAME_PROVIDER_RETRY_DELAYS_MS)
      .map((value) => (Number.isFinite(value) && value >= 0 ? value : 0)),
  );
  const turnSink = sink && typeof sink.send === 'function' ? sink : { send() {} };
  const activity = createTurnActivity({ workspaceId: workspace, conversationId: conversation, publish: onActivity, now: stamp });
  let stoppedJob = null;

  const userInputs = [];
  const knownInputs = new Set();
  let manualTrial = false;
  const timers = [];
  /** @type {Array<{ events: object[], throughSeq: number }>} */
  const preempted = [];
  let failedJob = null;
  let retryArmed = false;
  let pumping = null;
  let disposed = false;
  let turnKind = null;
  let acceptingStop = false;
  let abortController = null;
  let statusValue = 'idle';
  let curatorFlight = null;
  let curatorTimer = null;
  let recoveryTimer = null;
  let recoveryTimerAt = null;
  const manualJobs = [];
  const executedManualJobs = new WeakMap();
  const pendingLearned = [];

  function setStatus(next) {
    if (statusValue === next) return;
    statusValue = next;
    if (typeof onStatus === 'function') onStatus(next);
  }

  function stamp() {
    const value = now();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string' && value.trim()) return value.trim();
    return new Date().toISOString();
  }

  function remember(message) {
    if (!readMessages().some(row => row.id === message.id)) return appendMessage(conversation, { ...message, createdAt: stamp() });
  }

  const coordination = coordinationStore ? createRunnerCoordination({ store: coordinationStore, inbox,
    workspaceId: workspace, conversationId: conversation, readMessages, remember, onReplied, resolveRoster, now: stamp }) : null;

  function armRecoveryTimer() {
    const at = !disposed && holdsLease() === true ? coordination?.nextRetryAt() : null;
    if (at === recoveryTimerAt && recoveryTimer !== null) return;
    if (recoveryTimer !== null) clearSchedule(recoveryTimer);
    recoveryTimer = null; recoveryTimerAt = at || null;
    if (!at) return;
    recoveryTimer = schedule(() => {
      recoveryTimer = null; recoveryTimerAt = null;
      return kick();
    }, Math.max(0, Date.parse(at) - Date.parse(stamp())));
    recoveryTimer?.unref?.();
  }

  function commit(throughSeq) {
    if (!Number.isInteger(throughSeq) || throughSeq <= 0) return;
    inbox.commitBatch(workspace, { throughSeq, ok: true });
  }

  function restoreCircuitCard() {
    const state = circuitBreaker?.state();
    if (!state || state.status === 'closed' || !state.lastTurnId) return;
    const messages = readMessages() || [], turnId = state.lastTurnId;
    if (!messages.some(message => message.id === turnId)) {
      const plan = planAgentTurn({ kind: state.retry?.kind || 'wake', userInputs: state.retry?.userInputs || [], workspaceId: workspace });
      remember(agentTurnMessage({ turnId, plan }));
    }
    if (!messages.some(message => message.id === `${turnId}-card`)) {
      const card = unavailableCard(turnId, state.reason, workspace);
      card.content = '代理连续失败，已暂停自动推进。十分钟后再试，也可以现在手动重试。';
      card.meta = { circuitOpenUntil: state.openUntil };
      for (const item of card.cards || []) item.content = card.content;
      remember(card);
    }
  }

  function takeNext() {
    if (!coordination && retryArmed && failedJob) {
      retryArmed = false;
      const job = failedJob;
      failedJob = null;
      if (job.kind === 'wake' && userInputs.length > 0) {
        preempted.push({ events: job.events, throughSeq: job.throughSeq });
      } else {
        return job;
      }
    }
    if (userInputs.length > 0) {
      const inputs = userInputs.splice(0, coordination ? 1 : userInputs.length);
      const carried = preempted.splice(0, preempted.length);
      const throughSeq = carried.reduce((max, item) => Math.max(max, item.throughSeq || 0), 0);
      return {
        kind: 'user',
        userInputs: inputs,
        events: carried.flatMap((item) => item.events || []),
        throughSeq,
        carried,
      };
    }
    if (manualJobs.length) return manualJobs.shift();
    const digest = takeDigestTimer();
    if (digest) return digest;
    const batch = inbox.takeBatch(workspace);
    const events = coordination ? coordination.pending() : Array.isArray(batch?.events) ? batch.events : [];
    if (events.length === 0) return coordination?.recoverJob() || null;
    return {
      kind: 'wake',
      userInputs: [],
      events,
      throughSeq: Number.isInteger(batch.throughSeq) ? batch.throughSeq : 0,
      carried: [],
    };
  }

  function kick() {
    if (disposed) return Promise.resolve({ skipped: 'disposed' });
    if (holdsLease() !== true) return Promise.resolve({ skipped: 'not-host' });
    if (coordination) {
      const pending = coordination.transfer();
      if (failedJob && pending.some(event => !(failedJob.events || []).some(old => old.eventId === event.eventId))) failedJob = null;
    }
    if (!coordination && failedJob && !retryArmed) {
      if (failedJob.budgetExhausted || failedJob.explicitRetryOnly) return Promise.resolve({ skipped: 'error' });
      const state = circuitBreaker?.state();
      if (state && state.status !== 'closed' && Date.parse(stamp()) >= Date.parse(state.openUntil)) retryArmed = true;
      else return Promise.resolve({ skipped: 'error' });
    }
    if (!pumping) pumping = pump().finally(() => {
      pumping = null; armRecoveryTimer();
      // A status callback can enqueue after pump observed an empty mailbox.
      // Re-admit only concrete inputs or manual jobs, never a stale continuation.
      if (!disposed && holdsLease() === true && (userInputs.length || manualJobs.length)
        && !coordination?.hasPendingDelivery() && (coordination || !failedJob || retryArmed)) return kick();
    });
    return pumping;
  }

  async function pump() {
    if (coordination) { try { await coordination.recover(); } catch { /* prepared delivery remains retryable */ } }
    if (coordination?.hasPendingDelivery()) { setStatus('idle'); return; }
    let drained = false;
    while (!disposed) {
      if (holdsLease() !== true) {
        setStatus(failedJob ? 'error' : 'idle');
        return;
      }
      if (!coordination && failedJob && !retryArmed) {
        setStatus('error');
        return;
      }
      const job = takeNext();
      if (!job) {
        if (!drained) {
          drained = true;
          await drainCurator();
          continue;
        }
        setStatus(failedJob ? 'error' : 'idle');
        return;
      }
      drained = false;
      let outcome;
      try { outcome = await runJob(job); } catch (error) {
        circuitBreaker?.failure({ turnId: job.turnId || `failed-${randomUUID()}`, reason: error?.message || String(error), retry: { kind: job.kind, userInputs: job.userInputs } });
        outcome = 'error';
      }
      if (outcome === 'yielded') { setStatus('idle'); return; }
      if (outcome === 'disposed') return;
      if (outcome === 'error' || outcome === 'circuit_open' || outcome === 'exhausted') {
        if (outcome === 'exhausted') job.budgetExhausted = true;
        failedJob = job;
        setStatus('error');
        return;
      }
    }
  }

  async function runJob(job) {
    if (coordination && !coordination.prepare(job)) return 'preempted';
    if (job.kind !== 'digest') {
      const admitted = circuitBreaker?.admit({ manual: manualTrial });
      manualTrial = false;
      if (admitted?.allowed === false) { coordination?.blockReservation(job); restoreCircuitCard(); return 'circuit_open'; }
    }
    const controller = new AbortController();
    abortController = controller;
    turnKind = job.kind; acceptingStop = job.kind === 'user' || job.interactive === true;
    const signal = controller.signal;
    setStatus('thinking');
    try {
      if (job.kind === 'digest') {
        if (job.message) remember(job.message);
        if (job.message && typeof onReplied === 'function') {
          try { await onReplied(job.message); } catch { /* 已投递的小结不重复执行。 */ }
        }
        if (job.message && typeof onDigestDelivered === 'function') {
          try { onDigestDelivered(job.message); } catch { /* 正文已写入；确认失败时下次还能再送 */ }
        }
        return 'ok';
      }
      if (job.kind === 'wake' && (signal.aborted || userInputs.length > 0)) {
        preempted.push({ events: job.events, throughSeq: job.throughSeq });
        return 'preempted';
      }
      job.attemptId = `turn-${randomUUID()}`;
      if (coordination && failedJob?.workId === job.workId) failedJob = null;
      coordination?.start(job);
      if (coordination && job.manualRecovery) executedManualJobs.set(job, { ok: true, workId: job.workId, turnId: job.attemptId });
      const startedAt = stamp(), started = performance.now();
      const diagnosticTiming = outcome => ({ startedAt, finishedAt: stamp(), durationMs: performance.now() - started, outcome });
      let outcome;
      try { outcome = await runRounds(job, signal); }
      catch (error) {
        const previous = job.continuation ? coordination?.previousOutcome(job) : null;
        outcome = { turnId: job.attemptId, plan: planAgentTurn({ kind: job.kind, userInputs: job.userInputs, events: job.events, workspaceId: workspace }),
          rounds: previous?.rounds || [], failed: true, reason: error?.message || String(error), memoryIds: [], failure: error?.providerRecovery,
          preserveCheckpoint: job.continuation === true };
      }
      job.turnId = outcome.turnId;
      if (classifyProjectAgentFailure(outcome.reason, outcome.failure).kind === 'execution_outcome_unknown') { job.explicitRetryOnly = true; job.outcomeUnknown = true; }
      if (disposed || outcome.disposed) { circuitBreaker?.abandonTrial(); return 'disposed'; }
      if (outcome.stopped) return completeStoppedTurn(job, outcome, diagnosticTiming('stopped'));
      if (outcome.preempted) {
        circuitBreaker?.abandonTrial();
        if (outcome.rounds.length > 0) {
          const message = agentTurnMessage({ turnId: outcome.turnId, plan: outcome.plan, rounds: outcome.rounds });
          message.meta = { ...message.meta, diagnosticTiming: diagnosticTiming('preempted') };
          remember(message);
        }
        preempted.push({ events: job.events, throughSeq: job.throughSeq });
        return 'preempted';
      }
      if (outcome.yielded && coordination) {
        const decision = coordination.finish(job, outcome, readSlot(resolveRoster, job.kind));
        remember(agentTurnMessage({ turnId: outcome.turnId, plan: outcome.plan, rounds: outcome.rounds }));
        activity.finish('done');
        if (decision.end !== 'no_progress') { setStatus('idle'); return 'yielded'; }
        outcome.failed = true; outcome.reason = 'agent_no_progress'; job.explicitRetryOnly = true;
      }
      const learned = await takePendingLearned();
      if (disposed) { pendingLearned.unshift(...learned); return 'disposed'; }
      if (signal.aborted && signal.reason === 'user-stop') {
        pendingLearned.unshift(...learned);
        return completeStoppedTurn(job, outcome, diagnosticTiming('stopped'));
      }
      const finished = finishAgentTurn({
        turnId: outcome.turnId,
        plan: outcome.plan,
        rounds: outcome.rounds,
        failed: outcome.failed === true,
        reason: outcome.reason,
        memoryUsed: outcome.memoryIds,
        publicUpdates: activity.snapshot()?.segments.filter(segment => segment.kind === 'text') ?? [],
      });
      const exhausted = (outcome.failed || finished.failed) && classifyProjectAgentFailure(outcome.reason, outcome.failure).kind === 'budget_exhausted';
      if (coordination && (outcome.failed || finished.failed)) {
        outcome.recovery = coordination.recoveryFor(job, { ...outcome, failed: true });
        for (const message of finished.messages) if (message.card === 'agent_unavailable') {
          message.recovery = outcome.recovery;
          for (const card of message.cards || []) card.recovery = outcome.recovery;
        }
      }
      if (exhausted) circuitBreaker?.abandonTrial();
      else if (outcome.failed || finished.failed) {
        const failure = circuitBreaker?.failure({ turnId: outcome.turnId, reason: outcome.reason || 'invalid reply', retry: { kind: job.kind, userInputs: job.userInputs } });
        if (failure?.opened) for (const message of finished.messages) if (message.card === 'agent_unavailable') {
          const content = `代理连续失败，已暂停自动推进。十分钟后再试，也可以现在手动重试。`;
          message.content = content; message.meta = { ...message.meta, circuitOpenUntil: failure.openUntil };
          for (const card of message.cards || []) card.content = content;
        }
      }
      if (!stampLearned(finished.messages, learned)) pendingLearned.unshift(...learned);
      if (disposed) return 'disposed';
      acceptingStop = false;
      let deliveryPending = false;
      if (coordination) {
        const replies = finished.messages.filter(message => message.kind === 'agent_reply' && message.meta?.surfacing !== 'digest');
        for (const message of replies) message.meta = { ...message.meta, workId: job.workId };
        coordination.prepareReplies(replies);
      }
      for (const message of finished.messages) {
        if (coordination) message.meta = { ...message.meta, workId: job.workId };
        if (message?.kind === 'agent_turn') message.meta = { ...message.meta, diagnosticTiming: diagnosticTiming(outcome.failed || finished.failed ? 'error' : 'done') };
        if (exhausted && message?.kind === 'agent_turn') message.meta.recovery = {
          events: job.events, throughSeq: job.throughSeq,
        };
        if (message?.kind === 'agent_reply' && message?.meta?.surfacing === 'digest' && typeof onDigest === 'function') {
          onDigest({
            message,
            id: message.id,
            text: typeof message.content === 'string' ? message.content : '',
            at: stamp(),
          });
          continue;
        }
        if (coordination && message?.kind === 'agent_reply') {
          message.meta = { ...message.meta, workId: job.workId };
          try { await coordination.deliver(message); } catch { deliveryPending = true; }
          continue;
        }
        remember(message);
        if (message?.kind === 'agent_reply' && typeof onReplied === 'function') {
          try { await onReplied(message); } catch { /* 回复已落盘，签收失败留待后续重试，不重跑用户任务。 */ }
        }
      }
      if (coordination) coordination.finish(job, { ...outcome, failed: outcome.failed || finished.failed, deliveryPending, budgetLimited: exhausted }, readSlot(resolveRoster, job.kind));
      activity.finish(outcome.failed || finished.failed ? 'error' : 'done');
      if ((outcome.failed || finished.failed) && !exhausted) return 'error';
      if (!exhausted) circuitBreaker?.success();
      commit(job.throughSeq);
      if (job.kind === 'user' && typeof onInputsCompleted === 'function') {
        try { await onInputsCompleted(job.userInputs); } catch { /* Canonical replies let the host repair a missing execution acknowledgement. */ }
      }
      if (deliveryPending) return 'yielded';
      if (exhausted) return 'exhausted';
      if (job.kind === 'user' || job.kind === 'wake') scheduleCurator(job);
      return 'ok';
    } finally {
      if (abortController === controller) abortController = null;
      turnKind = null; acceptingStop = false;
    }
  }

  async function completeStoppedTurn(job, outcome, diagnosticTiming) {
    circuitBreaker?.abandonTrial();
    stoppedJob = { ...job, turnId: outcome.turnId };
    const preview = activity.snapshot();
    const partial = preview?.replyText || preview?.segments.filter(segment => segment.kind === 'text').at(-1)?.text || '';
    const message = agentTurnMessage({ turnId: outcome.turnId, plan: outcome.plan, rounds: outcome.rounds,
      publicUpdates: preview?.segments.filter(segment => segment.kind === 'text') ?? [] });
    message.meta = { ...message.meta, diagnosticTiming, recovery: { events: job.events, throughSeq: job.throughSeq } };
    remember(message);
    remember({ id: `${outcome.turnId}-stopped`, turnId: outcome.turnId, role: 'assistant',
      kind: 'system_card', card: 'agent_stopped', content: partial, replyTo: preview?.replyTo || [],
      cards: [{ cardId: `card:agent_stopped:${outcome.turnId}`, kind: 'agent_stopped', content: partial,
        actions: [{ id: 'retry', channel: 'project-agent:retry', payload: { workspaceId: workspace, turnId: outcome.turnId } }] }] });
    coordination?.finish(job, { ...outcome, stopped: true }, readSlot(resolveRoster, job.kind));
    activity.finish('stopped');
    commit(job.throughSeq);
    if (typeof onInputsCompleted === 'function') {
      try { await onInputsCompleted(job.userInputs); } catch { /* Durable stopped turn is the recovery acknowledgement. */ }
    }
    return 'ok';
  }

  async function runRounds(job, signal) {
    const turnId = job.attemptId || `turn-${randomUUID()}`;
    const model = readModel();
    const plan = planAgentTurn({
      kind: job.kind,
      userInputs: job.userInputs,
      events: job.events,
      modelProviderId: model.modelProviderId,
      context: readSlot(resolveContext, job.kind),
      roster: readSlot(resolveRoster, job.kind),
      workspaceId: workspace,
    });
    // A user-triggered retry is visible even when its original work was a wake.
    // Keep the wake kind and its authorization/limits unchanged.
    if (job.interactive === true) {
      plan.interactive = true;
      const retryContinuity = readRetryContinuity(readMessages(), job.turnId);
      if (retryContinuity) plan.turnProfile.context = { ...plan.turnProfile.context, retryContinuity };
    }
    if (job.workId) plan.turnProfile.workId = job.workId;
    if (model.selection) plan.turnProfile.modelSelection = model.selection;
    if (model.candidateIds?.length) plan.turnProfile.recoveryCandidateIds = model.candidateIds;
    activity.begin({ turnId, modelSelection: model.selection, replyTo: (plan.userInputs || []).map(input => input.messageId || `input-${input.inputId}`),
      startedAt: stamp(), visible: job.kind === 'user' || job.interactive === true });
    if (!model.ok) {
      return { turnId, plan, rounds: [], failed: true, reason: model.reason, memoryIds: [] };
    }
    const checkpoint = job.continuation && coordination ? coordination.resume(job) : null;
    if (checkpoint?.providerCheckpoint) plan.turnProfile.providerCheckpoint = checkpoint.providerCheckpoint;
    if (checkpoint) plan.turnProfile.context = { ...plan.turnProfile.context,
      retryContinuity: readRetryContinuity([{ id: checkpoint.turnId, kind: 'agent_turn', rounds: checkpoint.rounds }], checkpoint.turnId) };
    const rounds = [];
    let toolCallsUsed = 0;
    let memoryIds = [];
    while (rounds.length < plan.limits.maxRounds && toolCallsUsed < plan.limits.maxToolCalls) {
      if (disposed) return { turnId, plan, rounds, disposed: true };
      if (coordination && rounds.length && userInputs.length) return { turnId, plan, rounds, yielded: true, memoryIds };
      if (!coordination && job.kind === 'wake' && (signal.aborted || userInputs.length > 0)) {
        return { turnId, plan, rounds, preempted: true };
      }
      const result = await callRound({
        job,
        plan,
        rounds,
        signal,
        toolCallsUsed,
        turnId,
      });
      if (disposed || result.disposed) return { turnId, plan, rounds, disposed: true };
      if (result.preempted) {
        if (result.round) rounds.push(result.round);
        return { turnId, plan, rounds, preempted: true };
      }
      if (result.failed) {
        if (result.round) rounds.push(result.round);
        return { turnId, plan, rounds, failed: true, reason: result.reason, failure: result.failure, memoryIds };
      }
      if (result.stopped) {
        if (result.round) rounds.push(result.round);
        return { turnId, plan, rounds, stopped: true, memoryIds };
      }
      rounds.push(result.round);
      if (result.yielded) return { turnId, plan, rounds, yielded: true, providerCheckpoint: result.providerCheckpoint, memoryIds };
      if (result.memoryIds?.length) memoryIds = result.memoryIds;
      toolCallsUsed += result.toolCallCount;
      const keepGoing = result.hasPostReply
        ? false
        : result.continued === true && result.toolCallCount > 0;
      if (!keepGoing) break;
    }
    return { turnId, plan, rounds, failed: false, memoryIds };
  }

  async function callRound({ job, plan, rounds, signal, toolCallsUsed, turnId }) {
    let lastError = '提供方错误';
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      if (disposed) return { disposed: true };
      if (!coordination && job.kind === 'wake' && (signal.aborted || userInputs.length > 0)) {
        return { preempted: true };
      }
      setStatus('waiting_provider');
      activity.round();
      let raw;
      try {
        raw = await executeTurn({
          workspaceId: workspace,
          conversationId: conversation,
          mode: plan.mode,
          turnProfile: plan.turnProfile,
          streamId: turnId,
          plan,
          roundIndex: rounds.length,
          priorRounds: rounds,
          signal,
          shouldYield: coordination ? () => userInputs.length > 0 : undefined,
          sink: { ...turnSink, send(channel, payload) { activity.accept(channel, payload); turnSink.send(channel, payload); } },
          modelProviderId: plan.modelProviderId,
          limits: plan.limits,
          remainingToolCalls: Math.max(0, plan.limits.maxToolCalls - toolCallsUsed),
        });
      } catch (error) {
        if (disposed || error?.name === 'AbortError') {
          if (disposed) return { disposed: true };
          if (signal.reason === 'user-stop') return { stopped: true };
          if (job.kind === 'wake') return { preempted: true };
        }
        raw = {
          ok: false,
          retryable: error?.name !== 'AbortError',
          error: error?.message || '提供方错误',
          providerRecovery: error?.providerRecovery,
        };
      }
      setStatus('thinking');
      if (disposed) return { disposed: true };
      if (signal.aborted && signal.reason === 'user-stop') return { stopped: true, round: roundFrom(raw) };
      if (raw?.preempted === true || (job.kind === 'wake' && signal.aborted)) {
        return { preempted: true, round: roundFrom(raw) };
      }
      const failure = raw?.ok === false || raw?.retryable === true
        || ['error', 'aborted', 'interrupted'].includes(raw?.terminalStatus);
      if (!failure) {
        const toolCalls = Array.isArray(raw?.toolCalls) ? raw.toolCalls.map(normalizeTool) : [];
        const toolCallCount = Number.isInteger(raw?.toolCallCount) ? raw.toolCallCount : toolCalls.length;
        return {
          round: { text: typeof raw?.text === 'string' ? raw.text : '', toolCalls },
          toolCallCount,
          hasPostReply: toolCalls.some((call) => call.name === 'post_reply' && acceptedReplyResult(call.result)),
          continued: raw?.continued,
          memoryIds: memoryIdsOf(raw),
          yielded: raw?.turnEnd === 'yielded', providerCheckpoint: raw?.providerCheckpoint,
        };
      }
      lastError = textOf(raw?.error) || '提供方错误';
      if (coordination || raw?.retryable !== true || (raw?.toolCalls || []).length > 0 || attempt >= delays.length) {
        return { failed: true, reason: lastError, failure: raw?.providerRecovery || raw?.failure,
          round: roundFrom(raw) };
      }
      try {
        await sleep(delays[attempt], signal);
      } catch {
        if (disposed) return { disposed: true };
        if (job.kind === 'wake') return { preempted: true };
        return { failed: true, reason: lastError };
      }
    }
    return { failed: true, reason: lastError };
  }

  function readModel() {
    let resolved;
    try {
      resolved = resolveModel({ workspaceId: workspace, conversationId: conversation, role: 'project_agent' });
    } catch (error) {
      return { ok: false, modelProviderId: null, reason: error?.message || '没有可用的模型' };
    }
    if (!resolved || typeof resolved !== 'object') {
      return { ok: false, modelProviderId: null, reason: '没有可用的模型' };
    }
    if (resolved.ok === false) {
      return {
        ok: false,
        modelProviderId: null,
        reason: textOf(resolved.missing) || textOf(resolved.reason) || '没有可用的模型',
      };
    }
    const modelProviderId = textOf(resolved.modelProviderId) || textOf(resolved.selection?.modelProviderId);
    if (!modelProviderId) {
      return { ok: false, modelProviderId: null, reason: textOf(resolved.missing) || '没有可用的模型' };
    }
    return { ok: true, modelProviderId, selection: resolved.selection || null, candidateIds: resolved.candidateIds || [], reason: '' };
  }

  function readSlot(fn, kind) {
    try {
      const value = fn({ workspaceId: workspace, conversationId: conversation, kind, role: 'project_agent' });
      return value === undefined ? null : value;
    } catch {
      return null;
    }
  }

  function enqueueUserInputs(inputs) {
    if (disposed) return Promise.resolve({ skipped: 'disposed' });
    const list = (Array.isArray(inputs) ? inputs : []).filter(item => {
      if (!item || typeof item !== 'object') return false;
      if (typeof item.inputId !== 'string') return true;
      if (knownInputs.has(item.inputId)) return false;
      knownInputs.add(item.inputId); return true;
    });
    userInputs.push(...list);
    if (list.length && coordination) { failedJob = null; retryArmed = false; manualJobs.length = 0; manualTrial = false; }
    if (list.length && (failedJob?.budgetExhausted || failedJob?.explicitRetryOnly)) {
      if (failedJob.throughSeq > 0) preempted.push({ events: failedJob.events, throughSeq: failedJob.throughSeq });
      failedJob = null; retryArmed = false;
    }
    if (!coordination && turnKind === 'wake' && abortController && !abortController.signal.aborted) {
      abortController.abort();
    }
    if (!coordination && failedJob && !retryArmed) return kick().then(result => ({ ...result, queued: list.length }));
    return kick();
  }

  function takeDigestTimer() {
    const index = timers.findIndex((timer) => timer?.kind === 'digest_due' && timer.wake === true && timer.message);
    if (index < 0) return null;
    const [timer] = timers.splice(index, 1);
    return { kind: 'digest', message: timer.message };
  }

  function enqueueTimer(timer) {
    if (disposed) return { skipped: 'disposed' };
    const next = {
      ...(timer && typeof timer === 'object' ? timer : {}),
      enqueuedAt: stamp(),
    };
    if (typeof next.id === 'string' && next.id && timers.some((item) => item?.id === next.id)) {
      return { queued: false, duplicate: true };
    }
    timers.push(next);
    return { queued: true };
  }

  function retry(turnId) {
    if (disposed) return Promise.resolve({ skipped: 'disposed' });
    if (coordination) {
      const requested = turnId || failedJob?.turnId || [...Object.values(coordinationStore.read().works)].reverse().find(work => work.recovery)?.recovery.failedTurnId;
      const restored = coordination.retryJob(requested);
      if (!restored.ok) return Promise.resolve(restored);
      let job = manualJobs.find(job => job.workId === restored.job.workId);
      if (!job) { job = restored.job; manualJobs.push(job); }
      manualTrial = true; failedJob = null;
      return kick().then(() => executedManualJobs.get(job) || { ok: false, code: 'STALE_TURN' });
    }
    if (failedJob?.outcomeUnknown) return Promise.resolve({ ok: false, code: 'EXECUTION_OUTCOME_UNKNOWN' });
    manualTrial = true;
    if (!failedJob) return kick();
    failedJob.interactive = true;
    retryArmed = true;
    return kick();
  }

  function restoreRecoverableTurn() {
    const messages = readMessages() || [];
    const turn = messages.findLast(message => message.kind === 'agent_turn');
    const card = turn && messages.findLast(message => message.turnId === turn.id && ['agent_unavailable', 'agent_stopped'].includes(message.card));
    if (!card || (card.card !== 'agent_stopped' && projectAgentFailureKind(card.content) !== 'budget_exhausted')) return;
    // New records bind the attempted inbox batch. Older cards can be parked,
    // but cannot acknowledge an unknown batch merely because the app restarted.
    const recovery = turn.meta?.recovery;
    const durable = Array.isArray(recovery?.events) && Number.isInteger(recovery.throughSeq) && recovery.throughSeq >= 0;
    if (coordination) {
      if (durable) { coordination.admitLegacyTurn(turn, recovery); commit(recovery.throughSeq); }
      return;
    }
    const batch = durable ? recovery : inbox.takeBatch(workspace);
    failedJob = { kind: turn.turnKind === 'wake' ? 'wake' : 'user', userInputs: turn.userInputs || [],
      events: batch?.events || [], throughSeq: batch?.throughSeq || 0, carried: [], turnId: turn.id, explicitRetryOnly: true };
    if (durable) {
      coordination?.admitRecoveredEvents(recovery.events);
      commit(recovery.throughSeq);
    }
    setStatus('error');
  }

  function dispose() {
    disposed = true;
    if (curatorTimer) clearTimeout(curatorTimer);
    curatorTimer = null;
    if (recoveryTimer !== null) clearSchedule(recoveryTimer);
    recoveryTimer = null; recoveryTimerAt = null;
    abortController?.abort();
    activity.dispose();
  }

  function armCurator(retryAt) {
    if (disposed || typeof retryAt !== 'string') return;
    const at = Date.parse(retryAt);
    if (!Number.isFinite(at)) return;
    if (curatorTimer) clearTimeout(curatorTimer);
    const nowMs = Date.parse(stamp());
    const delay = Math.max(0, at - (Number.isFinite(nowMs) ? nowMs : Date.now()));
    curatorTimer = setTimeout(() => {
      curatorTimer = null;
      if (disposed) return;
      scheduleCurator({ kind: 'due', userInputs: [], events: [] });
    }, delay);
    curatorTimer.unref?.();
  }

  function scheduleCurator(job) {
    if (typeof onCurator !== 'function') return;
    const payload = {
      workspaceId: workspace,
      conversationId: conversation,
      kind: job.kind,
      userInputs: (Array.isArray(job.userInputs) ? job.userInputs : []).map((item) => ({ ...item })),
      events: (Array.isArray(job.events) ? job.events : []).map((event) => ({ ...event })),
    };
    const previous = curatorFlight;
    curatorFlight = Promise.resolve(previous)
      .then(() => onCurator(payload))
      .then((result) => {
        for (const id of memoryIdsOf({ memoryIds: result?.learnedIds })) {
          if (!pendingLearned.includes(id) && pendingLearned.length < 200) pendingLearned.push(id);
        }
        if (typeof result?.retryAt === 'string') armCurator(result.retryAt);
      })
      .catch(() => {
        // 整理失败不打断代理回合。
      });
  }

  async function drainCurator() {
    const flight = curatorFlight;
    curatorFlight = null;
    if (!flight) return;
    try {
      await flight;
    } catch {
      // 整理失败不打断代理回合。
    }
  }

  async function takePendingLearned() {
    await drainCurator();
    return pendingLearned.splice(0, pendingLearned.length);
  }

  restoreRecoverableTurn();
  armRecoveryTimer();
  return {
    workspaceId: workspace,
    conversationId: conversation,
    enqueueUserInputs,
    enqueueTimer,
    kick,
    retry,
    retryStopped(turnId) {
      if (coordination) return retry(turnId);
      if (!stoppedJob || stoppedJob.turnId !== turnId || activity.snapshot()?.phase !== 'stopped') return Promise.resolve({ skipped: 'stale' });
      failedJob = { ...stoppedJob, interactive: true }; stoppedJob = null;
      retryArmed = true;
      return kick();
    },
    stopResponse(turnId) {
      if (disposed || !acceptingStop || !abortController || abortController.signal.aborted || activity.snapshot()?.turnId !== turnId
        || ['done', 'error', 'stopped', 'disposed'].includes(activity.snapshot()?.phase)) return { ok: false, code: 'STALE_TURN' };
      abortController.abort('user-stop');
      return { ok: true };
    },
    hasContinuation: () => holdsLease() === true && Boolean(coordination?.recoverJob() || coordination?.hasPendingDelivery()),
    ownsInput: inputId => coordination?.ownsInput(inputId) === true,
    activity: activity.snapshot,
    dispose,
    status: () => statusValue,
    parked: () => (failedJob
      ? {
          kind: failedJob.kind,
          inputIds: failedJob.userInputs.map((item) => item.inputId),
          throughSeq: failedJob.throughSeq,
        }
      : null),
    mailbox: () => ({
      userInputs: userInputs.slice(),
      events: preempted.flatMap((item) => item.events),
      timers: timers.slice(),
    }),
  };
}

function roundFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls.map(normalizeTool) : [];
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!text && toolCalls.length === 0) return null;
  return { text, toolCalls };
}

function normalizeTool(call) {
  return {
    name: typeof call?.name === 'string' ? call.name : '',
    input: call?.input ?? null,
    result: call?.result ?? null,
    ...(Number.isFinite(call?.startedAtMs) ? { startedAtMs: call.startedAtMs } : {}),
    ...(Number.isFinite(call?.endedAtMs) ? { endedAtMs: call.endedAtMs } : {}),
  };
}

function textOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function memoryIdsOf(raw) {
  if (!Array.isArray(raw?.memoryIds)) return [];
  const ids = [];
  for (const item of raw.memoryIds) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 200 || ids.includes(trimmed)) continue;
    ids.push(trimmed);
    if (ids.length >= 200) break;
  }
  return ids;
}

function stampLearned(messages, ids) {
  const learned = memoryIdsOf({ memoryIds: ids });
  if (learned.length === 0) return true;
  let stamped = false;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.kind !== 'agent_reply') continue;
    const existing = memoryIdsOf({ memoryIds: message.meta?.memoryLearned });
    const merged = memoryIdsOf({ memoryIds: [...existing, ...learned] });
    if (merged.length === 0) continue;
    message.meta = {
      ...(message.meta && typeof message.meta === 'object' ? message.meta : {}),
      memoryLearned: merged,
    };
    stamped = true;
  }
  return stamped;
}

function sleep(ms, signal) {
  if (signal?.aborted) {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return Promise.reject(error);
  }
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    function finish() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
