import assert from 'node:assert/strict';
import test from 'node:test';
import { createClassicGoalProjection } from './classic-goal-projection.mjs';

test('one batch reads each canonical catalog once, preserves workspace/role boundaries and stays current', () => {
  const calls = { registry: 0, conversations: 0, plans: 0 };
  const plans = [
    { planId: 'a', conversationId: 'old-a', status: 'executing', runner: { status: 'waiting_user' }, title: 'first' },
    { planId: 'b', targetWorkspacePath: '/b', status: 'executing', title: 'second' },
    { planId: 'hidden', conversationId: 'bot-a', status: 'executing' },
    { planId: 'terminal', targetWorkspacePath: '/a', status: 'completed' },
    { planId: 'delegated', targetWorkspacePath: '/a', status: 'executing', delegationOrigin: { workspaceId: 'a' } },
  ];
  const projection = createClassicGoalProjection({
    registry: { list: () => { calls.registry++; return [{ workspaceId: 'a', path: '/a' }, { workspaceId: 'b', path: '/b' }]; } },
    conversationStore: { listConversations: () => { calls.conversations++; return [{ id: 'old-a', workspacePath: '/a' }, { id: 'bot-a', workspacePath: '/a', role: 'project_agent' }]; } },
    goalPlanStore: { listPlans: () => { calls.plans++; return plans; } },
  });
  const first = projection.batch(['a', 'b', 'missing']);
  assert.deepEqual(calls, { registry: 1, conversations: 1, plans: 1 });
  assert.deepEqual(first.get('a').map(row => row.planId), ['a']);
  assert.equal(first.get('a')[0].waitingUser, true);
  assert.deepEqual(first.get('b').map(row => row.planId), ['b']);
  assert.deepEqual(first.get('missing'), []);
  plans[0].status = 'completed';
  assert.deepEqual(projection.one('a'), []);
  assert.deepEqual(calls, { registry: 2, conversations: 2, plans: 2 });
});

test('unavailable optional catalogs do not fabricate classic goals', () => {
  const projection = createClassicGoalProjection({ registry: { list: () => { throw Error('unavailable'); } } });
  assert.deepEqual(projection.batch(['a']).get('a'), []);
});
