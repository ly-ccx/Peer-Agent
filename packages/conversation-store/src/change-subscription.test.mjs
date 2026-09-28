import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createConversationStore } from './index.mjs';

function waitFor(predicate, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('change event timed out')), timeoutMs);
    const poll = setInterval(() => {
      if (!predicate()) return;
      clearInterval(poll);
      clearTimeout(timeout);
      resolve();
    }, 10);
  });
}

test('subscribeChanges sees a write that lands before the first poll', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-conv-sub-'));
  const desktop = createConversationStore({ storeDir: dir });
  const writer = createConversationStore({ storeDir: dir });
  const events = [];
  const unsubscribe = desktop.subscribeChanges((event) => {
    events.push(event);
  }, { interval: 20 });
  try {
    const conversation = writer.createConversation({ title: 'from writer', workspacePath: '/workspace' });
    await waitFor(() => events.length === 1);
    assert.equal(events[0].conversationId, conversation.id);
    assert.equal(events[0].workspacePath, '/workspace');
    assert.equal(events[0].changeType, 'created');
    assert.equal(typeof events[0].revision, 'string');
  } finally {
    unsubscribe();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subscribeChanges does not replay the revision already on disk', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-conv-sub-baseline-'));
  const writer = createConversationStore({ storeDir: dir });
  const existing = writer.createConversation({ title: 'already there' });
  const desktop = createConversationStore({ storeDir: dir });
  const events = [];
  const unsubscribe = desktop.subscribeChanges((event) => {
    events.push(event);
  }, { interval: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(events, []);
    writer.updateTitle(existing.id, 'renamed');
    await waitFor(() => events.length === 1);
    assert.equal(events[0].conversationId, existing.id);
    assert.equal(events[0].changeType, 'metadata-updated');
  } finally {
    unsubscribe();
    rmSync(dir, { recursive: true, force: true });
  }
});
