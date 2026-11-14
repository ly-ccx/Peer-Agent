import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('live collector observes real Electron IPC and existing timers then restores and closes inspector', { timeout: 30000 }, async () => {
  const require = createRequire(import.meta.url);
  const moduleRoot = path.resolve(path.dirname(require.resolve('@peer-agent/runtime-node')), '../../..');
  const desktopRequire = createRequire(path.join(moduleRoot, 'apps/desktop/package.json'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ri00-live-smoke-'));
  const fixture = path.join(root, 'main.cjs'), output = path.join(root, 'capture'); fs.mkdirSync(output);
  const ready = path.join(root, 'ready');
  fs.writeFileSync(fixture, `const {app,ipcMain}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(root, 'user-data'))});
    app.whenReady().then(()=>{ipcMain.handle('ri00:fixture',()=>{const start=Date.now();while(Date.now()-start<65){}return 7});
    setInterval(function existingFixtureTimer(){ipcMain._invokeHandlers.get('ri00:fixture')(null)},150);
    require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(desktopRequire('electron'), ['--inspect=0', fixture], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let passed = false;
  child.stderr.on('data', chunk => { stderr += chunk; });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    for (let i = 0; i < 150 && !stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)\//); i++) await wait(50);
    const port = stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]; assert.ok(port, 'fixture inspector started');
    for (let i = 0; i < 150 && !fs.existsSync(ready); i++) await wait(50);
    assert.ok(fs.existsSync(ready), stderr);
    const wrongOutput = path.join(root, 'wrong-target'); fs.mkdirSync(wrongOutput);
    const wrong = spawn(process.execPath, [fileURLToPath(new URL('../observe-runtime-live.mjs', import.meta.url)),
      '--pid', String(child.pid + 1000000), '--port', port, '--duration-ms', '1000',
      '--close-inspector', '--output', wrongOutput], { stdio: 'ignore' });
    assert.equal(await new Promise(resolve => wrong.on('close', resolve)), 1);
    const refused = JSON.parse(fs.readFileSync(path.join(wrongOutput, 'report.private.json'), 'utf8'));
    assert.deepEqual(refused.failures, ['target_pid_or_host_mismatch']);
    assert.equal(refused.inspectorClosed, false, 'a mismatched target must retain its inspector and globals');
    assert.equal((await fetch(`http://127.0.0.1:${port}/json/list`)).ok, true);
    const collector = spawn(process.execPath, [fileURLToPath(new URL('../observe-runtime-live.mjs', import.meta.url)),
      '--pid', String(child.pid), '--port', port, '--package-json', path.join(moduleRoot, 'apps/desktop/package.json'),
      '--duration-ms', '1500', '--no-builtins', '--close-inspector', '--output', output], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; collector.stderr.on('data', data => { log += data; }); collector.stdout.on('data', data => { log += data; });
    const exit = await new Promise(resolve => collector.on('close', resolve));
    assert.equal(exit, 0, log);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.private.json'), 'utf8'));
    assert.equal(report.ok, true); assert.equal(report.inspectorClosed, true);
    assert.equal(report.deepBuiltins, false); assert.equal(report.gc.stopped, true);
    assert.ok(report.adoptedExistingTimers > 0);
    assert.ok(report.observation.restored.every(Boolean));
    assert.ok(report.observation.records.some(row => row.kind === 'ipc-invoke' && row.name === 'ri00:fixture' && row.synchronousMs >= 50));
    assert.ok(report.observation.records.some(row => row.kind === 'timer' && row.synchronousMs >= 50));
    assert.ok(report.profileSamples > 0);
    assert.equal(child.exitCode, null, 'collector did not quit or restart the observed fixture');
    passed = true;
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => child.exitCode == null ? child.once('close', resolve) : resolve());
    if (passed) fs.rmSync(root, { recursive: true, force: true });
    else { fs.writeFileSync(path.join(root, 'fixture-stderr.txt'), stderr); process.stderr.write(`Failed synthetic capture retained: ${root}\n`); }
  }
});
