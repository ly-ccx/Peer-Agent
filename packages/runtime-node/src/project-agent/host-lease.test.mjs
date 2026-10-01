import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createHostLease,
  delegatedPlanRunsWithLease,
  listBotWorkspaceIds,
} from './host-lease.mjs';

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'b2-06-lease-'));
}

function clockedSchedule() {
  let clock = 0;
  let scheduled = 0;
  let cleared = 0;
  return {
    now: () => clock,
    set(ms) { clock = ms; },
    schedule() {
      scheduled += 1;
      return { unref() {} };
    },
    cancel() { cleared += 1; },
    counts: () => ({ scheduled, cleared }),
  };
}

function service(root, clock, extra = {}) {
  return createHostLease({
    rootDir: root,
    hostId: extra.hostId || 'host-a',
    surface: extra.surface || 'desktop',
    pid: extra.pid || 101,
    appVersion: '0.1.0-beta.1',
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    projectAgentEnabled: extra.projectAgentEnabled,
    botWorkspaceIds: extra.botWorkspaceIds,
  });
}

function readLease(root, workspaceId) {
  return JSON.parse(readFileSync(path.join(root, workspaceId, 'host.lease'), 'utf8'));
}

test('获取、心跳、过期接手和正常释放', () => {
  const root = tempRoot();
  try {
    const clock = clockedSchedule();
    const holder = service(root, clock);
    clock.set(1_000);
    const acquired = holder.acquire('ws-1');
    assert.equal(acquired.acquired, true);
    assert.equal(holder.holds('ws-1'), true);
    const onDisk = readLease(root, 'ws-1');
    assert.equal(onDisk.hostId, 'host-a');
    assert.equal(onDisk.surface, 'desktop');
    assert.equal(onDisk.pid, 101);
    assert.equal(onDisk.appVersion, '0.1.0-beta.1');
    assert.equal(Date.parse(onDisk.acquiredAt), 1_000);
    assert.equal(Date.parse(onDisk.heartbeatAt), 1_000);
    assert.equal(clock.counts().scheduled, 1);

    holder.acquire('ws-2');
    assert.equal(clock.counts().scheduled, 1);
    assert.deepEqual(holder.heldWorkspaceIds().sort(), ['ws-1', 'ws-2']);

    clock.set(6_000);
    holder.pulse();
    const beat = readLease(root, 'ws-1');
    assert.equal(Date.parse(beat.acquiredAt), 1_000);
    assert.equal(Date.parse(beat.heartbeatAt), 6_000);

    const rival = service(root, clock, { hostId: 'host-b', pid: 202 });
    assert.equal(rival.acquire('ws-1').acquired, false);
    assert.equal(rival.holds('ws-1'), false);

    clock.set(6_000 + 20_000);
    const took = rival.acquire('ws-1');
    assert.equal(took.acquired, true);
    assert.equal(took.tookOver, true);
    assert.equal(holder.holds('ws-1'), false);
    assert.equal(readLease(root, 'ws-1').hostId, 'host-b');

    rival.release('ws-1');
    assert.equal(holder.acquire('ws-1').reason, undefined);
    const again = service(root, clock, { hostId: 'host-c', pid: 303 });
    holder.release('ws-1');
    clock.set(6_000);
    const freed = again.acquire('ws-1');
    assert.equal(freed.acquired, true);
    assert.equal(freed.tookOver, undefined);
    again.close();
    assert.equal(clock.counts().cleared > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('显式接管让持有方在下一拍让出，并且不会立刻抢回', () => {
  const root = tempRoot();
  try {
    const clock = clockedSchedule();
    let enabled = true;
    const holder = service(root, clock, {
      projectAgentEnabled: () => enabled,
      botWorkspaceIds: () => ['ws-yield'],
    });
    assert.equal(holder.holds('ws-yield'), true);
    const client = service(root, clock, { hostId: 'host-b', pid: 202 });
    assert.equal(client.requestTakeover('ws-yield').requested, true);
    holder.pulse();
    assert.equal(holder.holds('ws-yield'), false);
    const taken = client.acquire('ws-yield');
    assert.equal(taken.acquired, true);
    holder.pulse();
    assert.equal(holder.holds('ws-yield'), false);
    assert.equal(readLease(root, 'ws-yield').hostId, 'host-b');
    enabled = false;
    holder.pulse();
    assert.equal(holder.holds('ws-yield'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('开关打开且项目有机器人时获取租约，关闭后释放', () => {
  const root = tempRoot();
  const projects = path.join(root, 'projects');
  try {
    mkdirSync(path.join(projects, 'ws-bot'), { recursive: true });
    writeFileSync(path.join(projects, 'ws-bot', 'profile.json'), '{}\n');
    mkdirSync(path.join(projects, 'ws-plain'), { recursive: true });
    writeFileSync(path.join(projects, 'registry.json'), '[]\n');
    assert.deepEqual(listBotWorkspaceIds(projects), ['ws-bot']);

    const clock = clockedSchedule();
    let enabled = false;
    const holder = service(root, clock, {
      projectAgentEnabled: () => enabled,
      botWorkspaceIds: () => listBotWorkspaceIds(projects),
    });
    assert.equal(holder.holds('ws-bot'), false);
    enabled = true;
    holder.pulse();
    assert.equal(holder.holds('ws-bot'), true);
    assert.equal(holder.holds('ws-plain'), false);
    enabled = false;
    holder.pulse();
    assert.equal(holder.holds('ws-bot'), false);
    holder.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('两个进程抢同一空闲租约时只有一个获得', async () => {
  const root = tempRoot();
  try {
    const moduleUrl = new URL('./host-lease.mjs', import.meta.url).href;
    const helper = path.join(root, 'race-helper.mjs');
    writeFileSync(helper, `import { createHostLease } from ${JSON.stringify(moduleUrl)};
const lease = createHostLease({
  rootDir: process.env.LEASE_ROOT,
  hostId: process.env.LEASE_HOST,
  surface: 'desktop',
  pid: process.pid,
  appVersion: 'test',
  heartbeatMs: 60_000,
  staleMs: 20_000,
});
const result = lease.acquire('ws-race');
lease.dispose();
process.stdout.write(JSON.stringify({
  acquired: result.acquired === true,
  hostId: result.lease ? result.lease.hostId : null,
  reason: result.reason || null,
}));
`);
    const run = (hostId) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [helper], {
        env: { ...process.env, LEASE_ROOT: root, LEASE_HOST: hostId },
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`racer ${hostId} timed out: ${stderr}`));
      }, 10_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`racer ${hostId} exited ${code}: ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout));
      });
    });
    const [left, right] = await Promise.all([run('host-left'), run('host-right')]);
    const winners = [left, right].filter((item) => item.acquired);
    assert.equal(winners.length, 1);
    assert.equal(readLease(root, 'ws-race').hostId, winners[0].hostId);
    assert.equal([left, right].some((item) => item.acquired === false), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('任务计划只在持有租约时推进，普通计划不看租约', () => {
  const task = { delegationOrigin: { workspaceId: 'ws-1' } };
  const ordinary = { conversationId: 'conv-1' };
  assert.equal(delegatedPlanRunsWithLease(ordinary, () => false), null);
  assert.equal(delegatedPlanRunsWithLease(task, () => false), false);
  assert.equal(delegatedPlanRunsWithLease(task, (id) => id === 'ws-1'), true);
  assert.equal(delegatedPlanRunsWithLease({ delegationOrigin: { surface: 'desktop' } }, () => true), false);
});

test('接管先关闭执行闸，旧回合停止前保留心跳，停止后才允许新宿主取得租约', async () => {
  const root = tempRoot(), clock = clockedSchedule();
  const holder = service(root, clock, { projectAgentEnabled: () => true, botWorkspaceIds: () => ['ws-drain'] });
  const client = service(root, clock, { hostId: 'host-b', pid: 202, surface: 'tui' });
  let finish, calls = 0;
  holder.setYieldHandler(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  try {
    client.requestTakeover('ws-drain'); holder.pulse();
    assert.equal(holder.holds('ws-drain'), false);
    assert.equal(client.acquire('ws-drain').acquired, false);
    await Promise.resolve();
    clock.set(25_000); holder.pulse();
    assert.equal(calls, 1);
    assert.equal(Date.parse(readLease(root, 'ws-drain').heartbeatAt), 25_000);
    assert.equal(client.acquire('ws-drain').acquired, false);
    finish(); await holder.awaitDrained();
    assert.equal(holder.acquire('ws-drain').reason, 'yielded');
    assert.equal(client.acquire('ws-drain').acquired, true);
  } finally { holder.close(); client.close(); rmSync(root, { recursive: true, force: true }); }
});

test('停止失败时保留租约并重试，不在失败窗口接入另一宿主', async () => {
  const root = tempRoot(), clock = clockedSchedule();
  const holder = service(root, clock), client = service(root, clock, { hostId: 'host-b', pid: 202 });
  let calls = 0;
  holder.setYieldHandler(async () => { if (++calls === 1) throw new Error('drain failed'); });
  try {
    holder.acquire('ws-retry'); client.requestTakeover('ws-retry'); holder.pulse();
    await holder.awaitDrained();
    assert.equal(client.acquire('ws-retry').acquired, false);
    holder.pulse(); await holder.awaitDrained();
    assert.equal(calls, 2);
    assert.equal(client.acquire('ws-retry').acquired, true);
  } finally { holder.close(); client.close(); rmSync(root, { recursive: true, force: true }); }
});

test('archived bots stop being eligible for automatic lease acquisition', () => {
  const root = tempRoot(), projects = path.join(root, 'projects'); const file = path.join(projects, 'ws-archive', 'profile.json');
  try {
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ status: 'active' }));
    const clock = clockedSchedule(); const holder = service(root, clock, { projectAgentEnabled: () => true, botWorkspaceIds: () => listBotWorkspaceIds(projects) });
    holder.pulse(); assert.equal(holder.holds('ws-archive'), true);
    writeFileSync(file, JSON.stringify({ status: 'archived' })); holder.pulse();
    assert.equal(holder.holds('ws-archive'), false); assert.deepEqual(listBotWorkspaceIds(projects), []); holder.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('external ownership loss drains old execution without removing the new host lease', async () => {
  const root=tempRoot(), clock=clockedSchedule();
  const holder=service(root,clock), next=service(root,clock,{hostId:'new-host',pid:202,surface:'tui'});
  const losses=[];
  try {
    holder.setYieldHandler(async(id,reason)=>{losses.push({id,reason});});
    holder.acquire('ws-loss');clock.set(21_000);next.acquire('ws-loss');
    assert.equal(holder.holds('ws-loss'),false);
    assert.equal(holder.holds('ws-loss'),false);
    await holder.awaitDrained();
    assert.deepEqual(losses,[{id:'ws-loss',reason:'lost'}]);
    assert.equal(next.holds('ws-loss'),true);
    assert.equal(readLease(root,'ws-loss').hostId,'new-host');
  } finally {holder.close();next.close();rmSync(root,{recursive:true,force:true});}
});

test('graceful close keeps ownership until all execution has stopped', async () => {
  const root=tempRoot(), clock=clockedSchedule();
  const holder=service(root,clock), next=service(root,clock,{hostId:'new-host',pid:202,surface:'tui'});
  let release; const stopped=new Promise(resolve=>{release=resolve;});
  try {
    holder.acquire('ws-close'); holder.setYieldHandler(()=>stopped);
    const closing=holder.closeAfterDraining();
    assert.equal(holder.holds('ws-close'),false);
    assert.equal(next.acquire('ws-close').acquired,false);
    assert.equal(holder.acquire('ws-new').acquired,false);
    release(); await closing;
    assert.equal(next.acquire('ws-close').acquired,true);
  } finally {release();holder.close();next.close();rmSync(root,{recursive:true,force:true});}
});

test('failed graceful drain keeps a live lease rather than opening execution to a second host', async () => {
  const root=tempRoot(), clock=clockedSchedule();
  const holder=service(root,clock), next=service(root,clock,{hostId:'new-host',pid:202,surface:'tui'});
  try {
    holder.acquire('ws-close');holder.setYieldHandler(async()=>{throw new Error('still running');});
    await assert.rejects(holder.closeAfterDraining(),/host_drain_incomplete/);
    assert.equal(next.acquire('ws-close').acquired,false);
    assert.equal(readLease(root,'ws-close').hostId,'host-a');
  } finally {holder.close();next.close();rmSync(root,{recursive:true,force:true});}
});
