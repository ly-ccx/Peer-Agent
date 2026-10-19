import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationDispatchRecovery } from './verification-dispatch-recovery.mjs';
import { createRunnerCoordination } from './runner-coordination.mjs';

test('verification sweep never clones the full historical ledger for each work', () => {
  const works = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`w${n}`, {
    workId: `w${n}`, state: 'delivered', budget: { history: 'x'.repeat(8192) },
  }]));
  let fullReads = 0, workReads = 0;
  const recovery = createVerificationDispatchRecovery({
    store: { read() { fullReads++; return structuredClone({ works }); },
      readWork(id) { workReads++; return structuredClone(works[id]); } },
    readMessages: () => [], activeAttempts: () => new Set(),
    reconcileVerification() { assert.fail('terminal work cannot require verification'); },
  });
  recovery.reconcileAll();
  assert.equal(fullReads, 1, 'only the inventory discovery may clone the full ledger');
  assert.equal(workReads, 0, 'unrelated historical work is excluded before per-work inspection');
});

test('an event transfer shares one lazy roster and the next transfer rechecks it', () => {
  let rosterReads = 0;
  const pending = Array.from({ length: 20 }, (_, n) => ({ eventId: `e${n}`, kind: 'report_available', sessionId: `s${n}` }));
  const works = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`w${n}`, {
    workId: `w${n}`, state: 'blocked_system', recovery: {}, sessionIds: [`s${n}`],
  }]));
  const coordination = createRunnerCoordination({ workspaceId: 'ws', conversationId: 'c',
    store: { recover() {}, read: () => ({ works }), pendingEvents: () => pending,
      handled() { assert.fail('a result event cannot be acknowledged as routine'); } },
    inbox: { takeBatch: () => ({ events: [] }) },
    resolveRoster() { rosterReads++; return []; },
  });
  assert.deepEqual(coordination.transfer(), pending);
  assert.equal(rosterReads, 1);
  assert.deepEqual(coordination.transfer(), pending);
  assert.equal(rosterReads, 2, 'a new transfer must not reuse old child facts');
});

test('delivered-reply recovery reads the owning work without cloning every unrelated work', async () => {
  const works = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`w${n}`, { workId: `w${n}`, state: 'delivered' }]));
  const deliveries = Object.fromEntries(Object.keys(works).map(id => [id, { state: 'delivered', message: { id, meta: { workId: id } } }]));
  let fullReads = 0, workReads = 0;
  const coordination = createRunnerCoordination({ workspaceId: 'ws', conversationId: 'c',
    store: { read() { fullReads++; return structuredClone({ works, deliveries }); },
      readWork(id) { workReads++; return structuredClone(works[id]); } },
  });
  await coordination.recover();
  assert.equal(fullReads, 2, 'one verification inventory and one delivery inventory');
  assert.equal(workReads, 200, 'each delivered receipt reads only its own current work');
});

test('an open circuit restores known card identities without loading conversation bodies', async () => {
  const { createProjectAgentRunner } = await import('./runner.mjs');
  let fullReads = 0;
  const runner = createProjectAgentRunner({ workspaceId: 'ws', conversationId: 'c',
    holdsLease: () => true, inbox: { takeBatch: () => ({ events: [] }), append() {}, commitBatch() {} },
    readMessages() { fullReads++; return [{ id: 'prior' }, { id: 'prior-card' }]; },
    hasMessage: (_conversation, id) => ['prior', 'prior-card'].includes(id),
    appendMessage() { assert.fail('both persisted messages already exist'); },
    executeTurn() { assert.fail('an open circuit must not execute'); },
    circuitBreaker: { state: () => ({ status: 'open', lastTurnId: 'prior' }), admit: () => ({ allowed: false }) },
  });
  fullReads = 0; // Initial continuity hydration still uses the canonical history.
  try { await runner.enqueueUserInputs([{ inputId: 'i', text: 'check' }]); assert.equal(fullReads, 0); }
  finally { runner.dispose(); }
});

test('disposing during the event-loop handoff prevents the queued model request', async () => {
  const { createProjectAgentRunner } = await import('./runner.mjs');
  let requests = 0;
  const runner = createProjectAgentRunner({ workspaceId: 'ws', conversationId: 'c', holdsLease: () => true,
    inbox: { takeBatch: () => ({ events: [] }), commitBatch() {} },
    readMessages: () => [], appendMessage() {}, resolveModel: () => ({ modelProviderId: 'm' }),
    executeTurn() { requests++; return { text: 'unexpected' }; },
  });
  const pending = runner.enqueueUserInputs([{ inputId: 'i', text: 'check' }]);
  runner.dispose(); await pending;
  assert.equal(requests, 0);
});

test('pending input ownership is read once for the batch and does not imply completion', () => {
  let reads=0;
  const works={a:{anchorInputIds:['i1','i2'],state:'runnable'}, b:{anchorInputIds:['i2','i3'],state:'cancelled'}};
  const coordination=createRunnerCoordination({workspaceId:'ws',conversationId:'c',store:{read(){reads++;return{works};}}});
  assert.deepEqual(coordination.ownedInputIds(),['i1','i2','i3']);assert.equal(reads,1);
  works.a.anchorInputIds.push('new');assert.ok(coordination.ownedInputIds().includes('new'));assert.equal(reads,2);
});
