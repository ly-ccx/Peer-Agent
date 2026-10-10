import { createExecutionScheduler, USER_TURN_LIMITS, createWorkBudgetGuard } from '@peer-agent/runtime-node';
import { randomUUID } from 'node:crypto';

/**
 * Runs one agent turn through an existing chat service.
 * The sink receives stream events. The service still owns tools, permissions, and persistence.
 * @param {{ llmChatService: { sendMessage: (input: object) => Promise<object> } }} options
 */
export function createAgentTurnExecutor({ llmChatService, executionScheduler = createExecutionScheduler() } = {}) {
  if (typeof llmChatService?.sendMessage !== 'function') {
    throw new Error('AgentTurnExecutor requires llmChatService.sendMessage');
  }
  const active = new Map();
  return {
    executionScheduler,
    async stop(workspaceId) {
      const turns = [...active.values()].filter(turn => !workspaceId || turn.workspaceId === workspaceId);
      for (const turn of turns) turn.controller.abort();
      await Promise.allSettled(turns.map(turn => turn.done));
    },
    resolveGoalRole(input) {
      return llmChatService.resolveGoalRole?.(input) ?? { ok: false, missing: '没有可用的模型' };
    },
    /**
     * @param {object} input
     * @param {object} [input.turnProfile]
     * @param {{ send: (channel: string, payload: unknown) => void }} input.sink
     */
    runTurn(input = {}) {
      if (!input.sink || typeof input.sink.send !== 'function') throw new Error('AgentTurnExecutor requires a sink with send()');
      const profile = input.turnProfile;
      const priority = input.plan?.kind === 'user' ? 'high' : ['memory_curator','objective_probe'].includes(profile?.role) ? 'low' : undefined;
      const controller = new AbortController(), id = randomUUID();
      const abort = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) abort();
      const done = executionScheduler.withTurn({ planId: profile?.planId, workspaceId: profile?.workspaceId || input.workspaceId,
        lane: profile?.role === 'project_agent' ? 'coordination' : 'work', priority, signal: controller.signal }, async signal => {
        const guard = createWorkBudgetGuard(profile);
        let outcome;
        try { outcome = await runTurn({ ...input, budgetGuard: guard, signal }); return outcome; }
        finally { guard?.finish(outcome?.usage); }
      })
        .finally(() => { input.signal?.removeEventListener('abort', abort); active.delete(id); });
      active.set(id, { workspaceId: profile?.workspaceId || input.workspaceId, controller, done });
      return done;
    },
  };

  function runTurn({ turnProfile = null, sink, signal, budgetGuard = null, shouldYield, ...sendMessageArgs } = {}) {
    if (!sink || typeof sink.send !== 'function') {
      throw new Error('AgentTurnExecutor requires a sink with send()');
    }
    const effort = turnProfile?.modelSelection?.reasoningEffort ?? sendMessageArgs.effort;
    if (effort !== undefined) sendMessageArgs.effort = effort;
    const projectAgent = turnProfile?.role === 'project_agent' || sendMessageArgs.mode === 'project_agent';
    if (budgetGuard) sendMessageArgs.executionBudget = { guard: budgetGuard };
    if (!projectAgent) {
      if (signal?.aborted) return Promise.resolve({ ok: false, terminalStatus: 'aborted' });
      const streamId = sendMessageArgs.streamId || randomUUID();
      const abort = () => llmChatService.abort?.(streamId);
      signal?.addEventListener('abort', abort, { once: true });
      return Promise.resolve().then(() => signal?.aborted
        ? { ok: false, terminalStatus: 'aborted' }
        : llmChatService.sendMessage({
        ...sendMessageArgs,
        streamId,
        webContents: sink,
        turnProfile,
      })).finally(() => signal?.removeEventListener('abort', abort));
    }
    if (signal?.aborted) return Promise.resolve({ ok: false, terminalStatus: 'aborted', retryable: false, error: 'aborted' });
    // A project-agent call contains its own provider loop. Enforce the outer
    // runner's remaining allowance there, before any capability is dispatched.
    let yieldedCheckpoint = null;
    sendMessageArgs.executionBudget = {
      guard: budgetGuard,
      maxTurns: Math.min(2, Math.max(1, (sendMessageArgs.limits?.maxRounds ?? USER_TURN_LIMITS.maxRounds) - (sendMessageArgs.roundIndex ?? 0))),
      maxToolCalls: sendMessageArgs.hardRemainingToolCalls ?? Infinity,
      sliceToolCalls: Math.min(4, Math.max(1, sendMessageArgs.remainingToolCalls ?? sendMessageArgs.limits?.maxToolCalls ?? USER_TURN_LIMITS.maxToolCalls)),
      yieldAtTurnLimit: true,
      shouldYield,
      maxToolBatchCalls: 32,
      providerCheckpoint: turnProfile?.providerCheckpoint,
      onYield: checkpoint => { yieldedCheckpoint = checkpoint; },
    };
    const collected = collectTurn(sink);
    const streamId = sendMessageArgs.streamId || randomUUID();
    const abort = () => llmChatService.abort?.(streamId);
    signal?.addEventListener('abort', abort, { once: true });
    return llmChatService.sendMessage({
      ...sendMessageArgs,
      streamId,
      webContents: collected.sink,
      turnProfile,
    }).then((outcome) => ({
      ...outcome,
      ...(outcome?.providerRecovery || collected.providerRecovery() ? { providerRecovery: outcome?.providerRecovery || collected.providerRecovery() } : {}),
      ...(yieldedCheckpoint ? { turnEnd: 'yielded', providerCheckpoint: yieldedCheckpoint } : {}),
      ...(collected.error() || ['error', 'aborted', 'interrupted'].includes(outcome?.terminalStatus)
        ? { ok: false, retryable: false, error: outcome?.error || collected.error() || outcome.terminalStatus }
        : {}),
      text: typeof outcome?.text === 'string' && outcome.text ? outcome.text : collected.text(),
      toolCalls: Array.isArray(outcome?.toolCalls) ? outcome.toolCalls : collected.toolCalls(),
    })).finally(() => signal?.removeEventListener('abort', abort));
  }
}

function collectTurn(sink) {
  const calls = [];
  const byId = new Map();
  let text = '';
  let error = '';
  let providerRecovery = null;
  const wrapped = {
    send(channel, payload) {
      sink.send(channel, payload);
      if (channel === 'chat:stream:delta' && typeof payload?.content === 'string') {
        text += payload.content;
      } else if (channel === 'chat:stream:error') {
        error = typeof payload?.error === 'string' ? payload.error : '提供方错误';
        if (payload?.providerRecovery && typeof payload.providerRecovery === 'object') providerRecovery = payload.providerRecovery;
      } else if (channel === 'chat:stream:tool-call') {
        const id = typeof payload?.toolCallId === 'string' && payload.toolCallId
          ? payload.toolCallId
          : `call-${calls.length}`;
        const call = {
          name: typeof payload?.tool === 'string' ? payload.tool : '',
          input: payload?.args ?? null,
          result: null,
          ...(Number.isFinite(payload.startedAtMs) ? { startedAtMs: payload.startedAtMs } : {}),
        };
        calls.push(call);
        byId.set(id, call);
      } else if (channel === 'chat:stream:tool-result') {
        const id = typeof payload?.toolCallId === 'string' ? payload.toolCallId : '';
        const call = (id && byId.get(id)) || calls.find((item) => item.result == null) || null;
        if (call) {
          call.result = parseToolResult(payload?.result);
          if (Number.isFinite(payload.startedAtMs)) call.startedAtMs = payload.startedAtMs;
          if (Number.isFinite(payload.endedAtMs)) call.endedAtMs = payload.endedAtMs;
        }
      }
    },
  };
  if (typeof sink.isDestroyed === 'function') wrapped.isDestroyed = () => sink.isDestroyed();
  if (sink.approver != null) wrapped.approver = sink.approver;
  return {
    sink: wrapped,
    text: () => text,
    error: () => error,
    providerRecovery: () => providerRecovery,
    toolCalls: () => calls.map((call) => ({ ...call })),
  };
}

function parseToolResult(value) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}
