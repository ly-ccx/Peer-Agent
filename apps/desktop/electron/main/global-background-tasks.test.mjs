import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getApplicationShellTasks, disposeApplicationShellTasks } from './runtime-gateway/application-shell-tasks.mjs';
import { getApplicationShellSessions, disposeApplicationShellSessions, disposeApplicationShellConversation } from './runtime-gateway/application-shell-sessions.mjs';
import { createLocalShellProvider } from './runtime-gateway/local-shell-provider.mjs';
import { createLocalToolHost } from './runtime-gateway/local-tool-host.mjs';

const service = 'node -e "console.log(\'ready\');setInterval(()=>{},1000)"';
async function until(check) {
  for (let n = 0; n < 100; n++) { if (await check()) return; await delay(30); }
  assert.fail('condition did not settle');
}
async function fixture(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'peer-global-matrix-'));
  const work = path.join(home, 'project'); mkdirSync(work);
  const manager = getApplicationShellTasks(home);
  const sessions = getApplicationShellSessions(home, work);
  const provider = createLocalShellProvider({ workspaceRoot: work, userDataPath: home, taskManager: manager, sessionManager: sessions,
    approvalDecider: async () => ({ granted: true }) });
  const hostB = createLocalToolHost({ workspaceRoot: home, userDataPath: home, sessionStore: { getSession: () => null } });
  t.after(async () => {
    await disposeApplicationShellTasks(home);
    await disposeApplicationShellSessions(home);
    rmSync(home, { recursive: true, force: true });
  });
  let sequence = 0;
  const exec = (command, background = false, source = 'A', extras = {}) => provider.executeCapability({ call: {
    toolCallId: `matrix-${++sequence}`, capabilityId: 'local.shell.exec', arguments: { command, runInBackground: background, ...extras },
  } }, { conversationId: source });
  const stop = (source = 'A', args = {}, context = {}) => provider.executeCapability({ call: {
    toolCallId: `stop-${++sequence}`, capabilityId: 'local.shell.stop', arguments: args,
  } }, { conversationId: source, ...context });
  const current = (id) => manager.listTasks().find((row) => row.taskId === id);
  return { home, work, manager, sessions, provider, hostB, exec, stop, current };
}

for (const background of [false, true]) {
  for (const scenario of ['same_session', 'switch_session', 'delete_source', 'explicit_stop', 'app_exit']) {
    test(`${background ? 'background' : 'foreground'}_${scenario}`, { skip: process.platform === 'win32' ? 'Persistent shell POSIX contract; Windows uses isolated one-shot fallback.' : false }, async (t) => {
      const f = await fixture(t);
      if (background) {
        const launch = await f.exec(service, true);
        assert.equal(launch.grant.granted, true);
        const id = launch.result.outputPreview.backgroundTaskId;
        assert.ok(id);
        await until(() => f.current(id).stdout.includes('ready'));
        assert.equal(f.current(id).conversationId, 'A');
        if (scenario === 'same_session') {
          assert.equal(f.current(id).status, 'running');
          assert.equal((await f.exec('printf front-finished')).result.status, 'success');
          assert.equal(f.current(id).status, 'running');
        } else if (scenario === 'switch_session') {
          await f.exec('pwd', false, 'B');
          const record = f.hostB.listShellTasks().find((row) => row.taskId === id);
          assert.equal(record.conversationId, 'A');
          assert.equal(record.cwd, f.work);
          assert.equal(record.status, 'running');
          assert.equal((await f.stop('B')).result.outputPreview.stopped, false);
          assert.equal((await f.stop(null)).result.outputPreview.stopped, false);
          assert.equal(f.current(id).status, 'running');
        } else if (scenario === 'delete_source') {
          await disposeApplicationShellConversation(f.home, 'A');
          assert.equal(f.hostB.listShellTasks().find((row) => row.taskId === id).status, 'running');
          assert.equal(f.current(id).conversationId, 'A');
          assert.equal(f.hostB.stopShellTask(id).stopped, true);
          await until(() => f.current(id).completedAt);
        } else if (scenario === 'explicit_stop') {
          assert.equal((await f.stop('A', { taskId: id })).result.outputPreview.stopped, true);
          assert.equal(f.current(id).status, 'stopping');
          await until(() => f.current(id).completedAt);
          assert.equal(f.current(id).status, 'cancelled');
        } else {
          await disposeApplicationShellTasks(f.home);
          assert.equal(f.current(id).status, 'cancelled');
          assert.ok(f.current(id).completedAt);
        }
      } else {
        if (scenario === 'same_session' || scenario === 'switch_session') {
          mkdirSync(path.join(f.work, 'child'));
          await f.exec('export PEER_MATRIX_TOKEN=A; cd child');
          const same = await f.exec('printf "%s|%s" "$PEER_MATRIX_TOKEN" "$PWD"');
          assert.match(same.result.outputPreview.stdoutPreview ?? same.result.outputPreview.stdout ?? '', /A\|.*child/);
          if (scenario === 'switch_session') {
            const other = await f.exec('printf "%s|%s" "${PEER_MATRIX_TOKEN-unset}" "$PWD"', false, 'B');
            assert.match(other.result.outputPreview.stdoutPreview ?? other.result.outputPreview.stdout ?? '', /unset\|/);
          }
        } else {
          const running = f.exec(service);
          await delay(180);
          if (scenario === 'delete_source') await disposeApplicationShellConversation(f.home, 'A');
          if (scenario === 'explicit_stop') {
            assert.equal((await f.stop('B')).result.outputPreview.stopped, false);
            assert.equal((await f.stop('A')).result.outputPreview.stopped, true);
          }
          if (scenario === 'app_exit') await disposeApplicationShellSessions(f.home);
          const result = await running;
          assert.notEqual(result.result.status, 'success');
        }
        assert.equal(f.manager.listTasks().filter((row) => row.runInBackground).length, 0);
      }
    });
  }
}

test('cross-source explicit stop is denied without per-target approval and allowed with it', async (t) => {
  const f = await fixture(t);
  const launch = await f.exec(service, true);
  const taskId = launch.result.outputPreview.backgroundTaskId;
  let asked;
  const denied = await f.stop('B', { taskId }, { requestPermission: async (request) => { asked = request; return { granted: false }; } });
  assert.equal(denied.grant.granted, false);
  assert.equal(asked.scope.taskId, taskId);
  assert.equal(f.current(taskId).status, 'running');
  const approved = await f.stop('B', { taskId }, { requestPermission: async () => ({ granted: true }) });
  assert.equal(approved.result.outputPreview.stopped, true);
});

test('permission denial creates no global background process', async (t) => {
  const f = await fixture(t);
  const provider = createLocalShellProvider({ workspaceRoot: f.work, userDataPath: f.home, taskManager: f.manager, sessionManager: null,
    approvalDecider: async () => ({ granted: false }) });
  const result = await provider.executeCapability({ call: { toolCallId: 'denied', capabilityId: 'local.shell.exec', arguments: { command: service, runInBackground: true } } });
  assert.equal(result.grant.granted, false);
  assert.deepEqual(f.manager.listTasks(), []);
});

test('background has no default foreground deadline; explicit deadline still stops', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const task = f.manager.runTask({ command: service, cwd: f.work, runInBackground: true, conversationId: 'A' });
  t.mock.timers.tick(31_000);
  assert.equal(f.current(task.taskId).timedOut, false);
  assert.equal(f.current(task.taskId).status, 'running');
  const limited = f.manager.runTask({ command: service, cwd: f.work, runInBackground: true, timeoutMs: 500 });
  t.mock.timers.tick(501);
  assert.equal(f.current(limited.taskId).timedOut, true);
  t.mock.timers.reset();
  f.manager.stopTask(task.taskId);
  await Promise.all([task.completion, limited.completion]);
});

for (const stopMode of ['explicit', 'app_exit']) {
  test(`managed_http_${stopMode}_global_log_listener_and_port_release`, { skip: process.platform === 'win32', timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    // Port 0 is allocated by the OS; never touch an existing developer service.
    const code = `const http=require('node:http');const server=http.createServer((req,res)=>{console.log('request:'+req.url);res.end('peer-managed-ok')});server.listen(0,'127.0.0.1',()=>console.log('PORT='+server.address().port))`;
    const launch = await f.exec(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`, true);
    assert.equal(launch.grant.granted, true);
    assert.equal(launch.result.status, 'success');
    assert.ok(launch.result.evidence);
    const id = launch.result.outputPreview.backgroundTaskId;
    await until(() => /PORT=\d+/.test(f.current(id).stdout));
    const port = Number(f.current(id).stdout.match(/PORT=(\d+)/)[1]);
    const url = `http://127.0.0.1:${port}/global-check`;
    assert.equal(await (await fetch(url)).text(), 'peer-managed-ok');
    await f.exec('printf front-finished', false, 'B');
    await disposeApplicationShellConversation(f.home, 'A');
    await until(() => f.hostB.listShellTasks().find((row) => row.taskId === id)?.listeners.some((listener) => listener.port === port));
    const row = f.hostB.listShellTasks().find((task) => task.taskId === id);
    assert.equal(row.conversationId, 'A');
    assert.equal(row.cwd, f.work);
    assert.equal(row.toolCallId, launch.result.toolCallId);
    assert.match(row.stdout, /request:\/global-check/);
    assert.equal(row.status, 'running');
    assert.equal(await (await fetch(url)).text(), 'peer-managed-ok');
    if (stopMode === 'explicit') assert.equal(f.hostB.stopShellTask(id).stopped, true);
    else await disposeApplicationShellTasks(f.home);
    await until(() => f.current(id).artifactRef);
    assert.equal(f.current(id).status, 'cancelled');
    assert.deepEqual(f.current(id).listeners, []);
    await assert.rejects(fetch(url));
    const { createServer } = await import('node:net');
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const artifactDir = path.join(f.home, 'shell-artifacts', row.startedAt.slice(0, 10), id);
    const metadata = JSON.parse(readFileSync(path.join(artifactDir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.conversationId, 'A');
    assert.equal(metadata.runInBackground, true);
    assert.equal(metadata.toolCallId, row.toolCallId);
    assert.match(readFileSync(path.join(artifactDir, 'stdout.txt'), 'utf8'), /request:\/global-check/);
    t.diagnostic(`Managed ${id}: TCP 127.0.0.1:${port}, source A retained after deletion; HTTP, log evidence and ${stopMode} port rebind passed.`);
  });
}

test('foreground artifacts retain their source without becoming background records', async (t) => {
  const f = await fixture(t);
  const result = await f.exec('printf source-evidence');
  const metadata = JSON.parse(readFileSync(result.result.outputPreview.metadataArtifactPath, 'utf8'));
  assert.equal(metadata.conversationId, 'A');
  assert.equal(metadata.runInBackground, false);
});

test('main composition shares task table and separates delete-source cleanup from quit cleanup', () => {
  const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(source, /taskManager: getApplicationShellTasks\(userDataPath\)/);
  assert.match(source, /disposeApplicationShellConversation\(dataHome, id\)/);
  assert.match(source, /await Promise\.all\(\[\s*disposeApplicationShellTasks\(userDataPath\),\s*disposeApplicationShellSessions\(userDataPath\)/);
});
