// RC-01: production main/preload/renderer, synthetic cognition at the executor seam.
// This proves shell/IPC/durable input behavior, never live-model latency or tool execution.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { prepareLabIsolation } from './lab-workspace-isolate.mjs';
import { createOwnedProcessRegistry } from './lab-process-identity.mjs';
import { seedBotShellHome } from './seed-bot-shell-home.mjs';
import { metric } from './perf-project-agent.mjs';

const source = fileURLToPath(new URL('../../..', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'peer-bot-shell-smoke-'));
const home = path.join(root, 'data'); mkdirSync(home);
const fixture = seedBotShellHome({ home });
const settings = JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8'));
settings.memory = { enabled: false };
const isolation = prepareLabIsolation({ sourceRoot: source, labHome: home });
cpSync(path.join(source, 'apps/desktop/dist'), isolation.launch.distDir, { recursive: true });
writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
const main = path.join(isolation.launch.desktopDir, 'electron/main/main.mjs');
const mainText = readFileSync(main, 'utf8');
const seam = 'const agentTurnExecutor = createAgentTurnExecutor({ llmChatService });';
assert.equal(mainText.split(seam).length, 2, 'exact production executor assembly seam required');
writeFileSync(main, mainText.replace(seam,
  'const agentTurnExecutor = createAgentTurnExecutor({ llmChatService: globalThis.rcBotShellService });'));
const entry = path.join(root, 'entry.mjs');
writeFileSync(entry, `import {app} from 'electron';
import {resolveRoleRoute} from ${JSON.stringify(pathToFileURL(path.join(source, 'packages/runtime-node/dist/index.js')).href)};
app.setPath('userData',${JSON.stringify(path.join(root, 'chromium'))});
globalThis.rcBotShellTurns=[];
globalThis.rcBotShellService={
  resolveGoalRole(input){return resolveRoleRoute({...input,providers:[{id:'rc-scripted',model:'scripted-fixture',enabled:true,apiKeyConfigured:true,supportsTools:true,supportsStructured:true,supportsVision:false,isDefault:true}]});},
  async sendMessage(input){
    globalThis.rcBotShellTurns.push({role:input.turnProfile?.role,workspaceId:input.turnProfile?.workspaceId});
    await new Promise(resolve=>setTimeout(resolve,120));
    const text=input.messages?.findLast(message=>message.role==='user')?.content || '';
    return {terminalStatus:'done',text:'RC scripted reply: '+text};
  },abort(){}
};
app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(main).href)})).catch(error=>{console.error(error);app.exit(1)});
`);
const env = { ...process.env, PEER_AGENT_HOME: home, PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1',
  PEER_WORKSPACE_ROOT: fixture.bots[0].path };
delete env.ELECTRON_RUN_AS_NODE;
const owned = createOwnedProcessRegistry();
const report = { schemaVersion: 1, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim()),
  synthetic: true, scale: fixture.scale, platform: process.platform, startedAt: new Date().toISOString(),
  checks: [], pageErrors: [], receiptSamples: [], scope: 'Real source Electron main/preload/renderer and durable input; scripted cognition only; not installed or real-model timing' };
let app, handle, page; const logs = [];
const until = async (read, predicate, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Shell acceptance timed out');
};
try {
  app = await _electron.launch({ args: [entry], env, cwd: isolation.launch.desktopDir, timeout: 30000 });
  handle = owned.register({ process: app.process(), close: () => app.close() });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', data => logs.push(String(data)));
  page = await until(() => app.windows().find(window => window.url().includes('/dist/index.html') && !window.url().includes('window=')), Boolean, 120000);
  report.windowReadyMs = Date.now() - Date.parse(report.startedAt);
  page.setDefaultTimeout(15000); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.locator('.bot-shell').waitFor();
  await until(() => page.locator('.bot-row').count(), count => count === fixture.scale.bots);
  assert.equal((await app.evaluate(() => globalThis.rcBotShellTurns)).length, 0, 'idle bots must not open model turns');
  report.checks.push('200 real bot rows; no idle model turns');
  await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-000' }) }).click();
  await page.locator('.bot-composer textarea').waitFor();
  for (let i = 0; i < 5; i++) {
    const text = `RC_UI_RECEIPT_${i}`;
    await page.locator('.bot-composer textarea').fill(text);
    await page.evaluate(text => {
      let started = null;
      const states = [];
      globalThis.rcReceiptMeasurement = new Promise((resolve, reject) => {
        let timer;
        const onKey = event => { if (event.key === 'Enter' && !event.shiftKey) started = performance.now(); };
        const cleanup = () => { observer.disconnect(); window.removeEventListener('keydown', onKey, true); clearTimeout(timer); };
        const observer = new MutationObserver(() => {
          const row = [...document.querySelectorAll('.bot-user')].find(row => row.querySelector('.bot-user-text')?.textContent === text);
          const marks = row?.querySelector('.bot-user-marks')?.textContent || '';
          if (marks && states.at(-1) !== marks) states.push(marks);
          if (started !== null && marks.includes('已收到')) { const elapsed = performance.now() - started; cleanup(); resolve({ elapsed, states }); }
        });
        window.addEventListener('keydown', onKey, true);
        observer.observe(document.querySelector('.bot-convo'), { subtree: true, childList: true, characterData: true });
        timer = setTimeout(() => { cleanup(); reject(Error('Visible received marker missing: ' + JSON.stringify(states))); }, 5000);
      });
    }, text);
    await page.locator('.bot-composer textarea').press('Enter');
    const sample = await page.evaluate(() => globalThis.rcReceiptMeasurement);
    report.receiptSamples.push(sample.elapsed);
    await page.locator('.bot-thread').getByText('RC scripted reply: ' + text, { exact: true }).waitFor();
  }
  report.metrics = { visibleReceived: metric('received', report.receiptSamples) };
  assert.equal(report.metrics.visibleReceived.pass, true, 'visible receipt p50 must stay below 300ms');
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_UI_RECEIPT_4', { exact: true }).waitFor();
  report.checks.push('five real UI sends, visible durable Received under budget, scripted replies');
  const quick = await until(() => app.windows().find(window => new URL(window.url()).searchParams.get('window') === 'quick-chat'), Boolean);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => new URL(window.webContents.getURL()).searchParams.get('window') === 'quick-chat');
    window.show(); window.webContents.send('quick-chat:shown');
  });
  await quick.getByLabel('选择机器人', { exact: true }).selectOption({ label: 'project-000' });
  await quick.getByLabel('快速会话内容', { exact: true }).fill('RC_QUICK_INPUT');
  await quick.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_QUICK_INPUT', { exact: true }).waitFor();
  const canonical = readFileSync(path.join(home, 'conversations', fixture.bots[0].conversationId + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const quickInputs = canonical.filter(row => row.kind === 'user_input' && row.content === 'RC_QUICK_INPUT');
  assert.equal(quickInputs.length, 1); assert.equal(quickInputs[0].surface, 'quick_chat');
  report.checks.push('real Quick Chat window lists bots and submits one canonical quick_chat input');
  await page.bringToFront();
  await page.locator('.bot-thread').evaluate(node => { node.scrollTop = 0; });
  await page.locator('#bot-msg-rc-message-9900').waitFor();
  await page.locator('.bot-thread[aria-busy="false"]').waitFor();
  for (const older of [9850, 9800, 9750, 9700]) {
    await page.locator('.bot-thread').evaluate(node => { node.scrollTop = node.scrollHeight; node.scrollTop = 0; });
    await page.locator(`#bot-msg-rc-message-${older + 30}`).waitFor();
    await page.locator('.bot-thread[aria-busy="false"]').waitFor();
  }
  await page.locator('.bot-thread').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_QUICK_INPUT', { exact: true }).waitFor();
  report.checks.push('scrolling up loads older messages from a 10000-message conversation');
  await page.locator('.bot-profile').click(); await page.locator('.bot-drawer-dock.is-open').waitFor();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'bot-profile.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  report.checks.push('profile opens and settings tab works');
  await page.locator('.bot-me-button').click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '界面', exact: true }).click();
  await page.getByRole('option', { name: '经典界面', exact: true }).click();
  await page.locator('.bot-shell').waitFor({ state: 'detached' });
  await page.locator('.settings-nav').getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.app-sidebar').waitFor();
  report.checks.push('classic shell opens through settings');
  // Return through the same settings control, retaining persisted conversations.
  await page.locator('.app-sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '界面', exact: true }).click();
  await page.getByRole('option', { name: '机器人列表', exact: true }).click();
  await page.locator('.settings-nav').getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.bot-shell').waitFor();
  assert.equal((await page.evaluate(() => window.peerAgent.projectAgentList())).items.length, fixture.scale.bots);
  report.checks.push('bot shell returns with all persisted identities');
  assert.deepEqual(report.pageErrors, []);
  assert.equal(logs.some(line => line.includes('ERR_PEER_DESKTOP_IPC_UNAUTHORIZED')), false, 'no window role may call a forbidden channel');
  report.ok = true;
} catch (error) {
  report.error = error.stack; process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
} finally {
  if (handle) report.ownedStop = await owned.stop({ handleId: handle, reason: 'owned' });
  report.finishedAt = new Date().toISOString();
  report.mainAuthorizationErrors = logs.filter(line => line.includes('ERR_PEER_DESKTOP_IPC_UNAUTHORIZED'));
  writeFileSync(path.join(root, 'main.log'), logs.join(''));
  writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0) writeFileSync(process.argv[outputIndex + 1], JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }));
}
