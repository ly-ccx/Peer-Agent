import { randomUUID } from 'node:crypto';
import { normalizeResourceFeedback } from '@peer-agent/protocol';
const fail = code => ({ ok: false, code });
const same = (a, b) => a && b && ['viewId', 'windowId', 'generation'].every(key => a[key] === b[key]);
const validIdentity = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => ['viewId', 'windowId', 'generation'].includes(key))
  && [value.viewId, value.windowId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)
  && (typeof value.generation === 'string' && value.generation.length > 0 && value.generation.length <= 256 || Number.isSafeInteger(value.generation) && value.generation > 0);
/** Bounded host -> actual main -> durable draft receipt. No input submission or task port. */
export function createResourceFeedbackPreparation({ isMainSender, getRecipient, now = Date.now, schedule = setTimeout, cancel = clearTimeout, createId = randomUUID }) {
  const pending = new Map(); let disposed = false;
  const live = sender => sender && !sender.isDestroyed?.() && isMainSender(sender);
  function finish(id, result) {
    const item = pending.get(id); if (!item) return false;
    pending.delete(id); cancel(item.timer); item.sourceSender.removeListener?.('destroyed', item.destroyed); item.resolve(result); return true;
  }
  async function recipientMatches(row) {
    const current = await getRecipient(row.recipient.workspaceId);
    return current?.conversationId === row.recipient.conversationId;
  }
  async function prepare({ sourceSender, identity, feedback: raw, isCurrent = () => true }) {
    const feedback = normalizeResourceFeedback(raw);
    if (!feedback || !validIdentity(identity)) return fail('INVALID_RESOURCE_FEEDBACK');
    if (disposed || !live(sourceSender)) return fail('SOURCE_UNAVAILABLE');
    if (!await recipientMatches(feedback)) return fail('RESOURCE_FEEDBACK_RECIPIENT_CHANGED');
    if (!await isCurrent() || disposed || !live(sourceSender)) return fail('SOURCE_CHANGED');
    for (const item of pending.values()) if (item.sourceSender === sourceSender && item.feedback.id === feedback.id) {
      return same(item.identity, identity) && JSON.stringify(item.feedback) === JSON.stringify(feedback) ? item.promise : fail('RESOURCE_FEEDBACK_ID_CONFLICT');
    }
    if (pending.size >= 32 || [...pending.values()].filter(item => item.sourceSender === sourceSender).length >= 8) return fail('RESOURCE_FEEDBACK_LIMIT');
    const requestId = createId(), expiresAt = now() + 3000;
    let resolve; const promise = new Promise(done => { resolve = done; });
    const item = { requestId, sourceSender, identity: { ...identity }, feedback, isCurrent, expiresAt, promise, resolve, claimed: false,
      destroyed: () => finish(requestId, fail('SOURCE_UNAVAILABLE')) };
    pending.set(requestId, item); sourceSender.once?.('destroyed', item.destroyed);
    item.timer = schedule(() => finish(requestId, fail('DRAFT_PREPARATION_UNCONFIRMED')), 3000);
    try { sourceSender.send('resource-feedback:prepare', { requestId, identity: { ...item.identity }, feedback: structuredClone(feedback), expiresAt }); }
    catch { finish(requestId, fail('SOURCE_UNAVAILABLE')); }
    return promise;
  }
  const locate = (sender, key) => {
    const item = pending.get(key?.requestId);
    return item && live(sender) && item.sourceSender === sender && item.feedback.id === key?.feedbackId && same(item.identity, key?.identity) && item.expiresAt > now() ? item : null;
  };
  return {
    prepare,
    async claim(sender, key) {
      const item = locate(sender, key); if (!item || disposed) return fail('PREPARATION_EXPIRED');
      if (item.claimed) return { ok: true, id: item.feedback.id };
      if (item.claiming) return item.claiming;
      item.claiming = (async () => { try {
        if (!await recipientMatches(item.feedback)) { finish(item.requestId, fail('RESOURCE_FEEDBACK_RECIPIENT_CHANGED')); return fail('RESOURCE_FEEDBACK_RECIPIENT_CHANGED'); }
        if (!await item.isCurrent()) { finish(item.requestId, fail('SOURCE_CHANGED')); return fail('SOURCE_CHANGED'); }
        if (disposed || locate(sender, key) !== item) return fail('PREPARATION_EXPIRED');
        item.claimed = true; return { ok: true, id: item.feedback.id };
      } catch { finish(item.requestId, fail('SOURCE_UNAVAILABLE')); return fail('SOURCE_UNAVAILABLE'); } })();
      return item.claiming;
    },
    async acknowledge(sender, payload) {
      const item = locate(sender, payload); if (!item || disposed || typeof payload?.ok !== 'boolean') return { ok: false };
      if (payload.ok && !item.claimed) return { ok: false };
      const recipient = await recipientMatches(item.feedback).catch(() => false);
      if (locate(sender, payload) !== item || disposed) return { ok: false };
      const result = !recipient ? fail('RESOURCE_FEEDBACK_RECIPIENT_CHANGED') : payload.ok ? { ok: true, id: item.feedback.id }
        : fail(typeof payload.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(payload.code) ? payload.code : 'DRAFT_SAVE_FAILED');
      return { ok: finish(item.requestId, result) };
    },
    dispose() { disposed = true; for (const key of [...pending.keys()]) finish(key, fail('SOURCE_UNAVAILABLE')); },
  };
}
