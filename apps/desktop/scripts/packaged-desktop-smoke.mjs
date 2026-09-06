/**
 * Launch-smoke for a Linux unpacked Desktop build.
 *
 * Starts the electron-builder `dir` binary with remote debugging, waits until
 * Chromium publishes a page target, then exits. This does not drive the
 * workbench UI — use the webview keep-alive probe for guest remount signals.
 *
 *   PEER_AGENT_PACKAGED_BIN=/path/to/peer-agent node scripts/packaged-desktop-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const binary = process.env.PEER_AGENT_PACKAGED_BIN
  || path.resolve(process.cwd(), '../../dist-electron/linux-unpacked/peer-agent');
const port = Number(process.env.PEER_AGENT_DEBUG_PORT || 9333);
const home = process.env.PEER_AGENT_HOME
  || mkdtempSync(path.join(tmpdir(), 'peer-agent-packaged-smoke-'));

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url, timeoutMs = 20_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(200);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message || lastError}`);
}

const child = spawn(binary, [
  `--remote-debugging-port=${port}`,
  '--no-sandbox',
  '--disable-gpu',
  '--in-process-gpu',
], {
  env: {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':1',
    ELECTRON_DISABLE_SANDBOX: '1',
    PEER_AGENT_HOME: home,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

const report = {
  binary,
  home,
  port,
  pid: child.pid,
  launched: false,
  targets: [],
};

try {
  const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  report.launched = true;
  report.browser = version.Browser;
  report.webSocketDebuggerUrl = version.webSocketDebuggerUrl;
  report.targets = (Array.isArray(targets) ? targets : []).map((target) => ({
    type: target.type,
    title: target.title,
    url: target.url,
  }));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.targets.some((target) => target.type === 'page')) {
    throw new Error('packaged app published DevTools but no page target');
  }
} catch (error) {
  report.error = String(error?.message || error);
  report.stdoutTail = stdout.slice(-2_000);
  report.stderrTail = stderr.slice(-2_000);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  child.kill('SIGTERM');
  process.exitCode = 1;
  await wait(500);
  process.exit(process.exitCode);
}

child.kill('SIGTERM');
await wait(400);
if (!child.killed) child.kill('SIGKILL');
process.exit(0);
