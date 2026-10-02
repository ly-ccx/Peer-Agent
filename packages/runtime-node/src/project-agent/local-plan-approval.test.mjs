import assert from 'node:assert/strict';
import test from 'node:test';
import { readLocalPlanApproval } from './local-plan-approval.mjs';

const plan = { planId: 'p', conversationId: 'c', delegationOrigin: { workspaceId: 'w', sessionId: 's' } };
const record = { approvalId: 'plan:s', planId: 'p', conversationId: 'c', workspaceId: 'w', sessionId: 's',
  capabilityId: 'goal.plan', kind: 'plan_approval', state: 'approved', decidedBy: 'local_ui',
  decidedAt: '2026-10-02T04:00:00.000Z', argsDigest: 'a'.repeat(64) };

test('only the correctly bound persisted local decision produces GoalApproval', () => {
  const read = row => readLocalPlanApproval(plan, { list(filter) { assert.deepEqual(filter, { workspaceId: 'w' }); return [row]; } });
  assert.deepEqual(read(record), { decision: 'approve', confirmationId: 'plan:s', decidedBy: 'local_ui', decidedAt: record.decidedAt });
  for (const [key, values] of Object.entries({ state: ['open', 'stale', 'denied', 'expired'], decidedBy: ['policy', undefined],
    workspaceId: ['foreign'], sessionId: ['foreign'], planId: ['foreign'], conversationId: ['foreign'],
    approvalId: ['foreign'], capabilityId: ['local.file.write'], kind: ['permission'], decidedAt: ['invalid', undefined], argsDigest: ['invalid'] })) {
    for (const value of values) assert.equal(read({ ...record, [key]: value }), null, `${key}=${value}`);
  }
  assert.equal(readLocalPlanApproval(plan, null), null);
  assert.equal(readLocalPlanApproval({ ...plan, delegationOrigin: {} }, { list: () => [record] }), null);
});
