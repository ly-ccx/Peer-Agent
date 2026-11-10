import { registerWorkBudget, workBudgetBinding } from './work-budget.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from '../sqlite/connection.mjs';
import { createExecutionResources, executionProtection, unsettledExecution } from './execution-resources.mjs';
import { executionIdentity } from './session-control-kernel.mjs';
import { beginExecutionAttempt } from './session-facts.mjs';
import { providerExecutionScopes, providerFileScopes, declaredDispatchScopes } from './execution-scopes.mjs';

function plan(id, directory, workspaceId = id) {
  return { planId: id, conversationId: `conversation-${id}`, title: id, status: 'executing', targetWorkspacePath: directory,
    delegationOrigin: { sessionId: `session-${id}`, workspaceId, phase: 'running', coordinationBinding: { executionEpoch: `epoch-${id}` } } };
}
function stopped(store, p, operationId = 'stop', unknownCalls = []) {
  return { receiptId: `receipt-${operationId}`, operationId, execution: executionIdentity(p), admissionClosed: true,
    runnerIdle: true, schedulerIdle: true, resourceClaims: store.claimsFor(p).map(({claimId,revision}) => ({claimId,revision})), unknownCalls, scope: 'managed_execution' };
}
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-resource-contract-')), directory = path.join(root, 'workspace');
  mkdirSync(directory);
  const first = createExecutionResources({ rootDir: path.join(root, 'runtime') });
  const second = createExecutionResources({ rootDir: path.join(root, 'runtime') });
  t.after(() => { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, directory, first, second };
}

test('a live coordinator dispatch is not an unknown execution of its newly queued child', t => {
  const { directory, first } = fixture(t), child = plan('child', directory, 'workspace');
  child.delegationOrigin.phase = 'queued'; child.delegationOrigin.workId = 'work'; child.status = 'paused';
  const work = { budget: { attempts: { parent: { role: 'project_agent', pendingTools: [{ toolCallId: 'spawn', capabilityId: 'spawn_session' }] } } } };
  const release = registerWorkBudget('workspace', { readWork: () => work }); t.after(release);
  workBudgetBinding('workspace').activeAttempts.add('parent');
  first.reconcile([child], () => 'host', () => true);
  assert.deepEqual(first.snapshot(), []);
  assert.deepEqual(unsettledExecution(child), []);
  assert.equal(first.reserve(child, 'host').allowed, true);
  workBudgetBinding('workspace').activeAttempts.delete('parent');
  assert.deepEqual(unsettledExecution(child), ['spawn'], 'an inactive unpaired dispatch still requires a real receipt');
  work.budget.attempts.parent = { ...work.budget.attempts.parent, role: 'work_session', planId: child.planId };
  workBudgetBinding('workspace').activeAttempts.add('parent');
  assert.deepEqual(unsettledExecution(child), ['spawn'], 'the child own live effect stays protected');
});

test('independent connections and workspace IDs arbitrate the same physical directory', t => {
  const { directory, first, second } = fixture(t), a = plan('a', directory), b = plan('b', directory);
  assert.equal(first.reserve(a, 'host-a').allowed, true);
  const decision = second.reserve(b, 'host-b');
  assert.equal(decision.allowed, false);
  assert.equal(decision.blocker.sessionId, a.delegationOrigin.sessionId);
  first.settle(a, stopped(first, a), 'host-a');
  assert.equal(second.reserve(b, 'host-b').allowed, true);
});

test('symlink aliases and a child directory do not bypass an existing write claim', t => {
  const { root, directory, first, second } = fixture(t), alias = path.join(root, 'alias'), child = path.join(directory, 'child');
  symlinkSync(directory, alias); mkdirSync(child);
  first.reserve(plan('a', directory), 'a');
  assert.equal(second.reserve(plan('b', alias), 'b').allowed, false);
  assert.equal(second.reserve(plan('c', child), 'c').allowed, false);
});

test('withdrawal releases execution responsibility while an unknown call still protects its resource', t => {
  const { directory, first, second } = fixture(t), a = plan('a', directory);
  first.reserve(a, 'a'); const receipt = stopped(first, a, 'withdraw', ['actual-tool-call']); first.settle(a, receipt, 'a');
  const decision = second.inspect(plan('b', directory));
  assert.equal(decision.blocker.kind, 'protection');
  assert.equal(decision.blocker.code, 'execution_outcome_unknown');
  assert.deepEqual(decision.blocker.evidenceCalls, ['actual-tool-call']);
  assert.equal(first.revision(), 1);
  first.settle(a, receipt, 'a');
  assert.equal(first.revision(), 1, 'same receipt does not publish a second release');
});

test('a user-authorized closure releases the claim and keeps the unknown call as evidence', t => {
  const { directory, first, second } = fixture(t), a = plan('a', directory);
  first.reserve(a, 'a');
  first.settle(a, stopped(first, a, 'withdraw', ['actual-tool-call']), 'a');
  const claim = first.claimsFor(a)[0];
  assert.equal(claim.state, 'reconciling');
  assert.equal(first.hasClosure(a), false);
  assert.equal(second.reserve(plan('b', directory), 'b').allowed, false);

  const receipt = first.closeClaim(a, { claimId: claim.claimId, claimRevision: claim.revision,
    authorityRef: 'grant-1', unknownCalls: ['actual-tool-call'], proof: 'legacy_user_confirmed', at: '2026-11-09T00:00:00.000Z' });
  assert.equal(receipt.claimId, claim.claimId);
  assert.equal(receipt.unknownCalls[0], 'actual-tool-call');
  assert.equal(receipt.proof, 'legacy_user_confirmed');
  assert.equal(first.hasClosure(a), true);
  assert.deepEqual(first.claimsFor(a), []);
  assert.deepEqual(first.retainedUnknowns(a).map(row => row.unknownCalls), [['actual-tool-call']]);

  // A stale plan mirror or reconciler must not recreate the closed execution.
  first.protect(a, { hostEpoch: 'a', state: 'reconciling', evidenceCalls: ['actual-tool-call'] });
  first.reconcile([a], () => 'a', () => true);
  assert.deepEqual(first.claimsFor(a), []);

  // A rebuilt ledger reads the GoalPlan mirror and stays released.
  const mirrored = { ...a, delegationOrigin: { ...a.delegationOrigin, executionClaimClosure: receipt } };
  const rebuilt = createExecutionResources({ rootDir: mkdtempSync(path.join(os.tmpdir(), 'peer-rebuilt-ledger-')) });
  t.after(() => rebuilt.close());
  rebuilt.reconcile([mirrored], () => 'a', () => true);
  assert.deepEqual(rebuilt.snapshot(), []);
  assert.equal(executionProtection(mirrored), 'released');
  assert.equal(second.reserve(plan('b', directory), 'b').allowed, true);
});

test('a plan mirror closure settles a claim left behind by a crash window', t => {
  const { directory, first } = fixture(t), a = plan('a', directory);
  first.protect(a, { hostEpoch: 'a', state: 'reconciling', evidenceCalls: ['actual-tool-call'] });
  const claim = first.claimsFor(a)[0];
  assert.equal(claim.state, 'reconciling');
  a.delegationOrigin.executionClaimClosure = {
    closureId: 'closure-mirror', claimId: claim.claimId, claimRevision: claim.revision,
    execution: claim.execution, resourceRef: claim.resourceRef, unknownCalls: ['actual-tool-call'],
    authorityRef: 'grant-mirror', proof: 'legacy_user_confirmed', scope: 'managed_execution', at: '2026-11-09T00:00:00.000Z',
  };
  first.reconcile([a], () => 'a', () => true);
  assert.deepEqual(first.claimsFor(a), []);
  assert.deepEqual(first.retainedUnknowns(a).map(row => row.unknownCalls), [['actual-tool-call']]);
});

test('a closure is revision-bound and still refuses an active claim or a changed unknown set', t => {
  const { directory, first } = fixture(t), a = plan('a', directory);
  first.reserve(a, 'a');
  const active = first.claimsFor(a)[0];
  assert.throws(() => first.closeClaim(a, { claimId: active.claimId, claimRevision: active.revision,
    authorityRef: 'grant-1', unknownCalls: [] }), /execution_resource_claim_active/);
  first.settle(a, stopped(first, a, 'withdraw', ['actual-tool-call']), 'a');
  const claim = first.claimsFor(a)[0];
  assert.throws(() => first.closeClaim(a, { claimId: claim.claimId, claimRevision: claim.revision - 1,
    authorityRef: 'grant-1', unknownCalls: ['actual-tool-call'] }), /execution_resource_closure_stale/);
  assert.throws(() => first.closeClaim(a, { claimId: claim.claimId, claimRevision: claim.revision,
    authorityRef: 'grant-1', unknownCalls: ['other-call'] }), /execution_resource_closure_unknown_mismatch/);
  const closed = first.closeClaim(a, { claimId: claim.claimId, claimRevision: claim.revision,
    authorityRef: 'grant-1', unknownCalls: ['actual-tool-call'] });
  assert.deepEqual(first.closeClaim(a, { claimId: claim.claimId, claimRevision: claim.revision,
    authorityRef: 'grant-1', unknownCalls: ['actual-tool-call'] }), closed);
});

test('a late old-epoch receipt cannot release the replacement executor claim', t => {
  const { directory, first, second } = fixture(t), a = plan('a', directory);
  first.reserve(a, 'a'); const receipt = stopped(first, a); first.settle(a, receipt, 'a');
  const replacement = { ...a, delegationOrigin: { ...a.delegationOrigin, coordinationBinding: { executionEpoch: 'new-epoch' } } };
  first.reserve(replacement, 'a'); first.settle(a, receipt, 'a');
  assert.equal(second.inspect(plan('other', directory)).allowed, false);
  assert.equal(first.snapshot()[0].execution.executionEpoch, 'new-epoch');
});

test('a stale revision and a changed body under an existing receipt cannot release a claim', t => {
  const { directory, first } = fixture(t), a = plan('a', directory);
  first.reserve(a, 'a'); const stale = stopped(first, a);
  first.activate(a, 'a');
  assert.throws(() => first.settle(a, stale, 'a'), /receipt_stale/);
  const current = stopped(first, a); first.settle(a, current, 'a');
  assert.throws(() => first.settle(a, { ...current, unknownCalls: ['changed'] }, 'a'), /receipt_conflict/);
});

test('completed cancellation requires ended execution and cannot hide a live executor', () => {
  const a = plan('stale', '/unused');
  a.status = 'cancelled'; a.delegationOrigin.cancellation = { phase: 'completed' };
  a.delegationOrigin.takeover = { phase: 'stopping' };
  assert.equal(executionProtection(a), 'reconciling');
  a.runner = { status: 'cancelled' };
  assert.equal(executionProtection(a), 'released');
  const end = beginExecutionAttempt(a.conversationId, 'actual-attempt');
  try { assert.equal(executionProtection(a), 'active'); } finally { end(); }
});

test('a different physical worktree remains available while a main-directory hold is unresolved', t => {
  const { root, directory, first, second } = fixture(t), worktree = path.join(root, 'worktree'); mkdirSync(worktree);
  const a = plan('a', directory); first.reserve(a, 'a'); first.settle(a, stopped(first, a, 'unknown', ['call']), 'a');
  assert.equal(second.reserve(plan('b', worktree), 'b').allowed, true);
});

test('additional resource sets are all-or-none and reversed requests never hold a partial set', t => {
  const { root, directory, first, second } = fixture(t), other = path.join(root, 'other'), extra = path.join(root, 'extra');
  mkdirSync(other); mkdirSync(extra);
  const a = plan('a', directory), b = plan('b', other);
  first.reserve(a, 'a', [{kind:'directory',path:extra}]);
  const refused = second.reserve(b, 'b', [{kind:'directory',path:directory}, {kind:'directory',path:extra}]);
  assert.equal(refused.allowed, false);
  assert.equal(second.claimsFor(b).length, 0);
  const receipt = stopped(first, a); first.settle(a, receipt, 'a');
  assert.equal(second.reserve(b, 'b', [{kind:'directory',path:extra},{kind:'directory',path:directory}]).allowed, true);
  assert.equal(second.claimsFor(b).length, 3);
});

test('worktree shell scopes include the actual shared Git directory', t => {
  const { root, directory, first, second } = fixture(t), worktree = path.join(root, 'worktree'), git = path.join(directory, '.git');
  mkdirSync(git); mkdirSync(path.join(git,'worktrees'),{recursive:true}); mkdirSync(path.join(git,'worktrees','task'));
  mkdirSync(worktree);
  writeFileSync(path.join(worktree,'.git'),`gitdir: ${path.join(git,'worktrees','task')}\n`);
  writeFileSync(path.join(git,'worktrees','task','commondir'),'../..\n');
  const a = plan('a',directory), b = plan('b',worktree);
  first.reserve(a,'a'); first.settle(a,stopped(first,a,'unknown',['call']),'a');
  assert.equal(second.reserve(b,'b').allowed,true,'isolated file work can be admitted');
  assert.equal(second.reserve(b,'b',providerExecutionScopes(worktree)).allowed,false,'shell must not pretend shared refs are isolated');
  assert.deepEqual(providerFileScopes(path.join(worktree,'new-file')), [{kind:'directory',path:realpathSync(worktree)}]);
});

test('a refused expansion survives release and requeue as a complete resource request', t => {
  const { root, directory, first, second } = fixture(t), other = path.join(root,'other'); mkdirSync(other);
  const a = plan('a',directory), b = plan('b',other);
  first.reserve(a,'a'); second.reserve(b,'b');
  assert.equal(first.reserve(a,'a',[{kind:'directory',path:other}],{recordConflict:true}).allowed,false);
  const receipt = stopped(first,a,'yield'); first.settle(a,receipt,'a');
  const resumed = {...a,delegationOrigin:{...a.delegationOrigin,coordinationBinding:{executionEpoch:'resumed'}}};
  first.rebindRequirements(executionIdentity(a),executionIdentity(resumed),receipt.receiptId);
  assert.equal(first.reserve(resumed,'a').allowed,false,'requeue cannot silently drop its contended resource');
  assert.equal(first.claimsFor(resumed).length,0,'it does not keep the old directory while waiting');
  second.settle(b,stopped(second,b,'done'),'b');
  assert.equal(first.reserve(resumed,'a').allowed,true);
  assert.equal(first.claimsFor(resumed).length,2);
});

test('an open handle named by the receipt stays reconciling and is not marked ended', t => {
  const { directory, first } = fixture(t), a = plan('a', directory), b = plan('b', directory);
  first.reserve(a, 'a');
  first.markHandle(a, { handleId: 'native', toolCallId: 'call', state: 'active' });
  first.settle(a, stopped(first, a, 'unknown-handle', ['call']), 'a');
  const claim = first.snapshot().find(row => row.execution.planId === 'a');
  assert.equal(claim.state, 'reconciling');
  assert.equal(claim.handles.native.state, 'active');
  assert.equal(first.reserve(b, 'b').allowed, false);
});

test('a durable native handle prevents release until its actual completion is recorded', t => {
  const { directory, first } = fixture(t), a=plan('a',directory); first.reserve(a,'a');
  first.markHandle(a,{handleId:'native',toolCallId:'call',state:'active'});
  assert.throws(()=>first.settle(a,stopped(first,a),'a'),/execution_stop_unconfirmed/);
  first.markHandle(a,{handleId:'native',toolCallId:'call',state:'ended',completedAt:'2026-11-01T00:00:00.000Z'});
  first.settle(a,stopped(first,a,'ended'),'a');
  assert.equal(first.hasClaim(a),false);
});

test('bootstrap imports foreign workspace protection before admitting a directory alias', t => {
  const { directory, first }=fixture(t), foreign=plan('foreign',directory), own=plan('own',directory);
  first.reconcile([foreign,own],()=> 'own-host',workspaceId=>workspaceId==='own');
  assert.equal(first.reserve(own,'own-host').allowed,false);
  assert.equal(first.inspect(own).blocker.kind,'protection');
});

for (const version of [7, 8, 9]) test(`missing ledger uses the actual resource contract in coordination format ${version}`, t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-resource-floor-'));
  const directory = path.join(root, 'w', 'coordination-v2'); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ minimumWriterVersion: version }));
  const resources = createExecutionResources({ rootDir: root });
  t.after(() => { resources.close(); rmSync(root, { recursive: true, force: true }); });
  if (version === 8) assert.equal(resources.revision(), 0, 'independent intent history predates resource storage');
  else assert.throws(() => resources.revision(), /execution_resource_store_missing/);
});

test('a legacy session without a work identity retains its unknown calls without querying an absent key', () => {
  let reads = 0;
  const release = registerWorkBudget('legacy-resource-query', { readWork() { reads++; throw new Error('absent work identity'); } });
  try {
    const legacy = { planId: 'old', delegationOrigin: { workspaceId: 'legacy-resource-query', sessionId: 'session',
      cancellation: { evidenceCalls: ['unknown-call'] } } };
    assert.deepEqual(unsettledExecution(legacy), ['unknown-call']); assert.equal(reads, 0);
  } finally { release(); }
});

test('recovery replays a durable stop before importing a reconciling mirror', t => {
  const { directory, first, second } = fixture(t), a = plan('stopped', directory), b = plan('next', directory);
  first.reserve(a, 'old-host'); first.protect(a, { hostEpoch: 'old-host', operationId: 'stop' });
  const receipt = stopped(first, a);
  // Crash after the journal receipt, before its SQLite release and settled mirror.
  a.delegationOrigin.executionControl = { phase: 'draining', expectedExecution: executionIdentity(a), stopReceipt: receipt };
  first.reconcile([a], () => 'new-host', () => true);
  assert.equal(second.reserve(b, 'new-host').allowed, true);
  const revision = first.revision();
  first.reconcile([a], () => 'new-host', () => true);
  assert.equal(first.revision(), revision);
  assert.equal(first.claimsFor(b).length, 1, 'replayed old receipt cannot release the next owner');
});

test('rechecking the same unknown hold does not keep changing its resource revision', t => {
  const { directory, first } = fixture(t), a = plan('unknown', directory);
  first.reserve(a, 'host');
  first.settle(a, stopped(first, a, 'stop', ['call']), 'host');
  const before = first.claimsFor(a)[0].revision, revision = first.revision();
  const refreshed = { ...stopped(first, a, 'stop', ['call']), receiptId: 'refreshed-stop' };
  first.settle(a, refreshed, 'host');
  assert.equal(first.claimsFor(a)[0].revision, before);
  assert.equal(first.revision(), revision);
  assert.equal(first.inspect(plan('next', directory)).blocker.code, 'execution_outcome_unknown');
});

test('a stop receipt predating a new unknown call cannot release its directory on recovery', t => {
  const { directory, first } = fixture(t), a = plan('changed-outcome', directory);
  first.reserve(a, 'host'); const receipt = stopped(first, a);
  a.delegationOrigin.executionControl = { phase: 'draining', expectedExecution: executionIdentity(a), stopReceipt: receipt };
  a.delegationOrigin.cancellation = { evidenceCalls: ['new-unknown'] };
  first.reconcile([a], () => 'host', () => true);
  assert.equal(first.inspect(plan('next', directory)).allowed, false);
  assert.deepEqual(first.claimsFor(a)[0].evidenceCalls, ['new-unknown']);
});

test('the unknown-outcome readers start empty on the schema-3 ledger', t => {
  const { directory, first } = fixture(t), a = plan('uo-reader', directory);
  first.reserve(a, 'host-a');
  const claim = first.claimsFor(a)[0];
  assert.deepEqual(first.resolutionsFor(a), []);
  assert.equal(first.resolutionFor(claim.claimId), undefined);
  assert.deepEqual(first.reconciliationEvidenceFor(claim.claimId), []);
});

test('a protection blocker carries its directory scope for closure surfaces', t => {
  const { directory, first } = fixture(t), a = plan('uo-scope', directory);
  first.reserve(a, 'host-a');
  first.settle(a, stopped(first, a, 'withdraw', ['tool-1']), 'host-a');
  const decision = first.inspect(plan('uo-other', directory), 'host-b');
  assert.equal(decision.blocker.code, 'execution_outcome_unknown');
  assert.deepEqual(decision.blocker.scope, { kind: 'directory', path: decision.blocker.resourceRef.slice('directory:'.length) });
});

test('a ledger written by a newer schema is refused instead of partially read', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-resource-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  mkdirSync(runtime, { recursive: true });
  const future = new DatabaseSync(path.join(runtime, 'execution-resources.sqlite'));
  future.exec('PRAGMA user_version=4;');
  future.close();
  // The store opens lazily; reading any fact must hit the schema gate first.
  assert.throws(() => createExecutionResources({ rootDir: runtime }).revision(), /execution_resource_schema_unsupported/);
});

test('unknown dispatches with declared file scopes narrow protection to those files (ADR 127 UO-05)', t => {
  const { directory, first, second } = fixture(t), a = plan('narrow', directory, 'workspace');
  a.delegationOrigin.workId = 'work-narrow';
  const file = path.join(directory, 'a.ts');
  writeFileSync(file, 'x');
  const release = registerWorkBudget('workspace', { readWork: () => ({ budget: { uncertainDispatches: [
    { toolCallId: 'tool-1', capabilityId: 'local.file.write', dispatchId: 'dispatch-1', registeredAt: '2026-11-09T00:00:00.000Z',
      declaredScopes: [{ kind: 'file', path: file }] }] } }) });
  t.after(release);
  first.reserve(a, 'host-a');
  first.settle(a, stopped(first, a, 'withdraw', ['tool-1']), 'host-a');
  const claims = first.claimsFor(a);
  assert.deepEqual(claims.map(claim => claim.state), ['reconciling']);
  assert.equal(claims[0].resourceRef.startsWith('file:'), true);
  assert.deepEqual(claims[0].evidenceCalls, ['tool-1']);
  assert.deepEqual(claims[0].scope, { kind: 'file', path: claims[0].resourceRef.slice('file:'.length) });
  // A directory-wide follower still sees a scoped protection blocker that names the file.
  const decision = second.reserve(plan('follower', directory), 'host-b');
  assert.equal(decision.allowed, false);
  assert.equal(decision.blocker.code, 'execution_outcome_unknown');
  assert.equal(decision.blocker.scope.kind, 'file');
  // Answering the one file claim frees the whole directory again.
  first.closeClaim(a, { claimId: claims[0].claimId, claimRevision: claims[0].revision,
    authorityRef: 'grant-narrow', unknownCalls: ['tool-1'], proof: 'legacy_user_confirmed' });
  assert.equal(second.reserve(plan('follower2', directory), 'host-b').allowed, true);
});

test('mixed or undeclared unknowns keep whole-directory protection', t => {
  const { directory, first } = fixture(t), a = plan('mixed', directory, 'workspace');
  const release = registerWorkBudget('workspace', { readWork: () => ({ budget: { uncertainDispatches: [
    { toolCallId: 'tool-1', capabilityId: 'local.file.write', declaredScopes: [{ kind: 'file', path: path.join(directory, 'a.ts') }] },
    { toolCallId: 'tool-2', capabilityId: 'local.shell.exec' }] } }) });
  t.after(release);
  first.reserve(a, 'host-a');
  first.settle(a, stopped(first, a, 'withdraw', ['tool-1', 'tool-2']), 'host-a');
  const claims = first.claimsFor(a);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].resourceRef.startsWith('directory:'), true);
  assert.deepEqual(claims[0].evidenceCalls, ['tool-1', 'tool-2']);
});

test('declaredDispatchScopes derives file scopes only from absolute local file targets', () => {
  assert.deepEqual(declaredDispatchScopes({ capabilityId: 'local.file.write', arguments: { path: '/w/a.ts' } }), [{ kind: 'file', path: '/w/a.ts' }]);
  assert.deepEqual(declaredDispatchScopes({ name: 'local.file.edit', args: { filePath: '/w/b.ts' } }), [{ kind: 'file', path: '/w/b.ts' }]);
  assert.deepEqual(declaredDispatchScopes({ capabilityId: 'local.file.read', arguments: { path: '/w/c.ts' } }), [{ kind: 'file', path: '/w/c.ts' }]);
  assert.deepEqual(declaredDispatchScopes({ capabilityId: 'local.shell.exec', arguments: { command: 'x' } }), []);
  assert.deepEqual(declaredDispatchScopes({ capabilityId: 'local.file.write', arguments: { path: 'rel/a.ts' } }), []);
  assert.deepEqual(declaredDispatchScopes({ capabilityId: 'local.file.write', arguments: null }), []);
});
