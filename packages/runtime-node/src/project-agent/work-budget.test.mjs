import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget, createWorkBudgetGuard, workBudgetCanResume, workBudgetBinding } from './work-budget.mjs';

test('an explicit cost reservation is temporary and release can resume without raising the limit', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'reserved-work-budget-'));
  const store = createWorkCoordinationStore({ rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'one' });
  const release = registerWorkBudget('w', store, { maxCostUsd: 10 });
  store.saveWork({ workId: 'goal', state: 'runnable' });
  const profile = { workspaceId: 'w', workId: 'goal', role: 'work_session' };
  try {
    const first = createWorkBudgetGuard(profile), second = createWorkBudgetGuard(profile);
    first.beforeRequest();
    assert.throws(() => second.beforeRequest(), error => error.boundary.reason === 'reservation_pending');
    second.finish();
    store.saveWork({ ...store.read().works.goal, state: 'budget_limited' });
    const limits = workBudgetBinding('w').limits;
    assert.equal(workBudgetCanResume(store.read().works.goal, limits), false);
    first.finish({ totalTokens: 2, estimatedCostUsd: 3 });
    const saved = store.read().works.goal;
    assert.equal(saved.budget.modelRequests, 1); assert.equal(saved.budget.costUsd, 3);
    assert.equal(workBudgetCanResume(saved, limits), true);
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test('unknown child effects fence that executor while coordinator and unrelated child retain compute',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'scoped-work-budget-'));
  const store=createWorkCoordinationStore({rootDir:root,workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'one'});
  store.saveWork({workId:'goal',state:'waiting_children'});
  const release=registerWorkBudget('w',store);
  const profile=planId=>({workspaceId:'w',workId:'goal',planId,role:planId?'work_session':'project_agent'});
  try{
    const a=createWorkBudgetGuard(profile('A')); a.beforeRequest(); a.beforeTool({toolCallId:'write',capabilityId:'local.file.write'}); a.finish({totalTokens:3,estimatedCostUsd:0});
    assert.equal(store.read().works.goal.budget.uncertainDispatches[0].planId,'A');
    assert.throws(()=>createWorkBudgetGuard(profile('A')).beforeRequest(),/execution_outcome_unknown/);
    const b=createWorkBudgetGuard(profile('B')), coordinator=createWorkBudgetGuard(profile());
    b.beforeRequest(); coordinator.beforeRequest();
    b.finish({totalTokens:2,estimatedCostUsd:0}); coordinator.finish({totalTokens:1,estimatedCostUsd:0});
    assert.equal(store.read().works.goal.budget.modelRequests,3);
    assert.equal(store.read().works.goal.budget.uncertainDispatches.length,1);
    store.saveWork({workId:'goal',state:'cancelled',stopScope:'work'});
    assert.throws(()=>createWorkBudgetGuard(profile('B')).beforeRequest(),/work_execution_stopped/);
  }finally{release();rmSync(root,{recursive:true,force:true});}
});

test('a stopped parent reply cannot revoke its admitted children; root and budget stops still fence them',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'reply-scoped-budget-'));
  const store=createWorkCoordinationStore({rootDir:root,workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'one'});
  const release=registerWorkBudget('w',store);
  const child={workspaceId:'w',workId:'goal',planId:'A',role:'work_session'};
  try {
    for (const state of ['paused','cancelled','blocked_system']) {
      store.saveWork({workId:'goal',state,stopScope:'reply'});
      const guard=createWorkBudgetGuard(child);
      guard.beforeRequest(); guard.beforeTool({toolCallId:'read'});
      guard.checkpoint({},[{call:{toolCallId:'read'},result:{ok:true}}]);
      guard.finish({totalTokens:1,estimatedCostUsd:0});
      assert.throws(()=>createWorkBudgetGuard({...child,role:'project_agent'}).beforeRequest(),/work_execution_stopped/);
    }
    for (const [state,stopScope] of [['cancelled','work'],['paused','work'],['budget_limited','reply']]) {
      store.saveWork({workId:'goal',state,stopScope});
      assert.throws(()=>createWorkBudgetGuard(child).beforeRequest(),/work_execution_stopped/);
    }
  } finally {release();rmSync(root,{recursive:true,force:true});}
});

test('budget changes read only the owned work when the host provides an isolated work reader', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'single-work-budget-'));
  const store = createWorkCoordinationStore({ rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'one' });
  store.saveWork({ workId: 'goal', state: 'runnable' });
  let fullReads = 0;
  const release = registerWorkBudget('w', { ...store, read() { fullReads++; return store.read(); } });
  try {
    const guard = createWorkBudgetGuard({ workspaceId: 'w', workId: 'goal', role: 'project_agent' });
    guard.beforeRequest(); guard.beforeTool({ toolCallId: 'read' });
    guard.checkpoint({}, [{ call: { toolCallId: 'read' }, result: { ok: true } }]);
    guard.finish({ totalTokens: 2, estimatedCostUsd: 0 });
    assert.equal(fullReads, 0, 'per-work accounting must not clone the full historical roster');
    assert.equal(store.read().works.goal.budget.toolCalls, 1);
    assert.equal(store.read().works.goal.budget.tokens, 2);
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test('dispatches register durable receipts and settle with classified outcomes (ADR 127 UO-02)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uo-dispatch-receipts-'));
  const store = createWorkCoordinationStore({ rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'one' });
  let clock = 0;
  const release = registerWorkBudget('w', store, {}, () => `2026-11-09T00:00:${String(clock++).padStart(2, '0')}Z`);
  store.saveWork({ workId: 'goal', state: 'runnable' });
  const profile = { workspaceId: 'w', workId: 'goal', role: 'work_session', planId: 'A' };
  try {
    const guard = createWorkBudgetGuard(profile);
    guard.beforeRequest();
    const context = { streamId: 'stream-1', conversationId: 'conv-1' };
    guard.beforeTool({ toolCallId: 'write', capabilityId: 'local.file.write' }, context);
    guard.beforeTool({ toolCallId: 'shell', capabilityId: 'local.shell' }, context);
    guard.beforeTool({ toolCallId: 'perm', capabilityId: 'local.shell' }, context);
    guard.beforeTool({ toolCallId: 'lost', capabilityId: 'local.shell' }, context);

    const attempt = Object.values(store.read().works.goal.budget.attempts)[0];
    assert.deepEqual(attempt.pendingTools.map(row => row.toolCallId), ['write', 'shell', 'perm', 'lost']);
    attempt.pendingTools.forEach((row, index) => {
      assert.match(row.dispatchId, /^dispatch-[0-9a-f]{32}$/);
      assert.equal(row.registeredAt, `2026-11-09T00:00:${String(index).padStart(2, '0')}Z`);
      assert.equal(row.streamId, 'stream-1');
      assert.equal(row.conversationId, 'conv-1');
    });

    guard.checkpoint({}, [
      { call: { toolCallId: 'write' }, result: { ok: true, evidenceRefs: ['tool-result://write'] } },
      { call: { toolCallId: 'shell' }, result: { taskId: 'task-9', status: 'cancelled', interrupted: true, stopReason: 'user_stopped', exitCode: null } },
      { call: { toolCallId: 'perm' }, result: { status: 'denied' } },
    ]);
    const settled = Object.values(store.read().works.goal.budget.attempts)[0];
    assert.deepEqual(settled.pendingTools.map(row => row.toolCallId), ['lost']);
    const outcomes = Object.fromEntries(settled.settledTools.map(row => [row.toolCallId, row.outcome]));
    assert.deepEqual(outcomes, { write: 'resulted', shell: 'terminated', perm: 'not_dispatched' });
    assert.deepEqual(settled.settledTools.find(row => row.toolCallId === 'write').evidenceRefs, ['tool-result://write']);

    guard.finish({ totalTokens: 1, estimatedCostUsd: 0 });
    const budget = store.read().works.goal.budget;
    assert.equal(budget.uncertainDispatches.length, 1);
    assert.equal(budget.uncertainDispatches[0].toolCallId, 'lost');
    assert.match(budget.uncertainDispatches[0].dispatchId, /^dispatch-[0-9a-f]{32}$/);
    assert.equal(budget.uncertainDispatches[0].streamId, 'stream-1');
    const receipts = Object.values(budget.dispatchReceipts);
    assert.equal(receipts.length, 3);
    assert.deepEqual(receipts.map(row => row.outcome).sort(), ['not_dispatched', 'resulted', 'terminated']);
    assert.equal(receipts.every(row => typeof row.settledAt === 'string'), true);
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test('a cancelled receipt without a task never dispatched, and a not_executed output is not a side effect', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uo-dispatch-classify-'));
  const store = createWorkCoordinationStore({ rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'one' });
  const release = registerWorkBudget('w', store);
  store.saveWork({ workId: 'goal', state: 'runnable' });
  const profile = { workspaceId: 'w', workId: 'goal', role: 'work_session', planId: 'A' };
  try {
    const guard = createWorkBudgetGuard(profile);
    guard.beforeRequest();
    guard.beforeTool({ toolCallId: 'pre-abort', capabilityId: 'local.shell' }, { streamId: 's' });
    guard.beforeTool({ toolCallId: 'skipped', capabilityId: 'local.shell' }, { streamId: 's' });
    guard.checkpoint({}, [
      { call: { toolCallId: 'pre-abort' }, result: { taskId: null, status: 'cancelled', exitCode: null } },
      { call: { toolCallId: 'skipped' }, result: { output: JSON.stringify({ ok: false, status: 'not_executed', error: 'work_execution_stopped' }), isError: true }, terminalReason: 'work_execution_stopped' },
    ]);
    guard.finish({ totalTokens: 0, estimatedCostUsd: 0 });
    const receipts = Object.values(store.read().works.goal.budget.dispatchReceipts);
    assert.deepEqual(Object.fromEntries(receipts.map(row => [row.toolCallId, row.outcome])),
      { 'pre-abort': 'not_dispatched', skipped: 'not_dispatched' });
    assert.equal((store.read().works.goal.budget.uncertainDispatches || []).length, 0);
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test('declared dispatch scopes are recorded on registration and reject unresolvable shapes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uo-declared-scopes-'));
  const store = createWorkCoordinationStore({ rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'one' });
  const release = registerWorkBudget('w', store);
  store.saveWork({ workId: 'goal', state: 'runnable' });
  const profile = { workspaceId: 'w', workId: 'goal', role: 'work_session', planId: 'A' };
  try {
    const guard = createWorkBudgetGuard(profile);
    guard.beforeRequest();
    guard.beforeTool({ toolCallId: 'write', capabilityId: 'local.file.write' },
      { streamId: 's', scopes: [{ kind: 'file', path: '/abs/a.ts' }] });
    guard.beforeTool({ toolCallId: 'shell', capabilityId: 'local.shell.exec' },
      { scopes: [{ kind: 'file', path: 'relative/a.ts' }, { kind: 'directory', path: '/abs' }] });
    const attempt = Object.values(store.read().works.goal.budget.attempts)[0];
    const write = attempt.pendingTools.find(row => row.toolCallId === 'write');
    assert.deepEqual(write.declaredScopes, [{ kind: 'file', path: '/abs/a.ts' }]);
    const shell = attempt.pendingTools.find(row => row.toolCallId === 'shell');
    assert.equal('declaredScopes' in shell, false, 'unresolvable scopes stay undeclared and conservative');
    guard.finish({ totalTokens: 0, estimatedCostUsd: 0 });
    assert.deepEqual(store.read().works.goal.budget.uncertainDispatches[0].declaredScopes, [{ kind: 'file', path: '/abs/a.ts' }]);
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});
