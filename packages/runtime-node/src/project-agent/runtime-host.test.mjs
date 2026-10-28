import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectAgentHost } from './runtime-host.mjs';

function harness(executeTurn = async () => ({ text: 'reply' }), extra = {}) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-targeted-wake-'));
  let ids = ['a', 'b'];
  const leased = new Set(ids), stopped = [], messages = [];
  const host = createProjectAgentHost({
    rootDir, readLeaseEpoch: () => 'isolated-test-owner',
    listWorkspaceIds: () => ids, holdsLease: id => leased.has(id), resolveConversationId: id => `conv-${id}`,
    appendMessage: (conversationId, message) => messages.push({ ...message, conversationId }),
    readMessages: conversationId => messages.filter(message => message.conversationId === conversationId),
    hasMessage: (conversationId, id) => messages.some(message => message.conversationId === conversationId && message.id === id),
    stopWatches: id => stopped.push(id), executeTurn,
    resolveModel: () => ({ ok: true, modelProviderId: 'scripted', reasons: [] }),
    ...extra,
  });
  return { host, leased, stopped, messages, close: () => { host.dispose(); rmSync(rootDir, { recursive: true, force: true }); },
    remove: id => { ids = ids.filter(value => value !== id); } };
}

test('maintenance drains a startup already in flight and rejects incidental restarts until explicit release', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  let executions = 0;
  const h = harness(async () => { executions++; return { text: 'reply' }; }, {
    recoverTasks: async () => { entered(); await gate; },
  });
  try {
    const pending = h.host.sync(['a']); await started;
    h.host.beginMaintenance('a');
    await assert.rejects(h.host.restart('a'), /coordination_maintenance_pending/);
    let drained = false; const idle = h.host.waitForIdle('a').then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    release(); await pending; await idle;
    assert.equal(h.host.isReady('a'), false); assert.equal(h.host.runnerFor('a'), null); assert.equal(executions, 0);
    h.host.endMaintenance('a'); await h.host.restart('a'); assert.equal(h.host.isReady('a'), true);
  } finally { release(); h.close(); }
});

test('targeted wake keeps other bot runners and their in-flight turns alive', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const calls = [];
  let signal;
  const h = harness(async input => {
    calls.push(input.turnProfile.workspaceId);
    if (input.turnProfile.workspaceId === 'a') { signal = input.signal; entered(); await gate; }
    return { text: 'reply' };
  });
  try {
    await h.host.sync();
    const runnerA = h.host.runnerFor('a');
    h.host.inputQueue.submitInput({ workspaceId: 'a', inputId: 'input-a', text: 'first', surface: 'desktop' });
    const pending = h.host.sync(['a']);
    await started;
    h.host.inputQueue.submitInput({ workspaceId: 'b', inputId: 'input-b', text: 'second', surface: 'quick_chat' });
    await h.host.sync(['b']);
    assert.equal(h.host.runnerFor('a'), runnerA);
    assert.equal(h.host.isReady('a'), true);
    assert.equal(signal?.aborted, false);
    assert.deepEqual(h.stopped, []);
    release(); await pending;
    assert.deepEqual(calls, ['a', 'b']);
    assert.equal(h.messages.filter(message => message.kind === 'agent_reply').length, 2);
    await h.host.sync();
    assert.deepEqual(calls, ['a', 'b'], 'completed inputs must not replay');
  } finally { release(); h.close(); }
});

test('host restart leaves failed anchors with coordination and admits only genuinely new input', async () => {
  let calls = 0;
  const h = harness(async ({ plan }) => {
    calls++;
    if (calls === 1) return { ok: false, error: 'ConnectTimeoutError', providerRecovery: { kind: 'network', retryable: true } };
    assert.equal(plan.userInputs[0].inputId, 'new');
    assert.equal(plan.turnProfile.providerCheckpoint, undefined);
    return { text: '新的问题已回复。' };
  }, { now: () => '2026-10-10T06:00:00Z', schedule: () => 1, clearSchedule: () => {} });
  try {
    h.host.inputQueue.submitInput({ workspaceId: 'a', inputId: 'old', text: '原目标', surface: 'desktop' });
    await h.host.sync(['a']); assert.equal(calls, 1);
    h.leased.delete('a'); await h.host.sync();
    h.leased.add('a'); await h.host.sync(['a']);
    assert.equal(calls, 1);
    assert.equal(h.host.runnerFor('a').ownsInput('old'), true);
    h.host.inputQueue.submitInput({ workspaceId: 'a', inputId: 'new', text: '新的问题', surface: 'desktop' });
    await h.host.sync(['a']); assert.equal(calls, 2);
  } finally { h.close(); }
});

test('targeted sync still drops unrequested bots whose lease or registration was removed', async () => {
  for (const reason of ['lease', 'registration']) {
    const h = harness();
    try {
      await h.host.sync(); assert.ok(h.host.runnerFor('b'));
      if (reason === 'lease') h.leased.delete('b'); else h.remove('b');
      await h.host.sync(['a']);
      assert.equal(h.host.runnerFor('b'), null);
      assert.equal(h.host.isReady('b'), false);
      assert.deepEqual(h.stopped, ['b']);
      assert.ok(h.host.runnerFor('a'));
    } finally { h.close(); }
  }
});


test('a stopped response is never replayed after lease recovery, even if execution acknowledgement was lost', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const h = harness(async ({ sink, streamId, signal }) => {
    calls++; sink.send('chat:stream:delta', { streamId, content: 'partial' }); started(streamId);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { terminalStatus: 'aborted', text: 'partial' };
  });
  try {
    h.host.inputQueue.submitInput({ workspaceId: 'a', inputId: 'stopped', text: 'stop me', surface: 'desktop' });
    const sync = h.host.sync(['a']);
    const id = await ready;
    // Simulate a durable acknowledgement failure, then recover from canonical facts.
    h.host.inputQueue.completeExecution = () => { throw Error('ack interrupted'); };
    assert.equal(h.host.runnerFor('a').stopResponse(id).ok, true);
    await sync;
    assert.equal(h.messages.some(message => message.card === 'agent_stopped'), true);
    h.leased.delete('a'); await h.host.sync();
    h.leased.add('a'); await h.host.sync(['a']);
    assert.equal(calls, 1);
    assert.equal(h.host.runnerFor('a').activity(), null);
  } finally { h.close(); }
});

test('new input preempts a background model request after delivery without waiting for its response or replaying its events', async () => {
  let start, release, wakeCalls = 0;
  const started = new Promise(resolve => { start = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const seen = [];
  const h = harness(async ({ plan, signal }) => {
    if (plan.kind === 'wake' && ++wakeCalls === 1) {
      start();
      await Promise.race([blocked, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
      return signal.aborted ? { preempted: true } : { text: '' };
    }
    if (plan.kind === 'user') { seen.push(plan.userInputs[0].inputId); assert.equal(plan.events.length, 0); return { text: '已接手新问题。' }; }
    return { text: '' };
  });
  let background, foreground;
  try {
    await h.host.sync(['a']);
    h.host.inbox.append('a', [{ eventId: 'completed-event', kind: 'report_available', sessionId: 'old-session', at: new Date().toISOString(), payload: {} }]);
    background = h.host.sync(['a']);
    await started;
    h.host.inputQueue.submitInput({ workspaceId: 'a', inputId: 'new-priority', text: '新的问题', surface: 'desktop' });
    foreground = h.host.sync(['a']);
    await Promise.race([foreground, new Promise(resolve => setTimeout(resolve, 150))]);
    assert.deepEqual(seen, ['new-priority']);
    assert.equal(h.messages.some(row => row.card === 'agent_unavailable'), false);
  } finally { release(); await Promise.allSettled([background, foreground]); h.close(); }
});

test('idle maintenance with no pending input never loads full conversation bodies', async () => {
  let reads = 0;
  const h = harness(undefined, { readMessages: () => { reads++; return []; } });
  try {
    await h.host.sync(); reads = 0;
    await h.host.sync();
    assert.equal(reads, 0);
  } finally { h.close(); }
});

test('pending input acknowledgements use exact reply facts without loading model history', async () => {
  let reads = 0, facts = 0, requests = 0, h;
  h = harness(async () => { requests++; return { text: 'unexpected' }; }, {
    readMessages: () => { reads++; return h?.messages || []; },
    readInputFacts: id => { facts++; return h.messages.filter(message => message.conversationId === id); },
  });
  try {
    await h.host.sync(); reads = 0;
    h.messages.push({ conversationId: 'conv-a', id: 'reply', role: 'assistant', kind: 'agent_reply', replyTo: ['input-known'] });
    h.host.inputQueue.submitInput({ workspaceId: 'a', inputId: 'known', text: 'already answered', surface: 'desktop' });
    await h.host.sync(['a']);
    assert.ok(facts > 0); assert.equal(reads, 0); assert.equal(requests, 0);
    assert.deepEqual(h.host.inputQueue.pendingExecution('a'), []);
  } finally { h.close(); }
});
