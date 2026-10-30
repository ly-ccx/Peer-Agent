import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCircuitBreaker } from './circuit-breaker.mjs';
import { createProjectAgentRunner } from './runner.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';

async function world(executeTurn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-circuit-recovery-'));
  let clock = Date.parse('2026-10-30T00:00:00Z');
  const now = () => new Date(clock).toISOString();
  const store = createWorkCoordinationStore({ rootDir: root, workspaceId: 'w', formatVersion: 2,
    holdsLease: () => true, leaseEpoch: () => 'owner', now });
  await store.prepare();
  const breaker = createCircuitBreaker({ rootDir: root, workspaceId: 'w', now });
  const messages = [];
  const runner = createProjectAgentRunner({ workspaceId: 'w', conversationId: 'c', now,
    inbox: createProjectInbox({ rootDir: root }), coordinationStore: store, circuitBreaker: breaker,
    executeTurn, resolveModel: () => ({ modelProviderId: 'm' }), retryDelays: [],
    appendMessage: (_id, message) => messages.push(message), readMessages: () => messages });
  return { store, breaker, runner, messages, advance: ms => { clock += ms; },
    close() { runner.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('fresh inputs during a SQLite-backed circuit cooldown neither execute nor extend the failure window', async () => {
  let requests = 0;
  const env = await world(async () => { requests++; return { text: 'done' }; });
  try {
    for (let n = 0; n < 5; n++) env.breaker.failure({ turnId: `network-${n}`, reason: 'offline' });
    const before = env.breaker.state();
    for (const inputId of ['why-stopped', 'question']) {
      env.advance(60_000);
      await env.runner.enqueueUserInputs([{ inputId, text: '继续' }]);
      assert.deepEqual(env.breaker.state(), before);
    }
    assert.equal(requests, 0);
    assert.deepEqual(env.store.readSnapshot().works, {});
    assert.equal(env.messages.some(row => row.id?.startsWith('failed-')), false);
  } finally { env.close(); }
});

test('a recovered half-open slice releases admission and continues its checkpoint without restarting the app', async () => {
  let requests = 0;
  const env = await world(async ({ turnProfile }) => {
    requests++;
    if (requests === 1) return { turnEnd: 'yielded', providerCheckpoint: { progress: 'saved' },
      toolCalls: [{ name: 'read_file', input: { path: 'report' }, result: { text: 'real progress' } }] };
    assert.equal(turnProfile.providerCheckpoint.progress, 'saved');
    return { text: '恢复完成' };
  });
  try {
    for (let n = 0; n < 5; n++) env.breaker.failure({ turnId: `network-${n}`, reason: 'offline' });
    env.advance(10 * 60_000);
    await env.runner.enqueueUserInputs([{ inputId: 'continue', text: '继续' }]);
    assert.equal(requests, 1);
    assert.equal(env.breaker.state().status, 'closed');
    assert.equal(Object.values(env.store.readSnapshot().works)[0].state, 'runnable');
    assert.equal(env.messages.some(row => row.kind === 'agent_reply'), false);
    await env.runner.kick();
    assert.equal(requests, 2);
    assert.equal(Object.values(env.store.readSnapshot().works)[0].state, 'delivered');
    assert.equal(env.breaker.state().failures, 0);
  } finally { env.close(); }
});
