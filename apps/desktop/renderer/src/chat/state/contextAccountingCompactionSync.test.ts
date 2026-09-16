import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ContextAccountingSnapshot } from '@peer-agent/protocol';
// @ts-expect-error Main-process JavaScript has no declarations; integration fixture only.
import { createConversationStore } from '../../../../electron/main/conversation-store.mjs';
// @ts-expect-error Main-process JavaScript has no declarations; integration fixture only.
import { createAgentLoopKernel } from '../../../../electron/main/chat-runtime/agent-loop-kernel.mjs';
import { acceptAccountingSnapshot } from './contextAccountingSnapshot.ts';
// @ts-expect-error Main-process JavaScript has no declarations; integration fixture only.
import { persistContextAccounting } from '../../../../electron/main/chat-runtime/persist-context-accounting.mjs';

// Exercise the real store + lifecycle + renderer admission rule. The callback
// reproduces llm-chat-service's persistence followed by forwarding the raw event.
// No credentials, provider requests, or daily conversation data are used.
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
    const persist = (snapshot: ContextAccountingSnapshot) => persistContextAccounting({
      store, conversationId: conv.id, streamId: 'regression', snapshot,
      emit(persisted: { snapshot: ContextAccountingSnapshot }) {
        live = acceptAccountingSnapshot(live, persisted.snapshot);
      },
    });
    const loop = createAgentLoopKernel({
      conversationId: conv.id, streamId: 'regression',
      accountingIdentity: initial, initialContextAccounting: initial,
      emitRuntimeEvent(event: { snapshot: ContextAccountingSnapshot }) {
        if (delivery === 'immediate' || event.snapshot.compactionEpoch === 0) {
          persist(event.snapshot);
        } else {
          pending = event.snapshot;
        }
        emitted.push(event.snapshot);
        live = acceptAccountingSnapshot(live, event.snapshot);
      },
    });
    store.appendMessage(conv.id, { id: 'tail', role: 'assistant', content: 'before compaction' });
    loop.acceptContextAccounting(initial);
    if (loadedBeforeCompaction) live = store.getConversation(conv.id).contextSnapshot;
    const old = emitted[0];
    store.replaceMessages(conv.id, [{ id: 'summary', role: 'user', content: 'summary' }]);
    loop.acceptContextAccounting({
      ...initial, compactionEpoch: 1,
      authoritativeInputTokens: known ? 10000 : null,
      percent: known ? 10 : null,
      pressureSource: known ? 'provider_usage' : 'unknown',
    });
    // Exercise deferred persistence separately from raw-event delivery. Actual
    // timer and terminal scheduling still needs service-level verification.
    if (pending) persist(pending);
    const restored = store.getConversation(conv.id).contextSnapshot;
    assert.equal(restored.percent, known ? 10 : null, 'preserve known or unknown post-compaction truth');
    assert.equal(live?.percent, restored.percent, 'staying must agree with switching back');
    assert.equal(live?.compactionEpoch, 1, 'new epoch reaches the display cache scope');
    live = acceptAccountingSnapshot(live, old);
    assert.equal(live.percent, known ? 10 : null, 'delayed pre-compaction event must not restore 80%');
  });
  }
  }
}
