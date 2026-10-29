import { randomUUID } from 'node:crypto';

const same = (a, b) => a && b && a.viewId === b.viewId && a.windowId === b.windowId && a.generation === b.generation;
/** Bounded, sender-bound presentation handoffs. Acknowledgement is never execution Evidence. */
export function createResourceWindowHandoffs({ schedule = setTimeout, cancel = clearTimeout, createId = randomUUID } = {}) {
  const pending = new Map();
  function finish(id, status) {
    const item = pending.get(id); if (!item) return false;
    pending.delete(id); cancel(item.timer); item.sender.removeListener?.('destroyed', item.destroyed);
    item.resolve(status); return true;
  }
  return {
    request(sender, identity, kind, send) {
      for (const [id, item] of pending) if (item.kind === kind && same(item.identity, identity)) finish(id, 'cancelled');
      const requestId = createId();
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const item = { sender, identity, kind, resolve, destroyed: () => finish(requestId, 'source_unavailable') };
      pending.set(requestId, item); sender.once?.('destroyed', item.destroyed);
      item.timer = schedule(() => finish(requestId, kind === 'checkpoint' ? 'unconfirmed' : 'source_unavailable'), kind === 'checkpoint' ? 500 : 3000);
      try { send(requestId); } catch { finish(requestId, 'source_unavailable'); }
      return promise;
    },
    acknowledge(sender, payload, kind) {
      const item = pending.get(payload?.requestId);
      if (!item || item.sender !== sender || item.kind !== kind || !same(item.identity, payload?.identity)) return false;
      const status = payload.status;
      if (!(kind === 'checkpoint' ? ['confirmed', 'blocked'] : ['returned', 'source_tab_closed', 'cancelled']).includes(status)) return false;
      return finish(payload.requestId, status);
    },
    release(identity) { for (const [id, item] of pending) if (same(identity, item.identity)) finish(id, 'cancelled'); },
    dispose() { for (const id of [...pending.keys()]) finish(id, 'cancelled'); },
  };
}
