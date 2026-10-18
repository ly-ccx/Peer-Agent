import { randomUUID } from 'node:crypto';
import { runVerifierWithReport } from './verifier-report.mjs';
import { VERIFICATION_TIMEOUT_MS } from './verifier-lifecycle.mjs';
import { progressFingerprint } from './continuation-policy.mjs';

export const VERIFIER_TOTAL_LIMITS = Object.freeze({ maxModelRequests: 96, maxToolCalls: 512 });
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const uncertain = result => /outcome_unknown$/.test(result?.terminalReason || result?.result?.error || '');
const active = new Set();

/** One readonly review, many Provider slices. All format attempts share reservations and deadline. */
export async function runContinuedVerification(options) {
  const key = options.identity.planId;
  if (key && active.has(key)) throw failure('verifier_in_progress');
  if (key) active.add(key);
  try { return await runReview(options); } finally { if (key) active.delete(key); }
}

async function runReview({ run, signal, timeoutMs = VERIFICATION_TIMEOUT_MS,
  allowedEvidenceRefs = [], identity, port = null, now = () => Date.now(), limits = VERIFIER_TOTAL_LIMITS }) {
  let state = port?.load?.() || null;
  if (state?.phase === 'tools') throw failure('execution_outcome_unknown', 'Verifier tool results require host reconciliation before recovery');
  if (state && state.sourceRevision !== identity.sourceRevision) state = null;
  if (state && state.modelKey !== identity.modelKey) throw failure('verification_model_changed');
  state ||= { schemaVersion: 1, continuationId: randomUUID(), ...identity, phase: 'ready',
    deadlineAt: new Date(now() + Math.min(timeoutMs, VERIFICATION_TIMEOUT_MS)).toISOString(),
    modelRequests: 0, toolCalls: 0, formatAttempt: 0, evidenceRefs: [] };
  // A terminal attempt can be rechecked within its original allowance, never resumed as an unfinished batch.
  if (state.phase === 'completed') state = { ...state, checkpointRef: undefined, formatAttempt: 0, previousText: '' };
  let native = state.checkpointRef ? readNative(state.checkpointRef) : null;
  const allowed = new Set([...allowedEvidenceRefs, ...(state.evidenceRefs || [])]);
  function persist(patch = {}) {
    state = { ...state, ...patch };
    port?.save?.(state);
  }
  function readNative(ref) {
    try { const saved = port?.readCheckpoint?.(ref); if (!saved || typeof saved !== 'object') throw Error(); return saved; }
    catch (error) {
      if (['work_execution_stopped', 'verification_source_changed'].includes(error?.code)) throw error;
      throw failure('verifier_checkpoint_unavailable', 'The protected verifier checkpoint is unavailable; no tools were replayed');
    }
  }
  function current() {
    if (signal?.aborted) throw failure('verifier_cancelled');
    port?.assertCurrent?.();
    if (Date.parse(state.deadlineAt) <= now()) throw failure('verifier_timeout');
  }
  function reserve(key, cap, phase) {
    current();
    if (state[key] >= cap) throw failure('verifier_budget_limited');
    persist({ [key]: state[key] + 1, phase });
  }
  function checkpoint(value, executions = []) {
    current();
    if (executions.some(uncertain)) throw failure('execution_outcome_unknown');
    // This callback runs only after the Provider paired the complete tool batch.
    const checkpointRef = port ? port.writeCheckpoint(value) : undefined;
    native = value;
    persist({ phase: 'ready', ...(checkpointRef ? { checkpointRef } : {}) });
  }
  current(); persist();
  const remainingMs = Date.parse(state.deadlineAt) - now();
  const result = await runVerifierWithReport({ signal, timeoutMs: remainingMs, allowedEvidenceRefs: allowed,
    initialAttempt: state.formatAttempt, initialText: state.previousText || '',
    run: async ({ attempt, previousText, signal: reviewSignal, onToolResult }) => {
      if (attempt !== state.formatAttempt) { native = null; persist({ checkpointRef: undefined, formatAttempt: attempt, previousText }); }
      for (;;) {
        current();
        if (state.modelRequests >= limits.maxModelRequests || state.toolCalls >= limits.maxToolCalls) throw failure('verifier_budget_limited');
        const before = { requests: state.modelRequests, tools: state.toolCalls };
        const result = await run({ attempt, previousText, signal: reviewSignal, onToolResult,
          executionBudget: {
            maxTurns: Math.min(12, limits.maxModelRequests - state.modelRequests),
            maxToolCalls: Math.min(128, limits.maxToolCalls - state.toolCalls), yieldAtTurnLimit: true,
            providerCheckpoint: native,
            guard: { beforeRequest: () => { if (reviewSignal.aborted) throw reviewSignal.reason; reserve('modelRequests', limits.maxModelRequests, 'requesting'); },
              beforeTool: () => { if (reviewSignal.aborted) throw reviewSignal.reason; reserve('toolCalls', limits.maxToolCalls, 'tools'); },
              checkpoint: (...args) => { if (reviewSignal.aborted) throw reviewSignal.reason; return checkpoint(...args); } },
          } });
        if (reviewSignal.aborted) throw reviewSignal.reason;
        current();
        // Older adapters without reservation callbacks still consume the finite slice allowance.
        if (state.modelRequests === before.requests) persist({ modelRequests: state.modelRequests
          + Math.max(1, result.outcome?.providerCheckpoint?.turns || result.outcome?.usage?.providerRequestCount || 1) });
        const events = result.events || [];
        if (state.toolCalls === before.tools) persist({ toolCalls: state.toolCalls + events.filter(row => row.channel === 'chat:stream:tool-call').length });
        for (const event of events) if (event.channel === 'chat:stream:tool-result') {
          onToolResult(event.payload?.result);
          for (const ref of event.payload?.evidenceRefs || []) if (typeof ref === 'string') allowed.add(ref);
        }
        if (reviewSignal.aborted) throw reviewSignal.reason;
        persist({ evidenceRefs: [...allowed] });
        if (result.outcome?.turnEnd !== 'yielded') { persist({ phase: 'completed' }); return result; }
        if (!result.outcome.providerCheckpoint) throw failure('verifier_checkpoint_unavailable');
        checkpoint(result.outcome.providerCheckpoint);
        const calls = events.filter(row => row.channel === 'chat:stream:tool-call').map(row => ({ name: row.payload?.tool, input: row.payload?.args }));
        const results = events.filter(row => row.channel === 'chat:stream:tool-result').map(row => row.payload?.result);
        const fingerprint = progressFingerprint([{ toolCalls: calls.map((call, i) => ({ ...call, result: results[i] })) }]);
        const repeats = fingerprint === state.fingerprint ? (state.repeats || 0) + 1 : 0;
        persist({ fingerprint, repeats });
        if (repeats >= 2) throw failure('verifier_no_progress', 'Verifier repeated the same observations without new facts');
        // Yield the JavaScript task too, so cancellation and other admissions can run.
        await new Promise(resolve => setImmediate(resolve));
      }
    } });
  // Refs read in earlier slices remain available to the final report decoder.
  if (result.passed && result.evidenceRefs.some(ref => !allowed.has(ref))) throw failure('verifier_failed', 'Verifier cited unindexed evidence');
  return result;
}
