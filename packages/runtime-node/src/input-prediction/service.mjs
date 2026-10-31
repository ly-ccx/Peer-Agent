import { randomUUID } from 'node:crypto';
import { isInputPredictionRequest, isInputPredictionReference, INPUT_PREDICTION_LIMITS as limits } from '@peer-agent/protocol';
import { parseInputPrediction, predictionMessages, predictionSettingsFor } from './policy.mjs';

/** No tool executor, input submitter or durable candidate store is admitted here. */
export function createInputPredictionService({ readSnapshot, assemble, infer, budget,
  now = Date.now, createId = randomUUID, timeoutMs = limits.timeoutMs } = {}) {
  const candidates = new Map(), owners = new Map(), rates = new Map();
  let running = null, disposed = false;
  const keyFor = (owner, ref) => JSON.stringify([owner, ref.composerInstanceId, ref.requestId]);
  function cancel(owner, ref) {
    if (!isInputPredictionReference(ref)) return { kind: 'cancelled' };
    const key = keyFor(owner, ref);
    owners.get(key)?.controller?.abort();
    clearTimeout(candidates.get(key)?.expiry);
    candidates.delete(key);
    owners.delete(key);
    return { kind: 'cancelled' };
  }
  async function request(owner, input) {
    if (disposed) return { kind: 'unavailable', reason: 'disposed' };
    if (!isInputPredictionRequest(input)) return { kind: 'error', code: 'INVALID_REQUEST' };
    const key = keyFor(owner, input);
    for (const [oldKey, old] of owners) {
      if (old.owner === owner && old.instance === input.composerInstanceId) cancel(owner, old);
    }
    if (running && !running.controller.signal.aborted) return { kind: 'unavailable', reason: 'busy' };
    const controller = new AbortController();
    running = { key, controller };
    owners.set(key, { owner, instance: input.composerInstanceId, composerInstanceId: input.composerInstanceId, requestId: input.requestId, controller });
    let reservation = null, finalUsage = null, route = null, timer, settled = false, complete = false;
    const fail = reason => ({ kind: 'unavailable', reason });
    try {
      const snapshot = await readSnapshot(input);
      if (controller.signal.aborted || disposed) return { kind: 'cancelled' };
      if (!snapshot || snapshot.blocked) return fail(snapshot?.reason || 'context_unavailable');
      const settings = predictionSettingsFor(snapshot.settings, input.workspaceId, input.mode);
      if (!settings) return fail('disabled');
      if (!snapshot.route?.ok) return fail(snapshot.route?.reason || 'model_unconfigured');
      route = snapshot.route;
      const assembled = await assemble(snapshot, input);
      const prepared = predictionMessages({ system: assembled?.rendered ?? '', snapshot, request: input });
      if (!prepared || !assembled?.rendered) return { kind: 'none', reason: 'context_budget' };
      const rateKey = JSON.stringify([owner, input.workspaceId, input.conversationId]);
      const rate = (rates.get(rateKey) ?? []).filter(at => now() - at < 60_000);
      if (rate.length >= limits.requestsPerMinute || (rate.length && now() - rate.at(-1) < limits.requestIntervalMs)) return fail('throttled');
      const current = await readSnapshot(input);
      if (current?.token !== snapshot.token || current?.blocked || disposed || controller.signal.aborted) return fail('stale');
      reservation = budget.reserve({ id: input.requestId, owner, settings, route,
        workspaceId: input.workspaceId, conversationId: input.conversationId, tokens: prepared.reservedTokens });
      if (!reservation) return fail('budget');
      rates.set(rateKey, [...rate, now()]);
      if (rates.size > 128) rates.delete(rates.keys().next().value);
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const inference = Promise.resolve().then(() => infer({ route, messages: prepared.messages, signal: controller.signal,
        maxOutputTokens: limits.outputTokens, onUsage: usage => { finalUsage = usage; } }));
      // A credential refresh or third-party transport may ignore AbortSignal.
      // Its late result can settle usage, but cannot revive a UI candidate.
      void inference.then(result => {
        if (settled && result?.ok && result?.usage) { try { budget.settle(reservation, result.usage, { complete: true }); } catch {} }
      }, () => {});
      const result = await Promise.race([inference, new Promise(resolve => {
        if (controller.signal.aborted) resolve(null);
        else controller.signal.addEventListener('abort', () => resolve(null), { once: true });
      })]);
      finalUsage = result?.usage ?? finalUsage;
      complete = result?.ok === true;
      if (controller.signal.aborted || disposed) return { kind: 'cancelled' };
      if (!result?.ok) return { kind: 'error', code: 'PROVIDER_UNAVAILABLE' };
      if (result.toolCalls?.length) return { kind: 'none', reason: 'rejected' };
      const insertion = parseInputPrediction(result.content, input.mode);
      if (!insertion || snapshot.messages.some(row => row.content.trim() === insertion.trim())
        || (input.mode === 'continuation' && insertion.startsWith(input.draftText))) return { kind: 'none', reason: 'abstain' };
      const latest = await readSnapshot(input);
      if (latest?.token !== snapshot.token || latest?.blocked || controller.signal.aborted) return fail('stale');
      const candidate = { candidateId: createId(), requestId: input.requestId, workspaceId: input.workspaceId,
        conversationId: input.conversationId, composerInstanceId: input.composerInstanceId, mode: input.mode,
        insertionText: insertion, draftVersion: input.draftVersion, contextToken: createId(),
        expiresAt: new Date(now() + limits.ttlMs).toISOString() };
      for (const [id, row] of candidates) if (row.expires <= now()) cancel(row.owner, row.input);
      const bytes = Buffer.byteLength(JSON.stringify([candidate, input]), 'utf8');
      while (candidates.size >= 64 || [...candidates.values()].reduce((sum, row) => sum + row.bytes, 0) + bytes > 256 * 1024) {
        const oldest = candidates.values().next().value; if (!oldest) break; cancel(oldest.owner, oldest.input);
      }
      const expiry = setTimeout(() => cancel(owner, input), limits.ttlMs); expiry.unref?.();
      candidates.set(key, { candidate, token: snapshot.token, input, owner, bytes, expiry, expires: Date.parse(candidate.expiresAt) });
      return { kind: 'candidate', candidate };
    } catch { return controller.signal.aborted ? { kind: 'cancelled' } : { kind: 'error', code: 'PREDICTION_UNAVAILABLE' }; }
    finally {
      clearTimeout(timer);
      if (running?.key === key) running = null;
      if (!candidates.has(key)) owners.delete(key);
      settled = true;
      if (reservation) { try { budget.settle(reservation, finalUsage, { complete }); } catch { /* The durable reservation remains conservative. */ } }
    }
  }
  async function validate(owner, ref) {
    if (!isInputPredictionReference(ref)) return { kind: 'stale' };
    const key = keyFor(owner, ref), row = candidates.get(key);
    if (!row || row.candidate.candidateId !== ref.candidateId) return { kind: 'stale' };
    if (row.expires <= now()) { cancel(owner, ref); return { kind: 'expired' }; }
    try {
      const current = await readSnapshot(row.input);
      if (!current || current.blocked || current.token !== row.token || disposed) { cancel(owner, ref); return { kind: 'stale' }; }
      clearTimeout(row.expiry); candidates.delete(key); owners.delete(key);
      return { kind: 'valid' };
    } catch { cancel(owner, ref); return { kind: 'unavailable' }; }
  }
  return { request, cancel, validate,
    cancelOwner(owner) { for (const ref of [...owners.values()]) if (ref.owner === owner) cancel(owner, ref); },
    preempt() { running?.controller.abort(); for (const row of candidates.values()) clearTimeout(row.expiry); candidates.clear(); owners.clear(); },
    dispose() { disposed = true; running?.controller.abort(); for (const row of candidates.values()) clearTimeout(row.expiry); candidates.clear(); owners.clear(); rates.clear(); },
  };
}
