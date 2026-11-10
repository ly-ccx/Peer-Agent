import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createReplyDelivery } from './reply-delivery.mjs';
import { createProjectAgentRunner } from './runner.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { createCircuitBreaker } from './circuit-breaker.mjs';
import { createDigestQueue } from './digest.mjs';

async function fixture(t) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-delivery-isolation-'));
  let clock = Date.parse('2026-11-01T00:00:00Z'); const now = () => new Date(clock).toISOString();
  let owns = true;
  const options = { rootDir, workspaceId: 'w', holdsLease: () => owns, leaseEpoch: () => 'one', formatVersion: 2, fenceLegacyWrites: true, now };
  const store = createWorkCoordinationStore(options); await store.prepare();
  const messages = [], accepted = new Set(); let effects = 0;
  const ports = { store, now, readMessages: () => messages, appendMessage: message => messages.push(message),
    accept: async (message, receipt) => { if (!accepted.has(receipt.operationId)) { accepted.add(receipt.operationId); effects++; } } };
  t.after(() => { store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { store, options, rootDir, messages, ports, now, loseLease: () => { owns = false; }, advance: ms => { clock += ms; }, effects: () => effects };
}
const reply = (id, workId = 'a') => ({ id, content: 'Actual result', kind: 'agent_reply', meta: { workId } });

test('independent deliveries proceed during failed settlement; each work preserves order and backoff survives rebuilding', async t => {
  const f = await fixture(t); let attempts = 0, broken = true;
  const delivery = createReplyDelivery({ ...f.ports, accept: async message => {
    if (message.id === 'a1') { attempts++; if (broken) throw new Error('temporary acceptance failure'); }
  } });
  delivery.prepare([reply('a1'), reply('a2'), reply('b1', 'b')]);
  const recovered = await delivery.recover(); assert.equal(recovered.failures.length, 1);
  assert.deepEqual(f.messages.map(row => row.id), ['a1', 'b1']);
  const row = f.store.read().deliveries.a1; assert.ok(row.canonicalCommittedAt); assert.equal(row.state, 'prepared');
  assert.equal(row.settlement.status, 'failed'); assert.equal(f.store.read().deliveries.b1.state, 'delivered');
  await delivery.recover(); assert.equal(attempts, 1); assert.equal(f.store.read().deliveries.a2.canonicalCommittedAt, undefined);
  f.store.close(); rmSync(path.join(f.rootDir, 'w/.read-models'), { recursive: true, force: true });
  const restored = createWorkCoordinationStore(f.options); await restored.prepare();
  try {
    assert.deepEqual(restored.read().deliveries.a1, row);
    broken = false; f.advance(2000);
    await createReplyDelivery({ ...f.ports, store: restored, accept: async message => { if (message.id === 'a1') attempts++; } }).recover();
    assert.equal(restored.read().deliveries.a2.state, 'delivered'); assert.equal(attempts, 2);
    assert.equal(f.messages.filter(row => row.id === 'a1').length, 1);
  } finally { restored.close(); }
});

test('crash windows recover canonical append and settlement separately without replaying known effects', async t => {
  for (const window of ['canonical', 'acceptance', 'settled']) {
    await t.test(window, async t => {
      const f = await fixture(t); let armed = true;
      const crash = () => { armed = false; throw Object.assign(new Error('coordination_simulated_crash'), { code: 'coordination_simulated_crash' }); };
      const store = { ...f.store, recordDelivery(entry) { const result = f.store.recordDelivery(entry);
        if (armed && window === 'settled' && entry.kind === 'reply_settled') crash(); return result; } };
      const ports = { ...f.ports, store, appendMessage: message => { f.messages.push(message); if (armed && window === 'canonical') crash(); },
        accept: async (message, receipt) => { await f.ports.accept(message, receipt); if (armed && window === 'acceptance') crash(); } };
      await assert.rejects(createReplyDelivery(ports).deliver(reply('r')), /simulated_crash/);
      const before = f.store.read().deliveries.r;
      assert.equal(before.state, 'prepared'); assert.equal(Boolean(before.canonicalCommittedAt), window !== 'canonical');
      await createReplyDelivery(f.ports).recover();
      assert.equal(f.messages.length, 1); assert.equal(f.effects(), 1);
      assert.equal(f.store.read().deliveries.r.state, 'delivered');
    });
  }
});

test('a new independent user input reaches the real Runner while another work settlement remains failed', async t => {
  const f = await fixture(t); let requests = 0;
  f.store.saveWork({ workId: 'old', workspaceId: 'w', parentConversationId: 'p', state: 'retry_wait', anchorInputIds: ['old'], sessionIds: [] });
  const accept = async message => { if (message.meta.workId === 'old') throw new Error('persistent settlement failure'); };
  await assert.rejects(createReplyDelivery({ ...f.ports, accept }).deliver(reply('old-reply', 'old')));
  const runner = createProjectAgentRunner({ workspaceId: 'w', conversationId: 'p', coordinationStore: f.store, now: f.now,
    inbox: createProjectInbox({ rootDir: f.rootDir }), readMessages: () => f.messages, appendMessage: (_id, message) => f.messages.push(message),
    executeTurn: async ({ plan }) => { requests++; return { toolCalls: [{ name: 'post_reply', input: { text: 'Independent answer', replyTo: [plan.userInputs[0] ? `input-${plan.userInputs[0].inputId}` : ''] }, result: { ok: true } }] }; }, resolveModel: () => ({ modelProviderId: 'm' }),
    onReplied: accept, retryDelays: [], schedule: () => ({ unref() {} }), clearSchedule() {} });
  t.after(() => runner.dispose());
  await runner.enqueueUserInputs([{ inputId: 'new', text: 'Independent question' }]);
  assert.equal(requests, 1); assert.equal(f.store.read().deliveries['old-reply'].state, 'prepared');
  assert.ok(f.messages.some(row => row.kind === 'agent_reply' && row.content === 'Independent answer'));
});

test('an unresolved settlement does not hold the Bot execution lane or start another copy of the callback', async t => {
  const f = await fixture(t); let release, attempts = 0, requests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  f.store.saveWork({ workId: 'old', workspaceId: 'w', parentConversationId: 'p', state: 'retry_wait', anchorInputIds: ['old'], sessionIds: [] });
  createReplyDelivery(f.ports).prepare([reply('old-pending', 'old')]);
  const runner = createProjectAgentRunner({ workspaceId: 'w', conversationId: 'p', coordinationStore: f.store, now: f.now,
    inbox: createProjectInbox({ rootDir: f.rootDir }), readMessages: () => f.messages, appendMessage: (_id, message) => f.messages.push(message),
    executeTurn: async ({ plan }) => { requests++; return { toolCalls: [{ name: 'post_reply', input: { text: 'Independent answer', replyTo: [plan.userInputs[0] ? `input-${plan.userInputs[0].inputId}` : ''] }, result: { ok: true } }] }; }, resolveModel: () => ({ modelProviderId: 'm' }),
    onReplied: async message => { if (message.meta.workId === 'old') { attempts++; await gate; } }, retryDelays: [],
    schedule: () => ({ unref() {} }), clearSchedule() {} });
  t.after(() => runner.dispose());
  await runner.enqueueUserInputs([{ inputId: 'during-pending', text: 'Independent' }]);
  assert.equal(requests, 1); assert.equal(attempts, 1); assert.equal(f.store.read().deliveries['old-pending'].settlement.status, 'pending');
  await runner.kick(); assert.equal(attempts, 1);
  release(); await new Promise(resolve => setImmediate(resolve)); await runner.kick();
  assert.equal(f.store.read().deliveries['old-pending'].state, 'delivered'); assert.equal(requests, 1);
});

test('lease loss after settlement keeps an unknown pending receipt and stops host writes', async t => {
  const f = await fixture(t);
  const delivery = createReplyDelivery({ ...f.ports, accept: async () => f.loseLease() });
  await assert.rejects(delivery.deliver(reply('lease')), /coordination_lease_lost/);
  assert.equal(f.store.read().deliveries.lease.state, 'prepared');
  assert.equal(f.store.read().deliveries.lease.settlement.status, 'pending');
  await assert.rejects(delivery.recover(), /coordination_lease_lost/);
});

test('deferred reply recovery is idempotent on both sides of the digest hold crash window', async t => {
  for (const window of ['before-hold', 'after-hold']) await t.test(window, async t => {
    const f = await fixture(t), file = path.join(f.rootDir, 'digest.json'), queue = createDigestQueue({ file }); let armed = true;
    const fail = () => { armed = false; throw new Error('coordination_simulated_crash'); };
    const store = { ...f.store, recordDelivery(entry) { const saved = f.store.recordDelivery(entry); if (armed && window === 'before-hold' && entry.kind === 'reply_deferred') fail(); return saved; } };
    const hold = message => queue.hold('w', { id: message.id, text: message.content, message });
    const delivery = createReplyDelivery({ ...f.ports, store, onDeferred: message => { hold(message); if (armed && window === 'after-hold') fail(); } });
    await assert.rejects(delivery.defer(reply('deferred')), /simulated_crash/);
    assert.equal(f.store.read().deliveries.deferred.state, 'deferred'); assert.equal(f.messages.length, 0);
    await createReplyDelivery({ ...f.ports, onDeferred: hold }).recover();
    await createReplyDelivery({ ...f.ports, onDeferred: hold }).recover();
    assert.equal(createDigestQueue({ file }).pending('w'), 1); assert.ok(f.store.read().deliveries.deferred.heldAt);
    assert.equal(f.messages.length, 0); assert.equal(f.effects(), 0);
  });
});

test('local semantic failures do not trip Provider health, and real Provider failure stays scoped to its configured channel', async t => {
  const f = await fixture(t), breaker = createCircuitBreaker({ rootDir: f.rootDir, workspaceId: 'w', now: f.now });
  let mode = 'local', modelProviderId = 'A', requests = 0;
  const runner = createProjectAgentRunner({ workspaceId: 'w', conversationId: 'p', coordinationStore: f.store, now: f.now, circuitBreaker: breaker,
    inbox: createProjectInbox({ rootDir: f.rootDir }), readMessages: () => f.messages, appendMessage: (_id, message) => f.messages.push(message),
    executeTurn: async () => { requests++; return mode === 'good' ? { text: 'Good' } : { ok: false, retryable: false, error: mode === 'local' ? 'agent_no_progress' : 'HTTP 503' }; },
    resolveModel: () => ({ modelProviderId }), retryDelays: [], schedule: () => ({ unref() {} }), clearSchedule() {} });
  t.after(() => runner.dispose());
  for (let i = 0; i < 6; i++) await runner.enqueueUserInputs([{ inputId: `local-${i}`, text: 'Local case' }]);
  assert.equal(breaker.state({ scopeKey: 'A' }).failures, 0); assert.equal(requests, 6);
  mode = 'provider';
  for (let i = 0; i < 5; i++) await runner.enqueueUserInputs([{ inputId: `provider-${i}`, text: 'Provider case' }]);
  assert.equal(breaker.state({ scopeKey: 'A' }).status, 'open');
  const before = requests; await runner.enqueueUserInputs([{ inputId: 'blocked-A', text: 'Blocked' }]); assert.equal(requests, before);
  modelProviderId = 'B'; mode = 'good';
  await runner.enqueueUserInputs([{ inputId: 'configured-B', text: 'User changed configured channel' }]);
  assert.equal(requests, before + 2, 'the previously admitted but unexecuted input also survives the channel change');
  assert.equal(breaker.state({ scopeKey: 'A' }).status, 'open');
  const restarted = createCircuitBreaker({ rootDir: f.rootDir, workspaceId: 'w', now: f.now });
  assert.equal(restarted.admit({ scopeKey: 'A' }).allowed, false); assert.equal(restarted.admit({ scopeKey: 'B' }).allowed, true);
});
