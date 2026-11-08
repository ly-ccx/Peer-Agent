import assert from 'node:assert/strict';
import test from 'node:test';
import { projectWorkSession, type DelegationOrigin, type GoalRunnerStatus } from '@peer-agent/protocol';
import { groupDrawerSessions, readDrawerSession, taskGroup } from './drawerState.ts';
import { indexBotWork } from './botWorkState.ts';
import { workPanelSessions } from './botWorkPanelState.ts';

function listed(id: string, origin: Record<string, unknown>, runnerStatus: GoalRunnerStatus = 'running') {
  const session = readDrawerSession(projectWorkSession({
    planId: id, status: 'paused', title: id, delegated: true, runnerStatus, conversationId: id,
  }, {
    sessionId: id, workspaceId: 'workspace', spawnedAt: '2026-11-07T00:00:00.000Z',
    origin: origin as unknown as DelegationOrigin, executionOwnership: 'unknown',
  }));
  assert.ok(session);
  return session;
}

test('task list and collaboration agents follow the same stop settlement', () => {
  const stopping = listed('stopping', {
    parentConversationId: 'parent',
    cancellation: { phase: 'stopping' },
    executionControl: { kind: 'cancel', phase: 'draining' },
  });
  const awaiting = listed('awaiting', {
    parentConversationId: 'parent',
    cancellation: { phase: 'awaiting_outcome', evidenceCalls: ['remote-call'] },
    executionControl: { kind: 'cancel', phase: 'reconciling', stopReceipt: { unknownCalls: ['remote-call'] } },
  });
  const legacy = listed('legacy', {
    parentConversationId: 'parent',
    cancellation: { phase: 'awaiting_outcome' },
    executionControl: { kind: 'cancel', phase: 'reconciling', nextAction: 'execution_stop_unconfirmed' },
  });
  const cancelled = listed('cancelled', {
    parentConversationId: 'parent',
    cancellation: { phase: 'completed' },
    executionControl: { kind: 'cancel', phase: 'settled', outcome: 'applied', stopReceipt: { unknownCalls: [] } },
  }, 'paused');
  const child = listed('child', {
    parentSessionId: 'stopping', parentConversationId: 'parent',
    cancellation: { phase: 'stopping' },
    executionControl: { kind: 'cancel', phase: 'draining' },
  });
  assert.equal(stopping.statusLabel, '正在停止');
  assert.equal(awaiting.statusLabel, '执行结果待核实');
  assert.equal(legacy.statusLabel, '执行结果待核实');
  assert.equal(cancelled.statusLabel, '已取消');
  assert.equal(stopping.followUp?.inCurrentList, true);
  assert.equal(awaiting.followUp?.inCurrentList, true);
  assert.equal(legacy.followUp?.inCurrentList, true);
  assert.equal(cancelled.followUp?.inCurrentList, false);
  assert.equal(taskGroup(stopping.status, stopping.followUp), 'running');
  assert.equal(taskGroup(awaiting.status, awaiting.followUp), 'running');
  assert.equal(taskGroup(legacy.status, legacy.followUp), 'running');
  assert.equal(taskGroup(cancelled.status, cancelled.followUp), 'done');
  const indexed = readDrawerSession({ ...legacy, sessionId: 'indexed', followUp: { owner: 'none', inCurrentList: false, reason: 'obligation_indexed' }, status: 'awaiting_outcome', statusLabel: '执行结果待核实' });
  assert.ok(indexed);
  const panel = workPanelSessions(indexBotWork([stopping, awaiting, legacy, cancelled, child, indexed], true));
  assert.deepEqual(panel.tasks.map(session => session.sessionId).sort(), ['awaiting', 'legacy', 'stopping']);
  assert.deepEqual(panel.agents.map(session => session.sessionId).sort(), ['awaiting', 'child', 'legacy', 'stopping']);
  assert.equal([...panel.tasks, ...panel.agents].some(session => session.sessionId === 'indexed'), false);
  assert.deepEqual(Object.values(groupDrawerSessions([indexed!])).flat(), []);
});
