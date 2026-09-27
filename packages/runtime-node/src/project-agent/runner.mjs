import { agentTurnMessage, finishAgentTurn, planAgentTurn } from './agent-turn-plan.mjs';

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
  resolveModel = () => ({ ok: false, missing: '没有可用的模型' }),
  resolveContext = () => null,
  resolveRoster = () => null,
  sink = null,
  now = () => new Date().toISOString(),
  retryDelays = SAME_PROVIDER_RETRY_DELAYS_MS,
  onStatus = null,
  onDigest = null,
  onDigestDelivered = null,
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

  const userInputs = [];
  const timers = [];
  /** @type {Array<{ events: object[], throughSeq: number }>} */
  const preempted = [];
  let failedJob = null;
  let retryArmed = false;
  let pumping = null;
  let disposed = false;
  let turnKind = null;
  let abortController = null;
  let turnSeq = 0;
  let statusValue = 'idle';

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
    appendMessage(conversation, { ...message, createdAt: stamp() });
  }

  function commit(throughSeq) {
    if (!Number.isInteger(throughSeq) || throughSeq <= 0) return;
    inbox.commitBatch(workspace, { throughSeq, ok: true });
  }

  function takeNext() {
    if (retryArmed && failedJob) {
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
      const inputs = userInputs.splice(0, userInputs.length);
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
    const digest = takeDigestTimer();
    if (digest) return digest;
    const batch = inbox.takeBatch(workspace);
    const events = Array.isArray(batch?.events) ? batch.events : [];
    if (events.length === 0) return null;
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
    if (failedJob && !retryArmed) return Promise.resolve({ skipped: 'error' });
    if (!pumping) pumping = pump().finally(() => { pumping = null; });
    return pumping;
  }

  async function pump() {
    while (!disposed) {
      if (holdsLease() !== true) {
        setStatus(failedJob ? 'error' : 'idle');
        return;
      }
      if (failedJob && !retryArmed) {
        setStatus('error');
        return;
      }
      const job = takeNext();
      if (!job) {
        setStatus(failedJob ? 'error' : 'idle');
        return;
      }
      const outcome = await runJob(job);
      if (outcome === 'disposed') return;
      if (outcome === 'error') {
        failedJob = job;
        setStatus('error');
        return;
      }
    }
  }

  async function runJob(job) {
    const controller = new AbortController();
    abortController = controller;
    turnKind = job.kind;
    const signal = controller.signal;
    setStatus('thinking');
    try {
      if (job.kind === 'digest') {
        if (job.message) remember(job.message);
        if (job.message && typeof onDigestDelivered === 'function') {
          try { onDigestDelivered(job.message); } catch { /* 正文已写入；确认失败时下次还能再送 */ }
        }
        return 'ok';
      }
      if (job.kind === 'wake' && (signal.aborted || userInputs.length > 0)) {
        preempted.push({ events: job.events, throughSeq: job.throughSeq });
        return 'preempted';
      }
      const outcome = await runRounds(job, signal);
      if (disposed || outcome.disposed) return 'disposed';
      if (outcome.preempted) {
        if (outcome.rounds.length > 0) {
          remember(agentTurnMessage({ turnId: outcome.turnId, plan: outcome.plan, rounds: outcome.rounds }));
        }
        preempted.push({ events: job.events, throughSeq: job.throughSeq });
        return 'preempted';
      }
      const finished = finishAgentTurn({
        turnId: outcome.turnId,
        plan: outcome.plan,
        rounds: outcome.rounds,
        failed: outcome.failed === true,
        reason: outcome.reason,
        memoryUsed: outcome.memoryIds,
      });
      if (disposed) return 'disposed';
      for (const message of finished.messages) {
        if (message?.kind === 'agent_reply' && message?.meta?.surfacing === 'digest' && typeof onDigest === 'function') {
          onDigest({
            id: message.id,
            text: typeof message.content === 'string' ? message.content : '',
            at: stamp(),
          });
          continue;
        }
        remember(message);
      }
      if (outcome.failed) return 'error';
      commit(job.throughSeq);
      return 'ok';
    } finally {
      if (abortController === controller) abortController = null;
      turnKind = null;
    }
  }

  async function runRounds(job, signal) {
    const turnId = `turn-${turnSeq += 1}`;
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
    if (!model.ok) {
      return { turnId, plan, rounds: [], failed: true, reason: model.reason, memoryIds: [] };
    }
    const rounds = [];
    let toolCallsUsed = 0;
    let memoryIds = [];
    while (rounds.length < plan.limits.maxRounds && toolCallsUsed < plan.limits.maxToolCalls) {
      if (disposed) return { turnId, plan, rounds, disposed: true };
      if (job.kind === 'wake' && (signal.aborted || userInputs.length > 0)) {
        return { turnId, plan, rounds, preempted: true };
      }
      const result = await callRound({
        job,
        plan,
        rounds,
        signal,
        toolCallsUsed,
      });
      if (disposed || result.disposed) return { turnId, plan, rounds, disposed: true };
      if (result.preempted) {
        if (result.round) rounds.push(result.round);
        return { turnId, plan, rounds, preempted: true };
      }
      if (result.failed) {
        return { turnId, plan, rounds, failed: true, reason: result.reason, memoryIds };
      }
      rounds.push(result.round);
      if (result.memoryIds?.length) memoryIds = result.memoryIds;
      toolCallsUsed += result.toolCallCount;
      const keepGoing = result.hasPostReply
        ? false
        : result.continued === true && result.toolCallCount > 0;
      if (!keepGoing) break;
    }
    return { turnId, plan, rounds, failed: false, memoryIds };
  }

  async function callRound({ job, plan, rounds, signal, toolCallsUsed }) {
    let lastError = '提供方错误';
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      if (disposed) return { disposed: true };
      if (job.kind === 'wake' && (signal.aborted || userInputs.length > 0)) {
        return { preempted: true };
      }
      setStatus('waiting_provider');
      let raw;
      try {
        raw = await executeTurn({
          workspaceId: workspace,
          conversationId: conversation,
          mode: plan.mode,
          turnProfile: plan.turnProfile,
          plan,
          roundIndex: rounds.length,
          priorRounds: rounds,
          signal,
          sink: turnSink,
          modelProviderId: plan.modelProviderId,
          limits: plan.limits,
          remainingToolCalls: Math.max(0, plan.limits.maxToolCalls - toolCallsUsed),
        });
      } catch (error) {
        if (disposed || error?.name === 'AbortError') {
          if (disposed) return { disposed: true };
          if (job.kind === 'wake') return { preempted: true };
        }
        raw = {
          ok: false,
          retryable: error?.name !== 'AbortError',
          error: error?.message || '提供方错误',
        };
      }
      setStatus('thinking');
      if (disposed) return { disposed: true };
      if (raw?.preempted === true || (job.kind === 'wake' && signal.aborted)) {
        return { preempted: true, round: roundFrom(raw) };
      }
      const failure = raw?.ok === false || raw?.retryable === true;
      if (!failure) {
        const toolCalls = Array.isArray(raw?.toolCalls) ? raw.toolCalls.map(normalizeTool) : [];
        const toolCallCount = Number.isInteger(raw?.toolCallCount) ? raw.toolCallCount : toolCalls.length;
        return {
          round: { text: typeof raw?.text === 'string' ? raw.text : '', toolCalls },
          toolCallCount,
          hasPostReply: toolCalls.some((call) => call.name === 'post_reply'),
          continued: raw?.continued,
          memoryIds: memoryIdsOf(raw),
        };
      }
      lastError = textOf(raw?.error) || '提供方错误';
      if (raw?.retryable !== true || attempt >= delays.length) {
        return { failed: true, reason: lastError };
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
    return { ok: true, modelProviderId, reason: '' };
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
    const list = (Array.isArray(inputs) ? inputs : []).filter((item) => item && typeof item === 'object');
    userInputs.push(...list);
    if (turnKind === 'wake' && abortController && !abortController.signal.aborted) {
      abortController.abort();
    }
    if (failedJob && !retryArmed) return Promise.resolve({ queued: list.length, skipped: 'error' });
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

  function retry() {
    if (disposed) return Promise.resolve({ skipped: 'disposed' });
    if (!failedJob) return kick();
    retryArmed = true;
    return kick();
  }

  function dispose() {
    disposed = true;
    abortController?.abort();
  }

  return {
    workspaceId: workspace,
    conversationId: conversation,
    enqueueUserInputs,
    enqueueTimer,
    kick,
    retry,
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
  }
  return ids;
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
