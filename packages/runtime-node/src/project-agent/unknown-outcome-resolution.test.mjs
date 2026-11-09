import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecutionResources } from './execution-resources.mjs';
import { createUnknownOutcomeResolver } from './unknown-outcome-resolution.mjs';

function plan(id, directory, workspaceId = 'workspace') {
  return { planId: id, conversationId: `conversation-${id}`, title: id, status: 'executing', targetWorkspacePath: directory,
    delegationOrigin: { sessionId: `session-${id}`, workspaceId, phase: 'running', coordinationBinding: { executionEpoch: `epoch-${id}` } } };
}
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-resolution-'));
  const directory = path.join(root, 'workspace');
  mkdirSync(directory);
  const resources = createExecutionResources({ rootDir: path.join(root, 'runtime') });
  t.after(() => { resources.close(); rmSync(root, { recursive: true, force: true }); });
  const policy = { tier: 'bot_verified', policyId: 'policy-1', revision: 2, workspaceId: 'workspace',
    agentConversationId: 'conv-1', delegatedAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z' };
  return { directory, resources, policy,
    delegated: createUnknownOutcomeResolver({ resources, readPolicy: () => policy }),
    asking: createUnknownOutcomeResolver({ resources }) };
}
function protectedClaim(resources, p) {
  resources.protect(p, { hostEpoch: 'host-a', operationId: 'stop-1', state: 'reconciling', evidenceCalls: ['tool-1'] });
  return resources.claimsFor(p)[0];
}
function evidenceFor(claim, { verdict = 'no_effect_observed', capabilityId = 'local.file.write', recorderProof = 'dead', revision = claim.revision } = {}) {
  const at = '2026-11-09T00:00:02.000Z';
  const probes = [
    { kind: 'receipt', ref: 'receipt:tool-1', result: JSON.stringify({ answered: null, capabilityId, dispatchId: 'dispatch-1', registeredAt: '2026-11-09T00:00:00.000Z' }), observedAt: at, digest: 'd1' },
    { kind: 'handle', ref: `handles:${claim.claimId}`, result: JSON.stringify({ openHandles: [] }), observedAt: at, digest: 'd2' },
    { kind: 'process', ref: 'process:session-x', result: JSON.stringify({ recorderProof }), observedAt: at, digest: 'd3' },
    { kind: 'workspace', ref: claim.resourceRef, result: JSON.stringify({ clean: true, changed: 0, untracked: 0, consistent: true, paths: [] }), observedAt: at, digest: 'd4' },
  ];
  return { execution: claim.execution, claimId: claim.claimId, claimRevision: revision,
    scope: { kind: 'directory', path: claim.resourceRef.slice('directory:'.length) }, probes, verdict,
    evidenceDigest: createHash('sha256').update(JSON.stringify([claim.claimId, claim.revision, probes.map(probe => probe.digest), verdict])).digest('hex') };
}

test('a delegated policy closes a fully evidenced claim and never claims success', async t => {
  const { directory, resources, delegated } = fixture(t);
  const p = plan('close', directory), claim = protectedClaim(resources, p);
  resources.recordReconciliation(evidenceFor(claim));

  const result = delegated.resolveBotVerified(p, { claimId: claim.claimId });
  assert.equal(result.ok, true);
  assert.equal(result.closure.proof, 'verified_dead');
  assert.equal(result.closure.resolution.tier, 'bot_verified');
  assert.equal(result.closure.resolution.policyRef, 'policy:policy-1');
  assert.equal(result.closure.resolution.verdict, 'no_effect_observed');

  // Occupancy ends; the unknown call stays retained and the receipt is unique.
  assert.deepEqual(resources.claimsFor(p), []);
  const retained = resources.retainedUnknowns(p);
  assert.deepEqual(retained.map(row => row.unknownCalls), [['tool-1']]);
  assert.equal(retained[0].resolution.tier, 'bot_verified');
  const resolutions = resources.resolutionsFor(p);
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].tier, 'bot_verified');
  assert.equal(resolutions[0].authorityRef, 'policy:policy-1');
  assert.deepEqual(resolutions[0].unknownCalls, ['tool-1']);
  // The released claim cannot be resolved again.
  assert.equal(delegated.resolveBotVerified(p, { claimId: claim.claimId }).code, 'resolution_claim_missing');
});

test('ask policy or a missing envelope leg refuses without touching the claim', async t => {
  const { directory, resources, delegated, asking } = fixture(t);
  const p = plan('ask', directory), claim = protectedClaim(resources, p);
  resources.recordReconciliation(evidenceFor(claim));
  assert.equal(asking.resolveBotVerified(p, { claimId: claim.claimId }).code, 'authorization_required');
  assert.deepEqual(resources.claimsFor(p).map(row => row.state), ['reconciling']);

  // No evidence at all: the gate refuses and keeps the claim.
  const bare = plan('bare', directory), bareClaim = protectedClaim(resources, bare);
  assert.equal(delegated.resolveBotVerified(bare, { claimId: bareClaim.claimId }).code, 'reconciliation_missing');
  assert.equal(delegated.resolveBotVerified(bare, { claimId: 'claim-none' }).code, 'resolution_claim_missing');
});

test('stale evidence, unconfined capabilities, open handles and live recorders all refuse', async t => {
  const { directory, resources, delegated } = fixture(t);
  // A later protection bumps the claim revision; evidence recorded before it is void.
  const stale = plan('stale', directory), staleClaim = protectedClaim(resources, stale);
  resources.protect(stale, { hostEpoch: 'host-a', operationId: 'stop-2', state: 'reconciling', evidenceCalls: ['tool-1'] });
  resources.recordReconciliation(evidenceFor(staleClaim));
  assert.equal(delegated.resolveBotVerified(stale, { claimId: staleClaim.claimId }).code, 'reconciliation_stale');

  const shell = plan('shell', directory), shellClaim = protectedClaim(resources, shell);
  resources.recordReconciliation(evidenceFor(shellClaim, { capabilityId: 'local.shell.exec' }));
  assert.equal(delegated.resolveBotVerified(shell, { claimId: shellClaim.claimId }).code, 'capability_not_confined');

  const handle = plan('handle', directory), handleClaim = protectedClaim(resources, handle);
  resources.recordReconciliation(evidenceFor(handleClaim));
  resources.markHandle(handle, { handleId: 'h1', toolCallId: 'tool-1', state: 'active' });
  assert.equal(delegated.resolveBotVerified(handle, { claimId: handleClaim.claimId }).code, 'open_handles');

  const live = plan('live', directory), liveClaim = protectedClaim(resources, live);
  resources.recordReconciliation(evidenceFor(liveClaim, { recorderProof: 'not_available' }));
  assert.equal(delegated.resolveBotVerified(live, { claimId: liveClaim.claimId }).code, 'recorder_not_proven_dead');

  const dirty = plan('dirty', directory), dirtyClaim = protectedClaim(resources, dirty);
  resources.recordReconciliation(evidenceFor(dirtyClaim, { verdict: 'inconclusive' }));
  assert.equal(delegated.resolveBotVerified(dirty, { claimId: dirtyClaim.claimId }).code, 'verdict_inconclusive');
});

test('inspect projects the policy tier and the envelope verdict for card surfaces', async t => {
  const { directory, resources, delegated, asking } = fixture(t);
  const p = plan('inspect', directory), claim = protectedClaim(resources, p);
  resources.recordReconciliation(evidenceFor(claim));
  const underPolicy = delegated.inspect(p, { claimId: claim.claimId });
  assert.equal(underPolicy.policyTier, 'bot_verified');
  assert.equal(underPolicy.eligible, true);
  assert.equal(underPolicy.verdict, 'no_effect_observed');
  const shell = plan('shell2', directory), shellClaim = protectedClaim(resources, shell);
  resources.recordReconciliation(evidenceFor(shellClaim, { capabilityId: 'local.shell.exec' }));
  assert.equal(delegated.inspect(shell, { claimId: shellClaim.claimId }).reason, 'capability_not_confined');
  assert.equal(asking.inspect(p, { claimId: claim.claimId }).policyTier, 'ask');
});
