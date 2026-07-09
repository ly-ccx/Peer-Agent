import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPermissionGrantDraft,
  isPermissionAllowed,
  isPermissionAsking,
  isPermissionDenied,
  mergePermissionDecisions,
  mostRestrictivePermissionDecision,
  type PermissionDecision,
} from './index.ts';

const allowDecision: PermissionDecision = {
  decision: 'allow',
  source: 'workspace_rule',
  reason: 'safe_read',
};

const askDecision: PermissionDecision = {
  decision: 'ask',
  source: 'risk_policy',
  reason: 'needs_user_approval',
};

const denyDecision: PermissionDecision = {
  decision: 'deny',
  source: 'system_policy',
  reason: 'destructive_action',
  metadata: { level: 'hard_deny' },
};

test('mostRestrictivePermissionDecision ranks deny over ask over allow', () => {
  assert.equal(mostRestrictivePermissionDecision([]), 'allow');
  assert.equal(mostRestrictivePermissionDecision(['allow', 'ask']), 'ask');
  assert.equal(mostRestrictivePermissionDecision([allowDecision, askDecision]), 'ask');
  assert.equal(mostRestrictivePermissionDecision([askDecision, denyDecision, allowDecision]), 'deny');
});

test('mergePermissionDecisions preserves the source and reason of the winning decision', () => {
  assert.deepEqual(mergePermissionDecisions([allowDecision, askDecision]), askDecision);
  assert.deepEqual(mergePermissionDecisions([allowDecision, denyDecision, askDecision]), denyDecision);
});

test('mergePermissionDecisions returns a default allow decision for empty input', () => {
  assert.deepEqual(mergePermissionDecisions([], { defaultSource: 'unit_test' }), {
    decision: 'allow',
    source: 'unit_test',
  });
});

test('permission state helpers accept strings and decision objects', () => {
  assert.equal(isPermissionAllowed('allow'), true);
  assert.equal(isPermissionAllowed(allowDecision), true);
  assert.equal(isPermissionAsking(askDecision), true);
  assert.equal(isPermissionDenied(denyDecision), true);
  assert.equal(isPermissionDenied(askDecision), false);
});

test('createPermissionGrantDraft creates a host-independent grant draft', () => {
  const grant = createPermissionGrantDraft(
    denyDecision,
    { capabilityId: 'local.shell.exec' },
    {
      grantId: 'grant_1',
      grantedAt: '2026-07-09T00:00:00.000Z',
      evidenceRefs: ['evidence_1'],
      metadata: { requestId: 'request_1' },
    },
  );

  assert.deepEqual(grant, {
    grantId: 'grant_1',
    capabilityId: 'local.shell.exec',
    decision: 'deny',
    grantedAt: '2026-07-09T00:00:00.000Z',
    source: 'system_policy',
    reason: 'destructive_action',
    evidenceRefs: ['evidence_1'],
    metadata: {
      level: 'hard_deny',
      requestId: 'request_1',
    },
  });
});
