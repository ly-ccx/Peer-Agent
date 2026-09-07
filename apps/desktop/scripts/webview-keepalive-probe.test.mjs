import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const probePath = path.join(here, 'webview-keepalive-probe.mjs');
const electronBinary = require('electron');

function runProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, [probePath], {
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ':1',
        ELECTRON_DISABLE_SANDBOX: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const skipReason = process.platform === 'linux' && !hasDisplay
  ? 'Linux webview probe needs DISPLAY or WAYLAND_DISPLAY'
  : false;

test('Electron webview guest survives a stable host and reloads when the host is moved', { skip: skipReason }, async () => {
  const { code, stdout, stderr } = await runProbe();
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`probe did not print JSON report.\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error });
  }
  assert.equal(code, 0, `probe exited ${code}: ${stdout}\n${stderr}`);
  assert.equal(report.guestPreservedWhenHostStays, true);
  assert.equal(report.guestDestroyedWhenHostMoved, true);
  assert.equal(report.loadsAfterFirst, 1);
  assert.equal(report.loadsAfterStable, 1);
  assert.equal(report.fieldAfterStable, 'typed-in-page');
  assert.equal(report.afterStableBootId, report.firstBootId);
  assert.equal(report.startLoadsAfterStable, report.startLoadsAfterFirst);
  assert.notEqual(report.afterMoveWebContentsId, report.firstWebContentsId);
  assert.notEqual(report.afterMoveBootId, report.firstBootId);
});
