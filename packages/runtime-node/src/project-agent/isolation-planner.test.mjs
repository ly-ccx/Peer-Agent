import assert from 'node:assert/strict';
import test from 'node:test';
import { createIsolationPlanner, decideIsolation, MIN_WORKTREE_FREE_BYTES } from './isolation-planner.mjs';

const plan = (id = 'p', origin = {}) => ({ planId: id, status: 'paused', delegationOrigin: {
  workspaceId: 'w', phase: 'queued', readOnly: false, isolation: 'auto', ...origin },
  deliveryBinding: { executionIsolation: 'none' } });
const clean = { git: true, dirty: false, freeBytes: MIN_WORKTREE_FREE_BYTES };

test('isolation matrix honors read-only, non-git, explicit choices, dirty state and actual writers', () => {
  const p = plan();
  const writer = plan('writer', { phase: 'running' });
  assert.equal(decideIsolation(plan('read', { readOnly: true }), { ok: false }, [writer]).isolation, 'none');
  assert.equal(decideIsolation(p, { git: false }, [writer]).isolation, 'none');
  assert.equal(decideIsolation(p, clean).isolation, 'none');
  assert.equal(decideIsolation(p, clean, [writer]).isolation, 'worktree');
  assert.equal(decideIsolation(p, { ...clean, dirty: true }).isolation, 'worktree');
  assert.equal(decideIsolation(plan('explicit', { isolation: 'worktree' }), clean).isolation, 'worktree');
  assert.deepEqual(decideIsolation(plan('explicit', { isolation: 'none' }), clean, [writer]), { isolation: 'none', reason: 'write_slot' });
  assert.equal(decideIsolation(p, clean, [{ ...writer, status: 'completed' }]).isolation, 'none');
  assert.equal(decideIsolation(p, clean, [plan('foreign', { workspaceId: 'other', phase: 'running' })]).isolation, 'none');
  assert.deepEqual(decideIsolation(p, { ...clean, dirty: true, freeBytes: MIN_WORKTREE_FREE_BYTES - 1 }), { isolation: 'wait', reason: 'disk_space' });
  assert.equal(decideIsolation(p, { ...clean, dirty: true, freeBytes: undefined }).reason, 'isolation_failed');
  assert.equal(decideIsolation(p, { ...clean, existingWorktree: true, freeBytes: 0 }).isolation, 'worktree');
});

function harness({ facts = { ...clean, dirty: true }, fail = false } = {}) {
  let current = plan(); let at = '2026-10-01T00:00:00Z'; const calls = [];
  const planner = createIsolationPlanner({
    readFacts: async p => ({ ...facts, existingWorktree: Boolean(p.deliveryBinding.worktreePath) }),
    isolatePlan: async p => { calls.push('create'); return fail ? { ok: false, plan: p } : { ok: true,
      plan: current = { ...p, deliveryBinding: { executionIsolation: 'worktree', worktreePath: '/owned/p' } } }; },
    recordIsolation: (p, isolation) => current = { ...p, deliveryBinding: isolation },
    recordOrigin: (p, patch) => current = { ...p, delegationOrigin: { ...p.delegationOrigin, ...patch } },
    discardLine: async p => { calls.push('cleanup'); return { ok: true,
      plan: current = { ...p, deliveryBinding: { executionIsolation: 'none', taskBranch: 'retained-branch' } } }; },
    now: () => at,
  });
  return { planner, calls, facts, get: () => current, time: value => { at = value; } };
}

test('creation failure and low disk remain queued, then retry without claiming a fake worktree', async () => {
  const failed = harness({ fail: true });
  const result = await failed.planner.prepare(failed.get());
  assert.equal(result.ok, false); assert.equal(result.plan.delegationOrigin.isolationBlock, 'isolation_failed');
  assert.equal(result.plan.deliveryBinding.executionIsolation, 'none');
  const env = harness({ facts: { ...clean, dirty: true, freeBytes: 0 } });
  assert.equal((await env.planner.prepare(env.get())).reason, 'disk_space');
  assert.deepEqual(env.calls, []);
  env.facts.freeBytes = MIN_WORKTREE_FREE_BYTES;
  const retried = await env.planner.prepare(env.get());
  assert.equal(retried.ok, true); assert.equal(retried.plan.delegationOrigin.isolationBlock, null);
  assert.equal(retried.plan.deliveryBinding.worktreePath, '/owned/p');
});

test('cancelled or delivered worktrees are cleaned, failed worktrees survive seven days', async () => {
  for (const terminal of [{ status: 'cancelled' }, { status: 'completed', deliveryHandoff: { status: 'delivered' } }]) {
    const env = harness(); await env.planner.prepare(env.get());
    const cleaned = await env.planner.cleanup({ ...env.get(), ...terminal });
    assert.equal(cleaned.deliveryBinding.worktreePath, undefined);
    assert.equal(cleaned.deliveryBinding.taskBranch, 'retained-branch');
  }
  const env = harness(); await env.planner.prepare(env.get());
  const failed = await env.planner.cleanup({ ...env.get(), status: 'failed' });
  env.time('2026-10-07T23:59:59Z');
  assert.ok((await env.planner.cleanup(failed)).deliveryBinding.worktreePath);
  env.time('2026-10-08T00:00:00Z');
  assert.equal((await env.planner.cleanup(failed)).deliveryBinding.worktreePath, undefined);
  assert.equal(env.calls.filter(call => call === 'cleanup').length, 1);
  const interrupted = harness(); await interrupted.planner.prepare(interrupted.get());
  const retained = await interrupted.planner.cleanup({ ...interrupted.get(), status: 'interrupted', runner: { status: 'failed' } });
  assert.ok(retained.delegationOrigin.isolationRetainedAt);
  assert.ok(retained.deliveryBinding.worktreePath);
});
