import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionHandoff } from './session-handoff.mjs';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { handoffQuestionId } from './acceptance.mjs';
import { projectCards } from './card-projection.mjs';

function fixture(t, stoppedReason) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b4-handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: root });
  const selection = { providerId: 'p', modelId: 'm', modelProviderId: 'pm', family: 'f' };
  const at = '2026-10-01T00:00:00.000Z';
  const initial = store.createPlan({ conversationId: 'c', title: 'Fix', goal: 'Fix',
    tasks: [{ taskId: 't', title: 'Fix', status: 'completed' }],
    delegationOrigin: { anchorMessageId: 'a', inputId: 'i', workspaceId: 'w', sessionId: 's',
      modelSelection: { worker: selection, explorer: selection, verifier: selection, resolvedAt: at },
      isolation: 'worktree', isolationRetainedAt: at, isolationBlock: 'disk_space',
      handoffAuthorizedAt: at, phase: 'running' },
    deliveryBinding: { targetWorkspacePath: '/repo', targetBranch: 'main', targetBranchSource: 'workspace_head',
      repoId: 'repo', executionIsolation: 'worktree', worktreePath: '/repo-wt', taskBranch: 'task', boundAt: at },
  });
  store.recordApproval(initial.planId, { decision: 'approve' });
  store.revisePlan(initial.planId, { status: 'completed', resultAcceptance: { acceptedBy: 'user', acceptedAt: at },
    qualityReview: { status: 'passed', reviewedAt: at },
    ...(stoppedReason ? { deliveryHandoff: { status: 'stopped', stoppedReason, updatedAt: at } } : {}) });
  let owned = true; let discardOk = true;
  const calls = [];
  const handoff = createSessionHandoff({ findBySession: () => store.getPlan(initial.planId), goalPlanStore: store,
    goalRunner: { handoffDelegatedPlan: async p => { calls.push('merge'); return p; },
      discardDelegatedLine: async () => ({ ok: discardOk }) },
    canManageWorkspace: () => owned, conversationStore: { appendMessage: (...args) => calls.push(args) },
    promote: async () => calls.push('promote'), now: () => '2026-10-02T00:00:00.000Z' });
  const get = () => store.getPlan(initial.planId);
  const answer = text => ({ workspaceId: 'w', sessionId: 's', text,
    answerTo: `card:question:s:${handoff.facts('s').questionId}` });
  return { store, handoff, get, answer, calls, own: v => { owned = v; }, discard: v => { discardOk = v; } };
}

test('acceptance alone does not merge; host confirmation is scoped to current card, workspace and lease', async t => {
  const f = fixture(t);
  const saved = f.store.revisePlan(f.get().planId, { delegationOrigin: { ...f.get().delegationOrigin, handoffAuthorizedAt: null } });
  await f.handoff.afterAcceptance(saved);
  assert.deepEqual(f.calls, []);
  for (const patch of [{ workspaceId: 'foreign' }, { answerTo: 'card:question:s:old' }]) {
    assert.equal((await f.handoff.answer({ ...f.answer('合回改动'), ...patch })).handled, false);
  }
  f.own(false);
  assert.equal((await f.handoff.answer(f.answer('合回改动'))).handled, false);
  f.own(true);
  assert.equal((await f.handoff.answer(f.answer('合回改动'))).handled, true);
  assert.deepEqual(f.calls, ['merge']);
  assert.equal(f.get().delegationOrigin.handoffAuthorizedAt, '2026-10-02T00:00:00.000Z');
  const restarted = createGoalPlanStore({ storeDir: f.store.getStoreDir() }).getPlan(f.get().planId);
  assert.equal(restarted.delegationOrigin.handoffAuthorizedAt, f.get().delegationOrigin.handoffAuthorizedAt);
  assert.equal(restarted.delegationOrigin.isolation, 'worktree');
  assert.equal(restarted.delegationOrigin.isolationRetainedAt, '2026-10-01T00:00:00.000Z');
});

test('repair consumes old acceptance and creates runnable work; old card cannot authorize the repaired result', async t => {
  const f = fixture(t, 'merge_conflict');
  const old = f.answer('让任务自己解决');
  assert.equal((await f.handoff.answer(old)).repairing, true);
  const saved = f.get();
  assert.equal(saved.resultAcceptance, undefined);
  assert.equal(saved.qualityReview, undefined);
  assert.equal(saved.tasks.at(-1).status, 'pending');
  assert.equal(saved.status, 'executing');
  assert.equal(saved.delegationOrigin.phase, 'queued');
  assert.equal(saved.runner.turnCount, 0);
  assert.ok(f.calls.includes('promote'));
  assert.equal((await f.handoff.answer(old)).handled, false);
  assert.notEqual(handoffQuestionId(null, '2026-10-01'), handoffQuestionId(null, '2026-10-02'));
});

test('conflict decisions defer only this handoff and discard only after successful cleanup', async t => {
  const f = fixture(t, 'target_checkout_dirty');
  assert.equal((await f.handoff.answer(f.answer('我来处理'))).deferred, true);
  assert.equal(f.handoff.facts('s').deferred, true);
  f.store.recordDeliveryHandoff(f.get().planId, { status: 'stopped', stoppedReason: 'merge_conflict', updatedAt: '2026-10-03T00:00:00Z' });
  assert.equal(f.handoff.facts('s').deferred, false);
  f.discard(false);
  assert.equal((await f.handoff.answer(f.answer('放弃这次改动'))).error, 'cleanup_failed');
  assert.equal(f.get().status, 'completed');
  f.discard(true);
  assert.equal((await f.handoff.answer(f.answer('放弃这次改动'))).discarded, true);
  assert.equal(f.get().status, 'cancelled');
});

test('handoff cards use user-facing reasons, existing input channel, and confirmation gates are not conflicts', t => {
  const f = fixture(t, 'merge_conflict');
  const card = projectCards('w', { handoffs: [f.handoff.facts('s')] })[0];
  assert.match(card.content, /冲突/);
  assert.doesNotMatch(card.content, /merge_conflict/);
  assert.deepEqual(card.actions.map(a => a.channel), Array(3).fill('project-agent:submit-input'));
  f.store.recordDeliveryHandoff(f.get().planId, { status: 'stopped', stoppedReason: 'handoff_confirmation_required' });
  const confirm = projectCards('w', { handoffs: [f.handoff.facts('s')] })[0];
  assert.deepEqual(confirm.actions.map(a => a.payload.text), ['合回改动', '暂不合回']);
});
