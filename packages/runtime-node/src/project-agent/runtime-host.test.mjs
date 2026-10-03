import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectAgentHost } from './runtime-host.mjs';

function harness(executeTurn = async () => ({ text: 'reply' })) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-targeted-wake-'));
  let ids = ['a', 'b'];
  const leased = new Set(ids), stopped = [], messages = [];
  const host = createProjectAgentHost({
    rootDir,
    listWorkspaceIds: () => ids, holdsLease: id => leased.has(id), resolveConversationId: id => `conv-${id}`,
    appendMessage: (conversationId, message) => messages.push({ ...message, conversationId }),
    readMessages: conversationId => messages.filter(message => message.conversationId === conversationId),
    hasMessage: (conversationId, id) => messages.some(message => message.conversationId === conversationId && message.id === id),
    stopWatches: id => stopped.push(id), executeTurn,
    resolveModel: () => ({ ok: true, modelProviderId: 'scripted', reasons: [] }),
  });
  return { host, leased, stopped, messages, close: () => { host.dispose(); rmSync(rootDir, { recursive: true, force: true }); },
    remove: id => { ids = ids.filter(value => value !== id); } };
}

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
