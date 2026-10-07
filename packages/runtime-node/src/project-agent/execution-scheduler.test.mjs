import { validateDelegationInput } from './tool-specs.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExecutionScheduler } from './execution-scheduler.mjs';

const AT = '2026-10-01T00:00:00.000Z';
function plan(id, { workspaceId = 'w', phase = 'queued', readOnly = true, priority = 'normal', dependsOn = [], ...rest } = {}) {
  return { planId: id, title: id, status: phase === 'running' ? 'executing' : 'paused', createdAt: AT,
    delegationOrigin: { sessionId: id, workspaceId, phase, readOnly, priority, dependsOn }, ...rest };
}

test('one in-place write and two reads run independently; isolation hints do not bypass write slots', () => {
  const s = createExecutionScheduler();
  const plans = [plan('write', { phase: 'running', readOnly: false }), plan('read', { phase: 'running' }),
    plan('r2'), plan('r3'), plan('w2', { readOnly: false }),
    plan('hint', { readOnly: false, isolation: 'worktree' }),
    plan('isolated', { readOnly: false, deliveryBinding: { executionIsolation: 'worktree', worktreePath: '/owned/tree' } })];
  const selected = s.select(plans);
  assert.deepEqual(selected.start.map(p => p.planId), ['r2', 'isolated']);
  assert.equal(s.inspect(plans[4], plans).reason, 'write_slot');
  assert.deepEqual(s.inspect(plans[4], plans).queuedBehind, [{ sessionId: 'write', title: 'write' }]);
});

test('priority, FIFO and bounded one-level aging survive restart', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b4-scheduler-'));
  let at = AT;
  try {
    const plans = [plan('low', { priority: 'low' }), plan('n1'), plan('n2'), plan('high', { priority: 'high' })];
    const s = createExecutionScheduler({ rootDir: root, now: () => at });
    assert.deepEqual(s.select(plans).start.map(p => p.planId), ['high', 'n1']);
    const restored = createExecutionScheduler({ rootDir: root, now: () => at });
    assert.deepEqual(restored.select([...plans].reverse()).start.map(p => p.planId), ['high', 'n1']);
    at = '2026-10-01T00:30:00.000Z';
    assert.deepEqual(restored.select(plans).start.map(p => p.planId), ['n1', 'n2']);
    const freshNormal = plan('fresh', { createdAt: at });
    assert.deepEqual(restored.select([plans[0], freshNormal]).start.map(p => p.planId), ['low', 'fresh']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('approval starts queue aging at admission and preserves that timestamp after restart', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b4-admission-'));
  let at = '2026-10-01T00:10:00.000Z';
  try {
    const writer = plan('writer', { phase: 'running', readOnly: false });
    const waiting = plan('waiting', { readOnly: false, createdAt: at });
    const approval = plan('approval', { phase: 'awaiting_approval', readOnly: false });
    const scheduler = createExecutionScheduler({ rootDir: root, now: () => at });
    assert.deepEqual(scheduler.select([writer, waiting, approval]).start, []);
    at = '2026-10-01T00:31:00.000Z';
    const approved = { ...approval, delegationOrigin: { ...approval.delegationOrigin, phase: 'queued' } };
    assert.deepEqual(scheduler.select([approved, waiting]).start.map(p => p.planId), ['waiting']);
    const saved = JSON.parse(readFileSync(path.join(root, 'w', 'scheduler.json'), 'utf8'));
    assert.equal(saved.items.find(item => item.sessionId === 'approval').enqueuedAt, at);
    at = '2026-10-01T00:59:00.000Z';
    const restored = createExecutionScheduler({ rootDir: root, now: () => at });
    const high = plan('high', { priority: 'high', readOnly: false, createdAt: at });
    assert.deepEqual(restored.select([approved, high]).start.map(p => p.planId), ['high']);
    at = '2026-10-01T01:01:00.000Z';
    assert.deepEqual(restored.select([approved, high]).start.map(p => p.planId), ['approval']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dependencies require persisted acceptance, failed dependencies wait for the user', () => {
  const s = createExecutionScheduler();
  const dep = plan('dep', { status: 'completed' });
  const child = plan('child', { dependsOn: ['dep'] });
  assert.equal(s.inspect(child, [dep, child]).reason, 'dependencies');
  assert.equal(s.select([dep, child]).start.length, 0);
  const accepted = { ...dep, resultAcceptance: { acceptedAt: AT } };
  assert.deepEqual(s.select([accepted, child]).start.map(p => p.planId), ['child']);
  for (const status of ['failed', 'cancelled']) {
    assert.deepEqual(s.select([{ ...dep, status }, child]).blocked.map(p => p.planId), ['child']);
  }
  assert.equal(s.inspect(child, [child]).reason, 'dependency_missing');
  assert.equal(s.inspect(child, [plan('dep', { workspaceId: 'other', status: 'completed', resultAcceptance: { acceptedAt: AT } }), child]).reason, 'dependency_missing');
});

test('global round cap, priority and finally release apply across projects', async () => {
  const s = createExecutionScheduler({ getConcurrency: () => 1 });
  let release;
  const first = s.withTurn({}, () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const order = [];
  const low = s.withTurn({ priority: 'low', workspaceId: 'a' }, () => { order.push('low'); });
  const high = s.withTurn({ priority: 'high', workspaceId: 'b' }, () => { order.push('high'); throw Error('provider failed'); });
  const checked = assert.rejects(high, /provider failed/);
  assert.equal(s.stats().active, 1);
  assert.equal(s.stats().waiting, 2);
  release();
  await Promise.all([first, low, checked]);
  assert.deepEqual(order, ['high', 'low']);
  assert.equal(s.stats().active, 0);
});

test('cancelling a queued round never invokes the provider; reducing the cap does not cancel running rounds', async () => {
  let cap = 2;
  const s = createExecutionScheduler({ getConcurrency: () => cap });
  const releases = [];
  const live = [0, 1].map(() => s.withTurn({}, () => new Promise(resolve => releases.push(resolve))));
  await Promise.resolve();
  const controller = new AbortController();
  let called = false;
  const queued = s.withTurn({ signal: controller.signal }, () => { called = true; });
  controller.abort();
  assert.equal((await queued).terminalStatus, 'aborted');
  assert.equal(called, false);
  cap = 1;
  const next = s.withTurn({}, () => { called = true; });
  releases[0](); await Promise.resolve(); await Promise.resolve();
  assert.equal(called, false);
  releases[1](); await Promise.all([...live, next]);
  assert.equal(called, true);
  assert.equal(s.stats().active, 0);
});

test('corrupt queue order is rebuilt from Plans; live counts and leases are never restored from disk', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b4-corrupt-'));
  try {
    mkdirSync(path.join(root, 'w')); writeFileSync(path.join(root, 'w', 'scheduler.json'), '{broken');
    const admittedAt = '2026-10-01T00:45:00.000Z';
    const s = createExecutionScheduler({ rootDir: root, now: () => admittedAt });
    const plans = [plan('late', {createdAt:'2026-10-01T00:01:00Z'}), plan('early')];
    assert.deepEqual(s.select(plans).start.map(p => p.planId), ['early', 'late']);
    const saved = JSON.parse(readFileSync(path.join(root, 'w', 'scheduler.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['items','version']);
    assert.ok(saved.items.every(item => item.enqueuedAt === admittedAt));
    assert.deepEqual(s.stats(), { active:0, waiting:0, limit:4 });
    assert.equal(s.inspect(plan('writer', {readOnly:false}), [plan('other', {workspaceId:'other',phase:'running',readOnly:false})]).allowed, true);
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test('synchronous verifier handoff works at cap one and reacquires before the caller continues', async () => {
  const s = createExecutionScheduler({getConcurrency:()=>1});
  const order=[];
  await s.withTurn({priority:'high'}, async () => {
    order.push('caller');
    const background=s.withTurn({priority:'normal'}, () => { order.push('background'); assert.equal(s.stats().active,1); });
    await s.yieldTurn(() => s.withTurn({}, () => { order.push('verifier'); assert.equal(s.stats().active,1); }));
    await background;
    order.push('caller-resumed'); assert.equal(s.stats().active,1);
  });
  assert.deepEqual(order,['caller','background','verifier','caller-resumed']);
  assert.equal(s.stats().active,0);
});

test('repeated selection cannot admit a reserved task twice and user waits do not auto restart', () => {
  const s=createExecutionScheduler();
  const selected=s.select([plan('w1',{readOnly:false}),plan('w2',{readOnly:false})]);
  const reserved={...selected.start[0],delegationOrigin:{...selected.start[0].delegationOrigin,phase:'running'}};
  assert.equal(s.select([reserved,plan('w2',{readOnly:false})]).start.length,0);
  assert.equal(s.select([plan('waiting',{runner:{status:'waiting_user'}})]).start.length,0);
});

test('spawn priority rejects arbitrary strings at the existing tool boundary', () => {
  const input={anchorMessageIds:['u'],title:'任务',brief:'测试',kind:'code',readOnly:false,successCriteria:[{kind:'model_review',description:'测试'}]};
  for(const priority of ['high','normal','low']) assert.equal(validateDelegationInput('spawn_session',{...input,priority}).ok,true);
  assert.equal(validateDelegationInput('spawn_session',{...input,priority:'urgent'}).ok,false);
});

test('cancellation during inline review reaches the reviewer and does not reacquire an aborted parent lease', async () => {
  const s=createExecutionScheduler({getConcurrency:()=>1});const controller=new AbortController();
  const parent=s.withTurn({signal:controller.signal},async()=>s.yieldTurn(signal=>s.withTurn({signal},async childSignal=>{
    controller.abort();assert.equal(childSignal.aborted,true);throw Error('review aborted');
  })));
  await assert.rejects(parent,/review aborted/);assert.deepEqual(s.stats(),{active:0,waiting:0,limit:1});
});

test('recovery readiness gates queue admission and delegated rounds until the project is ready', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'b4-recovery-scheduler-')); let ready = false; let calls = 0;
  const scheduler = createExecutionScheduler({ rootDir }); scheduler.configure({ isWorkspaceReady: () => ready });
  const queued = plan('queued');
  try {
    scheduler.reconcile([queued], { workspaceId: 'w' });
    assert.deepEqual(scheduler.select([queued]).start, []);
    assert.equal((await scheduler.withTurn({ planId: queued.planId }, () => { calls++; })).error, 'recovery_pending');
    assert.equal(calls, 0); ready = true;
    assert.deepEqual(scheduler.select([queued]).start.map(item => item.planId), ['queued']);
    await scheduler.withTurn({ planId: queued.planId }, () => { calls++; }); assert.equal(calls, 1);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('plan cancellation aborts Explorer and Verifier rounds and waits for both tools to settle', async () => {
  const scheduler = createExecutionScheduler(); const release = []; const started = [];
  const turns = ['explorer', 'verifier'].map(role => scheduler.withTurn({ planId: 'p' }, async signal => {
    started.push(role);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => release.push(resolve));
  }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(started.length, 2);
  scheduler.cancelPlan('p'); let idle = false;
  const waited = scheduler.waitForPlanIdle('p').then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(idle, false);
  release.splice(0).forEach(resolve => resolve()); await Promise.all([...turns, waited]);
  assert.equal(idle, true); assert.equal(scheduler.stats().active, 0);
});

test('a delegated round waiting for a global slot rechecks project ownership before execution', async () => {
  let ready = true, release, calls = 0;
  const scheduler = createExecutionScheduler({ getConcurrency: () => 1 });
  scheduler.configure({ isWorkspaceReady: () => ready }); scheduler.reconcile([plan('p')]);
  const occupying = scheduler.withTurn({}, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const queued = scheduler.withTurn({ planId: 'p' }, () => { calls++; });
  ready = false; release(); await occupying;
  assert.equal((await queued).error, 'recovery_pending'); assert.equal(calls, 0); assert.equal(scheduler.stats().active, 0);
});
