import assert from 'node:assert/strict';
import test from 'node:test';
import { createShellTaskManager } from './runtime-gateway/shell-task-manager.mjs';
import { setTimeout as delay } from 'node:timers/promises';

async function until(check) {
  for (let n = 0; n < 200; n++) { if (await check()) return; await delay(25); }
  assert.fail('condition did not settle');
}
const nodeCommand = (code) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;

for (const stream of ['stdout', 'stderr']) {
  test(`background_${stream}_tail_updates_beyond_artifact_cap_and_after_exit`, { timeout: 10_000 }, async (t) => {
    const manager = createShellTaskManager();
    t.after(() => manager.dispose());
    const task = manager.runTask({ cwd: process.cwd(), runInBackground: true,
      command: nodeCommand(`process.${stream}.write('x'.repeat(2100000),()=>{process.${stream}.write('LATEST-MARKER');setInterval(()=>{},1000)})`) });
    const current = () => manager.listTasks().find((row) => row.taskId === task.taskId);
    await until(() => current()[stream].endsWith('LATEST-MARKER'));
    assert.ok(current()[stream].length <= 32000);
    manager.stopTask(task.taskId);
    await task.completion;
    assert.ok(current()[stream].endsWith('LATEST-MARKER'));
  });
}

for (const resistantLeader of [false, true]) {
  test(`background_group_cleanup_with_${resistantLeader ? 'resistant' : 'exiting'}_leader`, { skip: process.platform === 'win32', timeout: 12_000 }, async (t) => {
    const manager = createShellTaskManager();
    let childPid;
    t.after(async () => {
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
      await manager.dispose();
    });
    const childCode = `const s=require('node:net').createServer();process.on('SIGTERM',()=>{});s.listen(0,'127.0.0.1',()=>process.send({port:s.address().port,pid:process.pid}))`;
    const parentCode = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','ignore','ignore','ipc']});child.on('message',m=>{console.log(JSON.stringify(m));child.disconnect()});${resistantLeader ? "process.on('SIGTERM',()=>{});" : ''}setInterval(()=>{},1000)`;
    const task = manager.runTask({ cwd: process.cwd(), runInBackground: true, command: nodeCommand(parentCode) });
    const current = () => manager.listTasks().find((row) => row.taskId === task.taskId);
    await until(() => current().stdout.includes('"port"'));
    const info = JSON.parse(current().stdout.trim());
    childPid = info.pid;
    assert.equal(manager.stopTask(task.taskId).stopped, true);
    assert.equal(current().status, 'stopping');
    await task.completion;
    const { createServer } = await import('node:net');
    const probe = createServer();
    t.after(() => probe.close());
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(info.port, '127.0.0.1', resolve); });
    await new Promise((resolve) => probe.close(resolve));
    assert.equal(current().status, 'cancelled');
  });
}

test('dispose waits for pending artifacts and tolerates storage failure', async (t) => {
  let release;
  let entered = false;
  const manager = createShellTaskManager({ logger: { error() {} }, artifactStore: {
    async writeTaskArtifacts() { entered = true; await new Promise((resolve) => { release = resolve; }); throw new Error('test storage failure'); },
  } });
  t.after(async () => { release?.(); await manager.dispose(); });
  const task = manager.runTask({ cwd: process.cwd(), runInBackground: true, command: 'printf artifact-check' });
  await until(() => entered);
  let disposed = false;
  const disposing = manager.dispose().then(() => { disposed = true; });
  await delay(30);
  assert.equal(disposed, false);
  release();
  await Promise.all([disposing, task.completion]);
  assert.match(manager.listTasks()[0].stderr, /Artifact write failed/);
});

const command = `${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'`;
for (const background of [false, true]) {
  test(`manager_${background ? 'background' : 'foreground'}_source_and_explicit_cleanup`, async () => {
    const manager = createShellTaskManager();
    const task = manager.runTask({ command, cwd: process.cwd(), conversationId: 'A', runInBackground: background });
    try {
      const [record] = manager.listTasks();
      assert.equal(record.taskId, task.taskId);
      assert.equal(record.conversationId, 'A');
      assert.equal(record.runInBackground, background);
      assert.equal(manager.stopActiveTask('B').stopped, false);
      assert.equal(manager.stopActiveTask().stopped, false);
      if (background) assert.equal(manager.stopActiveTask('A').stopped, false);
      assert.equal(manager.stopTask(task.taskId).stopped, true);
      await task.completion;
      assert.notEqual(manager.listTasks()[0].status, 'running');
    } finally { await manager.dispose(); }
  });
  test(`manager_${background ? 'background' : 'foreground'}_dispose_waits_for_exit`, async () => {
    const manager = createShellTaskManager();
    const task = manager.runTask({ command, cwd: process.cwd(), conversationId: 'A', runInBackground: background });
    await manager.dispose();
    await task.completion;
    assert.notEqual(manager.listTasks()[0].status, 'running');
    await manager.dispose();
  });
}
