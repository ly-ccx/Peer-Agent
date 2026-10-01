import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const AGE_MS = 30 * 60_000;
const PRIORITY = { low: 0, normal: 1, high: 2 };
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export function normalizeConcurrency(value) {
  return Number.isInteger(value) && value >= 1 && value <= 8 ? value : 4;
}

function failed(plan) {
  if (plan?.status === 'failed' || plan?.status === 'cancelled') return true;
  const runner = plan?.runner;
  return plan?.status === 'interrupted' && runner?.status === 'failed'
    && (runner.interruption?.recoverable !== true
      || Number.isFinite(runner.maxRecoverableInterruptionRetries)
        && runner.recoverableInterruptionCount >= runner.maxRecoverableInterruptionRetries);
}
function occupying(plan) {
  return plan.delegationOrigin?.phase === 'running' && !TERMINAL.has(plan.status) && !failed(plan);
}
function slot(plan) {
  if (plan.delegationOrigin?.readOnly === true) return 'read';
  return plan.deliveryBinding?.executionIsolation === 'worktree' && plan.deliveryBinding.worktreePath ? 'isolated' : 'write';
}
function rank(priority, enqueuedAt, at) {
  const base = PRIORITY[priority] ?? PRIORITY.normal;
  return Math.min(2, base + (at - Date.parse(enqueuedAt) >= AGE_MS ? 1 : 0));
}

/** Queue order is durable; Plans own task/acceptance truth, round leases are process-local. */
export function createExecutionScheduler({ rootDir = null, getConcurrency = () => 4, now = () => new Date().toISOString() } = {}) {
  const turnContext = new AsyncLocalStorage();
  let isWorkspaceReady = () => true;
  const turnsByPlan = new Map();
  const queues = new Map();
  let plansById = new Map();
  let active = 0;
  let sequence = 0;
  const waiting = [];
  function at() { const value = now(); return value instanceof Date ? value.toISOString() : value; }
  function file(workspaceId) { return rootDir && WORKSPACE_ID.test(workspaceId) ? path.join(rootDir, workspaceId, 'scheduler.json') : null; }
  function queue(workspaceId) {
    if (queues.has(workspaceId)) return queues.get(workspaceId);
    let items = [];
    try {
      const saved = JSON.parse(readFileSync(file(workspaceId), 'utf8'));
      if (saved.version === 1 && Array.isArray(saved.items)) items = saved.items.slice(0, 10_000)
        .filter(item => typeof item.sessionId === 'string' && Number.isSafeInteger(item.order) && item.order >= 0
          && Number.isFinite(Date.parse(item.enqueuedAt)));
    } catch { /* Missing/corrupt order is reconstructed from Plans. */ }
    queues.set(workspaceId, items);
    return items;
  }
  function save(workspaceId, items) {
    const target = file(workspaceId);
    if (!target) return;
    const body = JSON.stringify({ version: 1, items });
    try { if (readFileSync(target, 'utf8') === body) return; } catch { /* New queue. */ }
    mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, body, 'utf8');
    renameSync(temporary, target);
  }
  function reconcile(plans, { workspaceId: onlyWorkspace } = {}) {
    if (onlyWorkspace) {
      for (const [id, plan] of plansById) if (plan.delegationOrigin?.workspaceId === onlyWorkspace) plansById.delete(id);
      for (const plan of plans) if (plan.delegationOrigin?.workspaceId === onlyWorkspace) plansById.set(plan.planId, plan);
    } else plansById = new Map(plans.map(plan => [plan.planId, plan]));
    const admittedAt = at();
    const workspaces = new Set([...queues.keys(), ...plans.map(plan => plan.delegationOrigin?.workspaceId).filter(Boolean)]);
    for (const workspaceId of workspaces) {
      if (onlyWorkspace ? workspaceId !== onlyWorkspace : isWorkspaceReady(workspaceId) !== true) continue;
      const pending = plans.filter(plan => plan.delegationOrigin?.workspaceId === workspaceId
        && plan.delegationOrigin.phase === 'queued' && plan.runner?.status !== 'waiting_user' && !TERMINAL.has(plan.status));
      const ids = new Set(pending.map(plan => plan.delegationOrigin.sessionId));
      const old = queue(workspaceId);
      let order = Math.max(-1, ...old.map(item => item.order)) + 1;
      const items = old.filter(item => ids.has(item.sessionId));
      const known = new Set(items.map(item => item.sessionId));
      for (const plan of [...pending].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
        const sessionId = plan.delegationOrigin.sessionId;
        if (known.has(sessionId)) continue;
        items.push({ sessionId, order: order++, enqueuedAt: admittedAt });
        known.add(sessionId);
      }
      queues.set(workspaceId, items);
      save(workspaceId, items);
    }
  }
  function inspect(plan, plans = [...plansById.values()]) {
    const origin = plan.delegationOrigin || {};
    const sameProject = plans.filter(item => item.delegationOrigin?.workspaceId === origin.workspaceId);
    const bySession = new Map(sameProject.map(item => [item.delegationOrigin.sessionId, item]));
    const dependencies = (origin.dependsOn || []).map(id => bySession.get(id));
    const describe = items => items.map(item => ({ sessionId: item.delegationOrigin.sessionId, title: item.title || '' }));
    if (dependencies.some(item => !item)) return { allowed: false, reason: 'dependency_missing', queuedBehind: [] };
    if (dependencies.some(failed)) return { allowed: false, reason: 'dependency_failed', queuedBehind: describe(dependencies.filter(failed)) };
    const unmet = dependencies.filter(item => item.status !== 'completed' || !item.resultAcceptance?.acceptedAt);
    if (unmet.length) return { allowed: false, reason: 'dependencies', queuedBehind: describe(unmet) };
    if (origin.isolationBlock) return { allowed: false, reason: origin.isolationBlock, queuedBehind: [] };
    const kind = slot(plan);
    const occupants = sameProject.filter(item => item.planId !== plan.planId && occupying(item) && slot(item) === kind);
    const limit = kind === 'read' ? 2 : kind === 'write' ? 1 : Infinity;
    if (occupants.length >= limit) return { allowed: false, reason: `${kind}_slot`, queuedBehind: describe(occupants) };
    return { allowed: true, reason: null, queuedBehind: [] };
  }
  function select(plans) {
    reconcile(plans);
    const metadata = new Map([...queues.values()].flat().map(item => [item.sessionId, item]));
    const currentTime = Date.parse(at());
    const candidates = plans.filter(plan => isWorkspaceReady(plan.delegationOrigin?.workspaceId) === true && metadata.has(plan.delegationOrigin?.sessionId))
      .sort((a, b) => {
        const aa = metadata.get(a.delegationOrigin.sessionId), bb = metadata.get(b.delegationOrigin.sessionId);
        return rank(b.delegationOrigin.priority, bb.enqueuedAt, currentTime) - rank(a.delegationOrigin.priority, aa.enqueuedAt, currentTime)
          || aa.enqueuedAt.localeCompare(bb.enqueuedAt) || aa.order - bb.order || a.planId.localeCompare(b.planId);
      });
    const virtual = [...plans];
    const start = [], blocked = [];
    for (const candidate of candidates) {
      const decision = inspect(candidate, virtual);
      if (decision.reason === 'dependency_failed' || decision.reason === 'dependency_missing') blocked.push(candidate);
      if (!decision.allowed) continue;
      start.push(candidate);
      const index = virtual.findIndex(item => item.planId === candidate.planId);
      virtual[index] = { ...candidate, status: 'executing', delegationOrigin: { ...candidate.delegationOrigin, phase: 'running' } };
    }
    return { start, blocked };
  }
  function drain() {
    const limit = normalizeConcurrency(getConcurrency());
    const currentTime = Date.parse(at());
    waiting.sort((a, b) => rank(b.priority, b.at, currentTime) - rank(a.priority, a.at, currentTime) || a.order - b.order);
    while (active < limit && waiting.length) {
      const job = waiting.shift();
      job.signal?.removeEventListener('abort', job.abort);
      if (job.signal?.aborted) { job.resolve(null); continue; }
      active += 1;
      let released = false;
      job.resolve(() => { if (released) return; released = true; active -= 1; drain(); });
    }
  }
  function acquire(input) {
    if (input.signal?.aborted) return Promise.resolve(null);
    const priority = input.priority || plansById.get(input.planId)?.delegationOrigin?.priority || 'normal';
    return new Promise(resolve => {
      const job = { ...input, priority, at: at(), order: sequence++, resolve };
      job.abort = () => {
        const index = waiting.indexOf(job);
        if (index < 0) return;
        waiting.splice(index, 1);
        job.signal.removeEventListener('abort', job.abort);
        resolve(null);
      };
      input.signal?.addEventListener('abort', job.abort, { once: true });
      waiting.push(job);
      drain();
    });
  }
  return {
    configure(options = {}) {
      if (options.rootDir && options.rootDir !== rootDir) { rootDir = options.rootDir; queues.clear(); }
      if (typeof options.getConcurrency === 'function') getConcurrency = options.getConcurrency;
      if (typeof options.isWorkspaceReady === 'function') isWorkspaceReady = options.isWorkspaceReady;
      drain();
    },
    reconcile, inspect, select, isWorkspaceReady: workspaceId => isWorkspaceReady(workspaceId) === true,
    canRunPlan(plan) { return !plan?.delegationOrigin || isWorkspaceReady(plan.delegationOrigin.workspaceId) === true && plan.delegationOrigin.phase === 'running' && inspect(plan).allowed; },
    async waitForPlanIdle(planId) {
      while (turnsByPlan.get(planId)?.size) await Promise.allSettled([...turnsByPlan.get(planId)].map(controller => controller.settled));
    },
    cancelPlan(planId) {
      for (const controller of turnsByPlan.get(planId) || []) controller.abort();
    },
    async withTurn(input, run) {
      const plan = plansById.get(input.planId);
      if (plan?.delegationOrigin && !isWorkspaceReady(plan.delegationOrigin.workspaceId)) return { ok: false, terminalStatus: 'aborted', retryable: false, error: 'recovery_pending' };
      const controller = new AbortController();
      let settle; controller.settled = new Promise(resolve => { settle = resolve; });
      const relayAbort = () => controller.abort();
      input.signal?.addEventListener('abort', relayAbort, { once: true });
      if (input.signal?.aborted) controller.abort();
      const owned = { ...input, signal: controller.signal };
      const group = turnsByPlan.get(input.planId) || new Set();
      if (input.planId) { turnsByPlan.set(input.planId, group); group.add(controller); }
      let context;
      try {
        const release = await acquire(owned);
        if (!release) return { ok: false, terminalStatus: 'aborted', retryable: false, error: 'aborted' };
        context = { input: owned, release, active: true };
        if (controller.signal.aborted) return { ok: false, terminalStatus: 'aborted', retryable: false, error: 'aborted' };
        if (plan?.delegationOrigin && !isWorkspaceReady(plan.delegationOrigin.workspaceId)) return { ok: false, terminalStatus: 'aborted', retryable: false, error: 'recovery_pending' };
        return await turnContext.run(context, () => run(controller.signal));
      } finally {
        if (context?.active) { context.active = false; context.release(); }
        input.signal?.removeEventListener('abort', relayAbort);
        group.delete(controller);
        settle();
        if (!group.size) turnsByPlan.delete(input.planId);
      }
    },
    // Only a synchronous host tool entry yields; detached task starts acquire their own leases.
    async yieldTurn(run) {
      const context = turnContext.getStore();
      if (!context?.active) return run();
      context.active = false;
      context.release();
      try { return await turnContext.run(null, () => run(context.input.signal)); }
      finally {
        const release = await acquire(context.input);
        context.release = release;
        context.active = Boolean(release);
      }
    },
    stats() { return { active, waiting: waiting.length, limit: normalizeConcurrency(getConcurrency()) }; },
  };
}
