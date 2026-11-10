import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecutionResources } from './execution-resources.mjs';
import { registerWorkBudget } from './work-budget.mjs';
import { unknownOutcomeDiagnostics, diagnosticsDigest } from './unknown-outcome-diagnostics.mjs';

function plan(id, directory, workspaceId = 'workspace') {
  return { planId: id, conversationId: `conversation-${id}`, title: id, status: 'executing', targetWorkspacePath: directory,
    delegationOrigin: { sessionId: `session-${id}`, workspaceId, workId: `work-${workspaceId}`, phase: 'running', coordinationBinding: { executionEpoch: `epoch-${id}` } } };
}
function fixture(t, { dirty = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-diagnostics-'));
  const directory = path.join(root, 'workspace');
  mkdirSync(directory);
  if (dirty) writeFileSync(path.join(directory, 'untracked.txt'), 'late');
  const resources = createExecutionResources({ rootDir: path.join(root, 'runtime'), now: () => '2026-11-09T00:00:00.000Z' });
  t.after(() => { resources.close(); rmSync(root, { recursive: true, force: true }); });
  return { directory, resources };
}
const works = declared => [{
  delegationOrigin: { workspaceId: 'workspace' },
  budget: {
    uncertainDispatches: [{ toolCallId: 'tool-1', capabilityId: 'local.file.write', dispatchId: 'dispatch-1',
      registeredAt: '2026-11-09T00:00:00.000Z', ...(declared ? { declaredScopes: [{ kind: 'file', path: '/w/a.ts' }] } : {}) }],
    dispatchReceipts: { 'dispatch-9': { dispatchId: 'dispatch-9', toolCallId: 'tool-9', outcome: 'resulted', evidenceRefs: [], settledAt: '2026-11-09T00:01:00.000Z' } },
  },
}];

test('the diagnostic lists protected claims with scope, age and the scopeUnknown annotation', t => {
  const { directory, resources } = fixture(t);
  const p = plan('legacy', directory);
  resources.protect(p, { hostEpoch: 'host-a', operationId: 'stop-1', state: 'reconciling', evidenceCalls: ['tool-1'] });
  const report = unknownOutcomeDiagnostics({ resources, works: works(false), now: () => '2026-11-16T00:00:00.000Z' });
  assert.equal(report.claims.length, 1);
  const claim = report.claims[0];
  assert.equal(claim.scope.kind, 'directory');
  assert.equal(claim.scopeUnknown, true, 'a claim without declared scopes is named, not guessed');
  assert.deepEqual(claim.unknownCalls, ['tool-1']);
  assert.equal(claim.nextAction, 'reconcile_execution_outcome');
  assert.ok(Math.abs(claim.ageDays - 7) < 0.01, 'age comes from the claim timestamp');
  assert.equal(report.totals.protectedClaims, 1);
  assert.equal(report.totals.scopeUnknownClaims, 1);
  assert.equal(report.totals.worksWithUnknowns, 1);
  assert.equal(report.totals.dispatchSettled, 1);
  assert.equal(report.totals.dispatchUnknown, 1);
  assert.ok(Math.abs(report.totals.dispatchUnknownRate - 0.5) < 1e-9);
  const first = diagnosticsDigest(report);
  assert.equal(first, diagnosticsDigest(unknownOutcomeDiagnostics({ resources, works: works(false), now: () => '2026-11-16T00:00:00.000Z' })), 'same facts, same digest');
});

test('a scoped file claim reads as file scope without the unknown annotation', t => {
  const { directory, resources } = fixture(t);
  const file = path.join(directory, 'a.ts');
  writeFileSync(file, 'x');
  const release = registerWorkBudget('workspace', { readWork: () => ({ delegationOrigin: { workspaceId: 'workspace' },
    budget: { uncertainDispatches: [{ toolCallId: 'tool-1', capabilityId: 'local.file.write',
      declaredScopes: [{ kind: 'file', path: path.join(directory, 'a.ts') }] }] } }) });
  t.after(release);
  const p = plan('scoped', directory);
  p.delegationOrigin.workId = 'work-scoped';
  resources.reserve(p, 'host-a');
  const receipt = { receiptId: 'receipt-1', operationId: 'stop-1', execution: resources.claimsFor(p)[0].execution,
    admissionClosed: true, runnerIdle: true, schedulerIdle: true,
    resourceClaims: resources.claimsFor(p).map(({ claimId, revision }) => ({ claimId, revision })),
    unknownCalls: ['tool-1'], scope: 'managed_execution' };
  resources.settle(p, receipt, 'host-a');
  const report = unknownOutcomeDiagnostics({ resources, works: works(true), now: () => '2026-11-16T00:00:00.000Z' });
  assert.equal(report.totals.protectedClaims, 1);
  const claim = report.claims[0];
  assert.equal(claim.scope.kind, 'file');
  assert.equal('scopeUnknown' in claim, false, 'a declared file scope is not annotated unknown');
  assert.deepEqual(report.totals.protectedClaimsByScope, { file: 1 });
});
