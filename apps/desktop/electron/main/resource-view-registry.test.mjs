import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createResourceViewRegistry } from './resource-view-registry.mjs';
class Sender extends EventEmitter {
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('destroyed'); }
}
const input = () => ({ resource: { kind: 'document', reference: { workspaceId: 'bot', path: './a.md', task: { sessionId: 'session', planId: 'plan' } }, mode: 'preview' }, sourceTabId: 'original-tab', navigation: { top: 250, left: 0 } });
const resolved = request => ({ ok: true, owner: { workspaceId: 'bot', conversationId: 'bot-chat', task: { sessionId: 'session', planId: 'plan' } }, resource: { ...request.resource, reference: { ...request.resource.reference, path: '/project/a.md' } } });
function fixture(options = {}) {
  const source = new Sender(), child = new Sender(), other = new Sender(), main = new Set([source]), resources = new Set([child, other]); let ids = 0;
  const registry = createResourceViewRegistry({ isMainSender: sender => main.has(sender), isResourceSender: sender => resources.has(sender), resolveSource: async value => resolved(value), createId: () => `host-id-${++ids}`, ...options });
  return { source, child, other, registry, main, resources };
}
test('host resolution precedes identity allocation; real sender and full generation bind ready/read/return', async () => {
  const f = fixture(); const opened = await f.registry.prepare(f.source, input()); assert.equal(opened.ok, true);
  const identity = opened.context; assert.equal(identity.phase, 'prepared'); assert.deepEqual(identity.owner.task, input().resource.reference.task);
  assert.equal(f.registry.attach(identity, f.child).context.phase, 'attached');
  assert.equal(f.registry.readBinding(f.child, identity).status, 'not_ready'); assert.equal(f.registry.bootstrap(f.other).status, 'scope_denied');
  assert.equal(f.registry.markReady(f.other, identity).status, 'scope_denied');
  assert.equal(f.registry.markReady(f.child, { ...identity, generation: identity.generation - 1 }).status, 'stale_view');
  f.registry.markReady(f.child, identity); const binding = f.registry.readBinding(f.child, identity); assert.equal(binding.context.resource.reference.path, '/project/a.md');
  assert.equal(f.registry.readBinding(f.child).status, 'stale_view');
  assert.equal(f.registry.returnTarget(f.child, identity).sourceSender, f.source);
  assert.throws(() => { binding.context.owner.workspaceId = 'forged'; }, TypeError); assert.equal(f.registry.bootstrap(f.child).context.owner.workspaceId, 'bot');
  f.registry.dispose(); assert.equal(f.child.listenerCount('destroyed'), 0); assert.equal(f.source.listenerCount('destroyed'), 0);
});
test('untrusted issuers, changed owner/task/commit and duplicate senders cannot obtain another binding', async () => {
  const f = fixture(); assert.equal((await f.registry.prepare(f.other, input())).status, 'scope_denied');
  const first = await f.registry.prepare(f.source, input()), second = await f.registry.prepare(f.source, input());
  f.registry.attach(first.context, f.child); assert.equal(f.registry.attach(second.context, f.child).status, 'scope_denied');
  assert.equal(f.registry.readBinding(f.child, second.context).status, 'stale_view');
  const wrong = fixture({ resolveSource: async value => ({ ...resolved(value), owner: { workspaceId: 'other', conversationId: 'bot-chat' } }) });
  assert.equal((await wrong.registry.prepare(wrong.source, input())).status, 'scope_denied');
  const dropped = fixture({ resolveSource: async value => ({ ...resolved(value), resource: { ...value.resource, reference: { workspaceId: 'bot', path: '/project/a.md' } } }) });
  assert.equal((await dropped.registry.prepare(dropped.source, input())).status, 'scope_denied');
  const replaced = fixture({ resolveSource: async value => ({ ...resolved(value), resource: { ...resolved(value).resource, mode: 'source' } }) });
  assert.equal((await replaced.registry.prepare(replaced.source, input())).status, 'source_unavailable');
  [f, wrong, dropped, replaced].forEach(value => value.registry.dispose());
});
test('pending preparations count toward capacity and cancellation frees reservations without waiting for a stale resolver', async () => {
  let finish; const f = fixture({ maxViews: 1, resolveSource: request => new Promise(resolve => { finish = () => resolve(resolved(request)); }) });
  const pending = f.registry.prepare(f.source, input()); await Promise.resolve();
  assert.equal(f.registry.stats().pending, 1); assert.equal((await f.registry.prepare(f.source, input())).status, 'limit_reached');
  f.registry.invalidateSource(f.source); assert.equal(f.registry.stats().pending, 0); assert.equal((await pending).status, 'source_unavailable');
  finish(); await Promise.resolve(); assert.equal(f.registry.stats().active, 0);
  const next = f.registry.prepare(f.source, input()); await Promise.resolve(); f.registry.dispose(); assert.equal((await next).status, 'disposed');
  finish(); await Promise.resolve(); assert.equal(f.registry.stats().active, 0);
});
test('owner changes cancel only pending/prepared views; an attached view keeps its original owner and reading position', async () => {
  const f = fixture(); const first = await f.registry.prepare(f.source, input()), prepared = await f.registry.prepare(f.source, input());
  f.registry.attach(first.context, f.child); f.registry.markReady(f.child, first.context);
  f.registry.invalidateSource(f.source); assert.equal(f.registry.attach(prepared.context, f.other).status, 'stale_view');
  const nav = f.registry.updateNavigation(f.child, first.context, { top: 440, left: 0 }); assert.equal(nav.context.navigation.top, 440);
  assert.equal(f.registry.updateNavigation(f.child, first.context, { top: 0, left: 0, owner: 'other' }).status, 'invalid_request');
  assert.equal(f.registry.readBinding(f.child, first.context).context.owner.workspaceId, 'bot');
  f.main.delete(f.source); assert.equal(f.registry.returnTarget(f.child, first.context).status, 'source_unavailable');
  assert.equal(f.registry.readBinding(f.child, first.context).ok, true); // original scope still needs per-read host validation
  f.child.destroy(); assert.equal(f.registry.stats().active, 0); assert.equal(f.registry.release(first.context), false); f.registry.dispose();
});
test('source destruction aborts pending preparation and releases unattached leases, without managing tasks or main windows', async () => {
  const f = fixture(); const opened = await f.registry.prepare(f.source, input()); f.source.destroy();
  assert.equal(f.registry.stats().active, 0); assert.equal(f.registry.attach(opened.context, f.child).status, 'stale_view');
  let started = 0;
  const late = fixture({ resolveSource: async value => { started++; return resolved(value); } });
  const pending = late.registry.prepare(late.source, input()); late.source.destroy(); assert.equal((await pending).status, 'source_unavailable'); assert.equal(started, 0);
  f.registry.dispose(); late.registry.dispose();
});

test('reused native sender cannot revive an old view identity; failed resolution and duplicate host IDs allocate no lease', async () => {
  const f = fixture(); const first = await f.registry.prepare(f.source, input()); f.registry.attach(first.context, f.child); f.registry.markReady(f.child, first.context);
  f.registry.release(first.context); const next = await f.registry.prepare(f.source, input()); f.registry.attach(next.context, f.child); f.registry.markReady(f.child, next.context);
  assert.equal(f.registry.readBinding(f.child, first.context).status, 'stale_view'); assert.equal(f.registry.release(first.context), false);
  assert.equal(f.registry.readBinding(f.child, next.context).ok, true); f.registry.dispose();
  const denied = fixture({ resolveSource: async () => ({ ok: false, status: 'scope_denied' }) });
  assert.equal((await denied.registry.prepare(denied.source, input())).status, 'scope_denied'); assert.equal(denied.registry.stats().active, 0); denied.registry.dispose();
  const duplicate = fixture({ createId: () => 'same' }); assert.equal((await duplicate.registry.prepare(duplicate.source, input())).status, 'source_unavailable'); assert.equal(duplicate.registry.stats().active, 0); duplicate.registry.dispose();
});

test('host revocation can retire a pending source after its main-window role was removed', async () => {
  const f = fixture({ resolveSource: () => new Promise(() => {}) });
  const pending = f.registry.prepare(f.source, input()); await Promise.resolve();
  f.main.delete(f.source); f.registry.invalidateSource(f.source);
  assert.equal(f.registry.stats().pending, 0); assert.equal((await pending).status, 'source_unavailable'); f.registry.dispose();
});

test('a caller can abort one preparation without cancelling another view from the same source', async () => {
  const f = fixture({ resolveSource: () => new Promise(() => {}) }), a = new AbortController(), b = new AbortController();
  const first = f.registry.prepare(f.source, input(), { signal: a.signal }), second = f.registry.prepare(f.source, input(), { signal: b.signal }); await Promise.resolve();
  a.abort(); assert.equal((await first).status, 'cancelled'); assert.equal(f.registry.stats().pending, 1);
  f.registry.dispose(); assert.equal((await second).status, 'disposed');
});

test('window factories receive the real resolved scope while the renderer context stays protocol-only', async () => {
  let received;
  const f = fixture({ resolveSource: async request => ({ ...resolved(request), root: '/project', target: '/project/a.md' }), onPrepared: (_context, scope) => { received = scope; } });
  try {
    const opened = await f.registry.prepare(f.source, input());
    assert.equal(received.root, '/project'); assert.equal(received.target, '/project/a.md');
    assert.equal(opened.context.root, undefined); assert.equal(opened.context.target, undefined);
    f.registry.attach(opened.context, f.child); f.registry.markReady(f.child, opened.context);
    const updated = f.registry.updateNavigation(f.child, opened.context, { top: 900, left: 0 }, 1);
    assert.equal(updated.context.navigation.top, 900); assert.equal(updated.context.sourceNavigation.top, 250);
    assert.equal(f.registry.updateNavigation(f.child, opened.context, { top: 5, left: 0 }, 1).status, 'stale_view');
    assert.equal(f.registry.bootstrap(f.child).context.navigation.top, 900);
  } finally { f.registry.dispose(); }
});
