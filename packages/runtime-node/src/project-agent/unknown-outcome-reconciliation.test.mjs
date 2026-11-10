import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecutionResources } from './execution-resources.mjs';
import { createUnknownOutcomeReconciler } from './unknown-outcome-reconciliation.mjs';
import { registerWorkBudget } from './work-budget.mjs';

function plan(id, directory, workspaceId = 'workspace') {
  return { planId: id, conversationId: `conversation-${id}`, title: id, status: 'executing', targetWorkspacePath: directory,
    delegationOrigin: { sessionId: `session-${id}`, workspaceId, workId: 'work-1', phase: 'running', coordinationBinding: { executionEpoch: `epoch-${id}` } } };
}
function git(directory, ...args) {
  execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
}
function fixture(t, { dirty = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-reconcile-'));
  const directory = path.join(root, 'workspace');
  mkdirSync(directory);
  git(directory, 'init', '-q');
  git(directory, 'config', 'user.email', 'reconcile@test');
  git(directory, 'config', 'user.name', 'reconcile');
  writeFileSync(path.join(directory, 'base.txt'), 'base');
  git(directory, 'add', 'base.txt');
  git(directory, 'commit', '-q', '-m', 'base');
  if (dirty) writeFileSync(path.join(directory, 'untracked.txt'), 'late');
  const resources = createExecutionResources({ rootDir: path.join(root, 'runtime') });
  const control = { recorder: { bootId: 'boot-1', pid: 4242, pidStart: 'macos:Mon Nov  9 00:00:00 2026', hostId: 'host-1', acquiredAt: '2026-11-09T00:00:00.000Z' } };
  const store = {
    readWork: () => ({ budget: { uncertainDispatches: [{ toolCallId: 'tool-1', capabilityId: 'local.file.write',
      dispatchId: 'dispatch-abc', registeredAt: '2026-11-09T00:00:00.000Z', attemptId: 'attempt-1' }] } }),
    readSessionControl: () => control,
  };
  const release = registerWorkBudget('workspace', store);
  t.after(() => { release(); resources.close(); rmSync(root, { recursive: true, force: true }); });
  const reconciler = createUnknownOutcomeReconciler({ resources, recorderIdentity: () => ({ bootId: 'boot-1', lookup: () => null }) });
  return { root, directory, resources, reconciler, control };
}
function protectedClaim(resources, p, evidenceCalls = ['tool-1']) {
  resources.protect(p, { hostEpoch: 'host-a', operationId: 'stop-1', state: 'reconciling', evidenceCalls });
  return resources.claimsFor(p)[0];
}

test('a fenced claim over a clean tree with a dead recorder reconciles to no_effect_observed', async t => {
  const { directory, resources, reconciler } = fixture(t);
  const p = plan('clean', directory), claim = protectedClaim(resources, p);
  const result = await reconciler.reconcile(p, { claimId: claim.claimId });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.verdict, 'no_effect_observed',
    `workspace probe: ${result.evidence.probes.find(probe => probe.kind === 'workspace')?.result}`);
  assert.equal(result.evidence.claimId, claim.claimId);
  assert.deepEqual(result.evidence.scope, { kind: 'directory', path: claim.resourceRef.slice('directory:'.length) });
  const kinds = result.evidence.probes.map(probe => probe.kind).sort();
  assert.deepEqual([...new Set(kinds)], ['handle', 'process', 'receipt', 'workspace']);
  assert.equal(result.evidence.probes.find(probe => probe.kind === 'process').result.includes('dead'), true);
  // Same observable state replays the same digest instead of manufacturing new evidence.
  const again = await reconciler.reconcile(p, { claimId: claim.claimId });
  assert.equal(again.evidence.evidenceDigest, result.evidence.evidenceDigest);
  assert.equal(resources.reconciliationEvidenceFor(claim.claimId).length, 1);
});

test('a dirty tree stays inconclusive; the probe records the visible changes', async t => {
  const { directory, resources, reconciler } = fixture(t, { dirty: true });
  const p = plan('dirty', directory), claim = protectedClaim(resources, p);
  const result = await reconciler.reconcile(p, { claimId: claim.claimId });
  assert.equal(result.evidence.verdict, 'inconclusive');
  const workspace = result.evidence.probes.find(probe => probe.kind === 'workspace');
  assert.equal(workspace.result.includes('untracked.txt'), true);
});

test('a capability that cannot be proven host-local is unfenced, never auto-closable', async t => {
  const { directory, resources, reconciler } = fixture(t);
  const p = plan('remote', directory);
  const release = registerWorkBudget('workspace', { readWork: () => ({ budget: { uncertainDispatches: [
    { toolCallId: 'tool-1', capabilityId: 'remote.http.post', dispatchId: 'dispatch-xyz', registeredAt: '2026-11-09T00:00:00.000Z' }] } }) });
  t.after(release);
  const claim = protectedClaim(resources, p);
  const result = await reconciler.reconcile(p, { claimId: claim.claimId });
  assert.equal(result.evidence.verdict, 'unfenced_external');
});

test('an open handle or a live recorder keeps the claim inconclusive', async t => {
  const { directory, resources, reconciler, control } = fixture(t);
  const p = plan('handle', directory), claim = protectedClaim(resources, p);
  resources.markHandle(p, { handleId: 'h1', toolCallId: 'tool-1', state: 'active' });
  assert.equal((await reconciler.reconcile(p, { claimId: claim.claimId })).evidence.verdict, 'inconclusive');
  resources.markHandle(p, { handleId: 'h1', toolCallId: 'tool-1', state: 'ended' });
  // A live recorder (pid start matches this boot) is not a death proof.
  const live = createUnknownOutcomeReconciler({ resources, recorderIdentity: () => ({ bootId: 'boot-1', lookup: () => 'macos:Mon Nov  9 00:00:00 2026' }) });
  assert.equal((await live.reconcile(p, { claimId: claim.claimId })).evidence.verdict, 'inconclusive');
});

test('receipts answering every unknown as not_dispatched close with no effect', async t => {
  const { directory, resources, reconciler } = fixture(t);
  const release = registerWorkBudget('workspace', { readWork: () => ({ budget: {
    uncertainDispatches: [{ toolCallId: 'tool-1', capabilityId: 'local.shell', dispatchId: 'dispatch-1', registeredAt: '2026-11-09T00:00:00.000Z' }],
    dispatchReceipts: { 'dispatch-1': { dispatchId: 'dispatch-1', toolCallId: 'tool-1', outcome: 'not_dispatched', evidenceRefs: [], settledAt: '2026-11-09T00:00:01.000Z' } } } }) });
  t.after(release);
  const p = plan('receipt', directory), claim = protectedClaim(resources, p);
  const result = await reconciler.reconcile(p, { claimId: claim.claimId });
  assert.equal(result.evidence.verdict, 'no_effect_observed');
  const receipt = result.evidence.probes.find(probe => probe.kind === 'receipt');
  assert.equal(receipt.result.includes('not_dispatched'), true);
});

test('an active claim or a claim without unknowns is not reconcilable', async t => {
  const { directory, resources, reconciler } = fixture(t);
  const p = plan('active', directory);
  resources.reserve(p, 'host-a');
  const active = resources.claimsFor(p)[0];
  assert.equal((await reconciler.reconcile(p, { claimId: active.claimId })).code, 'reconciliation_claim_active');
  assert.equal((await reconciler.reconcile(p, { claimId: 'claim-missing' })).code, 'reconciliation_claim_missing');
  const stopped = plan('settled', directory);
  resources.protect(stopped, { hostEpoch: 'host-b', operationId: 'stop-2', state: 'draining', evidenceCalls: [] });
  const drained = resources.claimsFor(stopped)[0];
  assert.equal((await reconciler.reconcile(stopped, { claimId: drained.claimId })).code, 'reconciliation_no_unknown');
});
