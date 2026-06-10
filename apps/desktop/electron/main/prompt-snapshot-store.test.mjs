import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { buildSystemContext } from './llm-prompts.mjs';
import { createPromptSnapshotStore } from './prompt/prompt-snapshot-store.mjs';

function withTempDir(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-agent-prompt-snapshot-'));
  try {
    return callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Prompt snapshot store', () => {
  it('records a prompt context index entry and full context payload', () => withTempDir((storeDir) => {
    const store = createPromptSnapshotStore({
      storeDir,
      clock: () => new Date('2026-06-10T00:00:00.000Z'),
    });
    const context = buildSystemContext('/tmp/workspace', {
      conversationId: 'conv-1',
      provider: 'openai',
      model: 'gpt-test',
      mode: 'chat',
    });

    const entry = store.record(context, {
      streamId: 'stream-1',
      effort: 'default',
      providerId: 'provider-1',
    });

    assert.equal(entry.createdAt, '2026-06-10T00:00:00.000Z');
    assert.equal(entry.streamId, 'stream-1');
    assert.equal(entry.conversationId, 'conv-1');
    assert.equal(entry.providerId, 'provider-1');
    assert.equal(entry.contextSnapshotId, context.snapshot.id);
    assert.equal(entry.renderedHash, context.snapshot.renderedHash);
    assert.equal(store.list()[0].id, entry.id);
    assert.equal(store.get(entry.id).context.rendered, context.rendered);
  }));

  it('keeps only the most recent snapshot index entries when maxEntries is set', () => withTempDir((storeDir) => {
    const store = createPromptSnapshotStore({ storeDir, maxEntries: 1 });

    const first = buildSystemContext('/tmp/one');
    const second = buildSystemContext('/tmp/two');
    store.record(first);
    store.record(second);

    const items = store.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].workspacePath, '/tmp/two');
  }));

  it('records prompt baselines and tracks the latest baseline per conversation', () => withTempDir((storeDir) => {
    const store = createPromptSnapshotStore({
      storeDir,
      clock: () => new Date('2026-06-10T00:00:00.000Z'),
    });
    const first = buildSystemContext('/tmp/workspace', {
      conversationId: 'conv-1',
      provider: 'openai',
      model: 'gpt-test',
      mode: 'compact',
    });
    const second = buildSystemContext('/tmp/workspace', {
      conversationId: 'conv-1',
      provider: 'anthropic',
      model: 'claude-test',
      mode: 'compact',
    });

    const firstEntry = store.recordBaseline(first, {
      conversationId: 'conv-1',
      reason: 'manual_compact',
      streamId: 'stream-1',
    });
    const secondEntry = store.recordBaseline(second, {
      conversationId: 'conv-1',
      reason: 'model_switch',
      streamId: 'stream-2',
    });

    assert.match(firstEntry.baselineId, /^prompt-baseline-/);
    assert.match(firstEntry.contextEpochId, /^context-epoch-/);
    assert.equal(firstEntry.baselineReason, 'manual_compact');
    assert.equal(store.listBaselines().length, 2);
    const latest = store.getLatestBaseline('conv-1');
    assert.equal(latest.baselineId, secondEntry.baselineId);
    assert.equal(latest.contextEpochId, secondEntry.contextEpochId);
    assert.equal(latest.reason, 'model_switch');
    assert.equal(latest.contextSnapshotId, second.snapshot.id);

    const latestEpoch = store.getLatestContextEpoch('conv-1');
    assert.equal(latestEpoch.contextEpochId, secondEntry.contextEpochId);
    assert.equal(latestEpoch.baselineId, secondEntry.baselineId);
    assert.equal(latestEpoch.replacesContextEpochId, firstEntry.contextEpochId);
    assert.equal(latestEpoch.reason, 'model_switch');
    assert.equal(store.listContextEpochs().length, 2);

    const chatTurn = buildSystemContext('/tmp/workspace', {
      conversationId: 'conv-1',
      provider: 'anthropic',
      model: 'claude-test',
      mode: 'chat',
    });
    const chatEntry = store.record(chatTurn, {
      conversationId: 'conv-1',
      contextEpochId: latestEpoch.contextEpochId,
      streamId: 'stream-3',
    });
    assert.equal(chatEntry.contextEpochId, latestEpoch.contextEpochId);
    assert.equal(chatEntry.baselineId, undefined);
    assert.equal(store.listBaselines().length, 2);

    const events = store.listContextEpochEvents({ conversationId: 'conv-1' });
    assert.deepEqual(events.map((event) => event.eventType), [
      'snapshot_anchored',
      'epoch_replaced',
      'epoch_created',
    ]);
    assert.equal(events[0].contextEpochId, latestEpoch.contextEpochId);
    assert.equal(events[0].promptRecordId, chatEntry.id);
    assert.equal(events[1].previousContextEpochId, firstEntry.contextEpochId);
    assert.equal(events[1].baselineId, secondEntry.baselineId);
    assert.equal(events[2].reason, 'manual_compact');

    const secondEpochEvents = store.listContextEpochEvents({
      contextEpochId: latestEpoch.contextEpochId,
    });
    assert.deepEqual(secondEpochEvents.map((event) => event.eventType), [
      'snapshot_anchored',
      'epoch_replaced',
    ]);

    const chain = store.getContextEpochChain({ conversationId: 'conv-1' });
    assert.deepEqual(chain.map((epoch) => epoch.contextEpochId), [
      secondEntry.contextEpochId,
      firstEntry.contextEpochId,
    ]);
  }));
});
