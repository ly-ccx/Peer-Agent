import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ContextAccountingSnapshot } from '@peer-agent/protocol';
// @ts-expect-error Main-process JavaScript has no declarations; integration fixture only.
import { createConversationStore } from '../../../../electron/main/conversation-store.mjs';
import { acceptAccountingSnapshot } from './contextAccountingSnapshot.ts';

// Exercise the real store + lifecycle + renderer admission rule across compaction
// epoch transitions without credentials or provider requests.
for (const loadedBeforeCompaction of [false, true]) {
  for (const delivery of ['immediate', 'deferred-flush']) {
  for (const known of [true, false]) {
  test(`post-compaction live equals reload (loaded: ${loadedBeforeCompaction}, delivery: ${delivery}, known: ${known})`, () => {
    const store = createConversationStore({
      storeDir: mkdtempSync(join(tmpdir(), 'peer-accounting-regression-')),
    });
    const conv = store.createConversation({ title: 'isolated accounting regression' });
    store.updateModelEffort(conv.id, { modelProviderId: 'provider-1', model: 'model-1' });
    const initial: ContextAccountingSnapshot = {
      version: 1, conversationId: conv.id, contentRevision: 0,
      modelKey: 'provider-1::model-1', revision: 1, phase: 'turn_complete',
      compactionEpoch: 0, contextWindow: 100000, inputBudget: 100000,
      compactionThresholdTokens: 80000, authoritativeInputTokens: 80000,
      percent: 80, pressureSource: 'provider_usage',
      pendingUncountedChanges: false, pendingContentChars: 0,
      countCapability: { kind: 'observed_usage_only' },
      counterStatus: 'active', updatedAt: 1,
    };
    let live: ContextAccountingSnapshot | null = null;
    const emitted: ContextAccountingSnapshot[] = [];
    let pending: ContextAccountingSnapshot | null = null;
    const persist = (snapshot: ContextAccountingSnapshot) => {
      store.updateContextSnapshot(conv.id, snapshot);
      live = acceptAccountingSnapshot(live, snapshot);
    };
    const emitAccounting = (snapshot: ContextAccountingSnapshot) => {
      if (delivery === 'immediate' || snapshot.compactionEpoch === 0) {
        persist(snapshot);
      } else {
        pending = snapshot;
      }
      emitted.push(snapshot);
      live = acceptAccountingSnapshot(live, snapshot);
    };
    store.appendMessage(conv.id, { id: 'tail', role: 'assistant', content: 'before compaction' });
    emitAccounting({
      ...initial,
      contentRevision: store.getConversation(conv.id).contentRevision,
    });
    if (loadedBeforeCompaction) live = store.getConversation(conv.id).contextSnapshot;
    const old = emitted[0]!;
    store.replaceMessages(conv.id, [{ id: 'summary', role: 'user', content: 'summary' }]);
    emitAccounting({
      ...initial,
      contentRevision: store.getConversation(conv.id).contentRevision,
      revision: 2,
      compactionEpoch: 1,
      authoritativeInputTokens: known ? 10000 : null,
      percent: known ? 10 : null,
      pressureSource: known ? 'provider_usage' : 'unknown',
      updatedAt: 2,
    });
    if (pending) persist(pending);
    const restored = store.getConversation(conv.id).contextSnapshot;
    assert.equal(restored.percent, known ? 10 : null, 'preserve known or unknown post-compaction truth');
    assert.equal(live?.percent, restored.percent, 'staying must agree with switching back');
    assert.equal(live?.compactionEpoch, 1, 'new epoch reaches the display cache scope');
    live = acceptAccountingSnapshot(live, old);
    assert.equal(live?.percent, known ? 10 : null, 'delayed pre-compaction event must not restore 80%');
  });
  }
  }
}
