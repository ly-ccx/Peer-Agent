import { checkBotShellAccessibility } from './bot-shell-accessibility-checks.mjs';
import { checkBotShellDiagnostics } from './bot-shell-diagnostics-checks.mjs';
import { checkBotShellUpdater } from './bot-shell-updater-checks.mjs';
import { checkBotShellReply } from './bot-shell-reply-checks.mjs';
import { checkBotChatDetails } from './bot-shell-chat-detail-checks.mjs';
import { checkResponseInteraction } from '../../../scripts/rc-response-interaction-smoke.mjs';
// RC-01: production main/preload/renderer, synthetic cognition at the executor seam.
// This proves shell/IPC/durable input behavior, never live-model latency or tool execution.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { prepareLabIsolation } from './lab-workspace-isolate.mjs';
import { createOwnedProcessRegistry } from './lab-process-identity.mjs';
import { seedBotShellHome } from './seed-bot-shell-home.mjs';
import { metric } from './perf-project-agent.mjs';
import { createLlmConfigStore } from '../electron/main/llm-config-store.mjs';

const source = fileURLToPath(new URL('../../..', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'peer-bot-shell-smoke-'));
const home = path.join(root, 'data'); mkdirSync(home);
const fixture = seedBotShellHome({ home });
if (process.argv.includes('--accessibility')) {
  const models = createLlmConfigStore({
    configFile: path.join(home, 'llm-providers.json'),
    credentialClient: { getSecret: () => null, deleteSecret() {}, setSecret() { throw Error('No fixture secrets allowed'); } },
    providerFetch: () => { throw Error('No fixture model network allowed'); },
  });
  for (const suffix of ['A', 'B']) models.addProvider({ provider: 'openai', model: `rc-bot-model-${suffix.toLowerCase()}`,
    modelLabel: `RC Bot model ${suffix}`, name: 'RC synthetic channel', baseUrl: 'http://127.0.0.1:1', metadataSource: 'custom' });
}
const fixtureConversation = path.join(home, 'conversations', fixture.bots[0].conversationId + '.jsonl');
const seededMessages = readFileSync(fixtureConversation, 'utf8').trim().split('\n').map(line => JSON.parse(line));
seededMessages.at(-1).replyTo = ['rc-message-9500'];
seededMessages[9500].content = '请帮我梳理项目现状，说明已经完成的功能、当前问题和下一步计划。';
seededMessages.at(-1).content = '回复交互验收：引用保留上下文，过程按需查看。\n\n- **理解项目**：阅读代码与文档。\n- **讨论方案**：比较方案与取舍。';
seededMessages.at(-1).meta = { surfacing: 'interrupt', memoryUsed: ['rc-memory-123'] };
writeFileSync(fixtureConversation, seededMessages.map(row => JSON.stringify(row)).join('\n') + '\n');
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
// Observe production pagination without changing its results or admitting a new IPC.
const applicationService = path.join(isolation.launch.desktopDir, 'electron/main/project-agent/project-agent-application-service.mjs');
const serviceText = readFileSync(applicationService, 'utf8');
const readSeam = 'const result = directory.readConversation(payload.workspaceId, payload);';
assert.equal(serviceText.split(readSeam).length, 2, 'exact conversation read seam required');
let observedService = serviceText.replace(readSeam, `const result = directory.readConversation(payload.workspaceId, payload);
  globalThis.rcBotShellRecord('reads',{  before: payload.before ?? null, nextCursor: result.nextCursor,
    count: result.messages?.length, firstId: result.messages?.[0]?.id, lastId: result.messages?.at(-1)?.id });`);
const timingSeams = [
  ['function list(payload = {}) {', 'function list(payload = {}) { const rcListStart = performance.now();'],
  ['return { ok: true, items: filtered.map(withAgentStatus) };', 'const result = { ok: true, items: filtered.map(withAgentStatus) }; globalThis.rcBotShellRecord(\'list\',{  count: result.items.length, durationMs: performance.now() - rcListStart }); return result;'],
  ['function search(payload = {}) {', 'function search(payload = {}) { const rcStart = performance.now(); let rcStampMs = 0, rcIndexMs = 0;'],
  ['let hits = [];', 'const rcProjectionMs = performance.now() - rcStart; let hits = [];'],
  ["const token = typeof corpusStamp === 'function' ? String(corpusStamp(snapshot?.catalog) ?? '') : null;", "const rcStampStart = performance.now(); const token = typeof corpusStamp === 'function' ? String(corpusStamp(snapshot?.catalog) ?? '') : null; rcStampMs = performance.now() - rcStampStart; const rcIndexStart = performance.now();"],
  ["hits = searchIndex.search(typeof payload?.query === 'string' ? payload.query : '');", "hits = searchIndex.search(typeof payload?.query === 'string' ? payload.query : ''); rcIndexMs = performance.now() - rcIndexStart;"],
  ['return { ok: true, items, hits };', 'globalThis.rcBotShellRecord(\'search\',{  projectionMs: rcProjectionMs, stampMs: rcStampMs, indexMs: rcIndexMs, totalMs: performance.now() - rcStart }); return { ok: true, items, hits };'],
];
for (const [before, after] of timingSeams) {
  assert.equal(observedService.split(before).length, 2, 'exact search observation seam required');
  observedService = observedService.replace(before, after);
}
if (process.argv.includes('--streaming')) {
  const submitSeam = 'async function submitInput(payload = {}) {';
  assert.equal(observedService.split(submitSeam).length, 2);
  observedService = observedService.replace(submitSeam, `${submitSeam}
    if (payload.text === 'RC_DETAIL_FAIL_ANSWER' && !globalThis.rcDetailFailedOnce) { globalThis.rcDetailFailedOnce = true; return {ok:false,code:'CONTROLLED_SUBMIT_FAILURE'}; }`);
}
writeFileSync(applicationService, observedService);
const observedFile = path.join(root, 'observations.json');
writeFileSync(observedFile, JSON.stringify({ reads: [], list: [], search: [], turns: [] }));
const entry = path.join(root, 'entry.mjs');
const streamCommand = path.join(root, 'stream-command.json');
writeFileSync(streamCommand, JSON.stringify({ scenario: '', phase: 0 }));
const diagnosticsFile = path.join(root, 'exported-diagnostics.json');
const updaterCommand = path.join(root, 'updater-command.json');
const updaterReceipt = path.join(root, 'updater-receipt.json');
writeFileSync(updaterCommand, JSON.stringify({ seq: 0 }));
writeFileSync(updaterReceipt, JSON.stringify({ seq: 0 }));
writeFileSync(entry, `import {app,dialog,BrowserWindow} from 'electron';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {startMainThreadProbe} from ${JSON.stringify(pathToFileURL(path.join(source, 'apps/desktop/scripts/lab-main-thread-probe.mjs')).href)};
import {resolveRoleRoute} from ${JSON.stringify(pathToFileURL(path.join(source, 'packages/runtime-node/dist/index.js')).href)};
startMainThreadProbe(process.env.PEER_RC_PROFILE_PREFIX);
app.setPath('userData',${JSON.stringify(path.join(root, 'chromium'))});
${process.argv.includes('--diagnostics') ? `dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(diagnosticsFile)}});` : ''}
const observations={reads:[],list:[],search:[],turns:[]};
globalThis.rcBotShellRecord=(key,value)=>{
  observations[key].push(value);
  const file=${JSON.stringify(observedFile)};
  writeFileSync(file+'.next',JSON.stringify(observations));renameSync(file+'.next',file);
};
globalThis.rcBotShellService={
  resolveGoalRole(input){return resolveRoleRoute({...input,providers:[{id:'rc-scripted',model:'scripted-fixture',enabled:true,apiKeyConfigured:true,supportsTools:true,supportsStructured:true,supportsVision:false,isDefault:true}]});},
  async sendMessage(input){
    globalThis.rcBotShellRecord('turns',{role:input.turnProfile?.role,workspaceId:input.turnProfile?.workspaceId});
    await new Promise(resolve=>setTimeout(resolve,120));
    const text=input.messages?.findLast(message=>message.role==='user')?.content || '';
    return {terminalStatus:'done',text:'RC scripted reply: '+text};
  },abort(){}
};
${process.argv.includes('--streaming') ? `const {createStreamingFixture}=await import(${JSON.stringify(pathToFileURL(path.join(source, 'scripts/rc-response-interaction-smoke.mjs')).href)});
globalThis.rcBotShellService=createStreamingFixture({commandFile:${JSON.stringify(streamCommand)},record:globalThis.rcBotShellRecord,resolveGoalRole:globalThis.rcBotShellService.resolveGoalRole});` : ''}
// Keep synthetic updater delivery outside inspector Promise lifetime. Only this
// isolated entry consumes the disposable command file; product IPC is unchanged.
let updaterSequence=0;
const updaterTimer=setInterval(()=>{
  const command=JSON.parse(readFileSync(${JSON.stringify(updaterCommand)},'utf8'));
  if(command.seq<=updaterSequence)return;
  let receipt;
  try {
    const windows=BrowserWindow.getAllWindows();
    if(!windows.length)return;
    for(const window of windows)window.webContents.send('updater:event',command.event);
    receipt={seq:command.seq,ok:true,windows:windows.length};
  }catch(error){receipt={seq:command.seq,ok:false,error:error.message};}
  updaterSequence=command.seq;
  const file=${JSON.stringify(updaterReceipt)};
  writeFileSync(file+'.next',JSON.stringify(receipt));renameSync(file+'.next',file);
},25);updaterTimer.unref();
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
let app, handle, page, tracing = false; const logs = [];
const interaction = async phase => {
  report.interactionBefore = await page.evaluate(phase => ({ phase, frames: globalThis.rcShellFrameCount, at: Date.now(), hidden: document.hidden, focused: document.hasFocus() }), phase);
};
// Test-only facts are captured after each timing sample and atomically published.
// Reading them never replays a product action or relies on inspector Promise lifetime.
const readObserved = key => JSON.parse(readFileSync(observedFile, 'utf8'))[key];
const tracePaging = async (phase) => {
  (report.paging ??= []).push({ phase, reads: readObserved('reads').slice(-20),
    view: await page.locator('.bot-thread').evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight,
      viewport: node.clientHeight, busy: node.getAttribute('aria-busy'), ids: [...node.querySelectorAll('[id^="bot-msg-"]')].map(row => row.id) })) });
};
const until = async (read, predicate, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Shell acceptance timed out');
};
let updaterSequence = 0;
const emitUpdaterEvent = async event => {
  const seq = ++updaterSequence;
  writeFileSync(updaterCommand + '.next', JSON.stringify({ seq, event }));
  renameSync(updaterCommand + '.next', updaterCommand);
  const receipt = await until(() => JSON.parse(readFileSync(updaterReceipt, 'utf8')), value => value.seq === seq, 5000);
  assert.equal(receipt.ok, true, receipt.error || 'isolated main must acknowledge synthetic event delivery');
  (report.updaterReceipts ??= []).push({ ...receipt, type: event.type });
};
try {
  app = await _electron.launch({ args: [entry], env, cwd: isolation.launch.desktopDir, timeout: 30000 });
  handle = owned.register({ process: app.process(), close: () => app.close() });
  await app.context().tracing.start({ screenshots: true, snapshots: true }); tracing = true;
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', data => logs.push(String(data)));
  page = await until(() => app.windows().find(window => window.url().includes('/dist/index.html') && !window.url().includes('window=')), Boolean, 120000);
  report.windowReadyMs = Date.now() - Date.parse(report.startedAt);
  page.setDefaultTimeout(15000); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.locator('.bot-shell').waitFor();
  await page.bringToFront();
  report.initialWindowState = await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus() }));
  await page.evaluate(() => { globalThis.rcShellFrameCount = 0; const tick = () => { globalThis.rcShellFrameCount++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  await until(() => page.locator('.bot-row').count(), count => count === fixture.scale.bots);
  await checkBotShellUpdater({ page, emitUpdaterEvent, until, report, home, captureDirectory: root });
  assert.equal(readObserved('turns').length, 0, 'idle bots must not open model turns');
  report.avatarAnimation = await page.evaluate(() => ({ avatars: document.querySelectorAll('.bot-avatar').length, activeAvatars: document.querySelectorAll('[data-avatar-animated="true"]').length, animations: document.getAnimations().length }));
  report.checks.push('200 real bot rows; no idle model turns');
  report.listInitialMs = readObserved('list').find(sample => sample.count === fixture.scale.bots)?.durationMs;
  const listSamples = [];
  for (let i = 0; i < 5; i++) {
    assert.equal((await page.evaluate(() => window.peerAgent.projectAgentList())).items.length, fixture.scale.bots);
    listSamples.push(readObserved('list').at(-1).durationMs);
  }
  report.metrics = { productionList: metric('list', listSamples) };
  assert.equal(report.metrics.productionList.pass, true, 'real desktop list projection p50 must stay below 100ms');
  report.searchSamples = [];
  for (let i = 0; i < 5; i++) {
    await interaction(`search-clear-${i}`);
    await page.locator('.bot-search').fill('');
    await until(() => page.locator('.bot-row').count(), count => count === fixture.scale.bots);
    await page.evaluate(() => {
      globalThis.rcSearchMeasurement = new Promise((resolve, reject) => {
        let started = null;
        const input = document.querySelector('.bot-search');
        const onInput = () => { started = performance.now(); };
        const cleanup = () => { input.removeEventListener('input', onInput); observer.disconnect(); clearTimeout(timer); };
        const observer = new MutationObserver(() => {
          const rows = document.querySelectorAll('.bot-row');
          if (started !== null && rows.length === 1 && rows[0].querySelector('.bot-row-name')?.textContent === 'project-000') {
            const elapsed = performance.now() - started; cleanup(); resolve(elapsed);
          }
        });
        input.addEventListener('input', onInput);
        observer.observe(document.querySelector('.bot-list'), { subtree: true, childList: true, characterData: true });
        const timer = setTimeout(() => { cleanup(); reject(Error('Visible full-corpus search result missing')); }, 5000);
      });
    });
    await interaction(`search-query-${i}`);
    await page.locator('.bot-search').fill('unique-needle');
    report.searchSamples.push(await page.evaluate(() => globalThis.rcSearchMeasurement));
  }
  report.metrics.visibleSearch = metric('search', report.searchSamples);
  report.searchTimings = readObserved('search');
  assert.equal(report.metrics.visibleSearch.pass, true, 'input to visible full-corpus result p50 must stay below 150ms');
  await page.locator('.bot-search').fill('');
  await until(() => page.locator('.bot-row').count(), count => count === fixture.scale.bots);
  report.checks.push('five input-to-visible searches across the real message corpus under budget');
  await interaction('open-bot');
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
    (report.inputWindowStates ??= []).push(await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus(), composer: document.querySelectorAll('.bot-composer textarea').length })));
    await interaction(`send-${i}`);
    await page.locator('.bot-composer textarea').press('Enter');
    const sample = await page.evaluate(() => globalThis.rcReceiptMeasurement);
    report.receiptSamples.push(sample.elapsed);
    await page.locator('.bot-thread').getByText('RC scripted reply: ' + text, { exact: true }).waitFor();
  }
  report.metrics.visibleReceived = metric('received', report.receiptSamples);
  assert.equal(report.metrics.visibleReceived.pass, true, 'visible receipt p50 must stay below 300ms');
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_UI_RECEIPT_4', { exact: true }).waitFor();
  report.checks.push('five real UI sends, visible durable Received under budget, scripted replies');
  const quick = await until(() => app.windows().find(window => new URL(window.url()).searchParams.get('window') === 'quick-chat'), Boolean);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => new URL(window.webContents.getURL()).searchParams.get('window') === 'quick-chat');
    window.show(); window.webContents.send('quick-chat:shown');
  });
  await quick.getByRole('button', { name: '选择机器人', exact: true }).click();
  await quick.getByRole('option', { name: 'project-000', exact: true }).click();
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
  await tracePaging('initial older page');
  for (const older of [9850, 9800, 9750, 9700]) {
    await page.locator('.bot-thread').hover();
    await page.mouse.wheel(0, -30000);
    await tracePaging(`request ${older + 30}`);
    await page.locator(`#bot-msg-rc-message-${older + 30}`).waitFor();
    await page.locator('.bot-thread[aria-busy="false"]').waitFor();
  }
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_QUICK_INPUT', { exact: true }).waitFor();
  report.checks.push('scrolling up loads older messages from a 10000-message conversation');
  await page.locator('#bot-msg-rc-message-9999 .bot-reply-bar').click();
  await page.locator('#bot-msg-rc-message-9500.is-anchored').waitFor();
  await until(() => page.locator('#bot-msg-rc-message-9500').evaluate(node => {
    const row = node.getBoundingClientRect(), thread = node.closest('.bot-thread').getBoundingClientRect();
    return row.top >= thread.top && row.bottom <= thread.bottom;
  }), Boolean);
  await tracePaging('quoted old message located inside viewport');
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_QUICK_INPUT', { exact: true }).waitFor();
  report.checks.push('a quoted older message loads across pages, enters viewport, then returns to latest');
  await checkBotShellReply({ page, until, report, captureDirectory: root });
  if (process.argv.includes('--streaming')) {
    await checkResponseInteraction({ page, until, report, captureDirectory: root, commandFile: streamCommand });
    await checkBotChatDetails({ page, until, report, captureDirectory: root, conversationFile: fixtureConversation });
  }
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
  assert.equal(await page.locator('.app-sidebar .sidebar-version-badge').count(), 1);
  assert.equal(await page.locator('.app-sidebar .sidebar-version-channel').count(), 0);
  assert.equal((await page.evaluate(() => window.peerAgent.updaterGetStatus())).preference, 'auto');
  report.checks.push('classic shell opens through settings');
  // Return through the same settings control, retaining persisted conversations.
  await page.locator('.app-sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '界面', exact: true }).click();
  await page.getByRole('option', { name: '机器人列表', exact: true }).click();
  await page.locator('.settings-nav').getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.bot-shell').waitFor();
  assert.equal((await page.evaluate(() => window.peerAgent.projectAgentList())).items.length, fixture.scale.bots);
  report.checks.push('bot shell returns with all persisted identities');
  if (process.argv.includes('--accessibility')) await checkBotShellAccessibility({ page, app, until, report, captureDirectory: root });
  if (process.argv.includes('--diagnostics')) await checkBotShellDiagnostics({ page, report, exportFile: diagnosticsFile, fixture });
  assert.deepEqual(report.pageErrors, []);
  assert.equal(logs.some(line => line.includes('ERR_PEER_DESKTOP_IPC_UNAUTHORIZED')), false, 'no window role may call a forbidden channel');
  report.ok = true;
} catch (error) {
  report.error = error.stack; process.exitCode = 1;
  if (page) report.interactionAfter = await page.evaluate(() => ({ frames: globalThis.rcShellFrameCount, at: Date.now(), hidden: document.hidden, focused: document.hasFocus(), search: [...document.querySelectorAll('.bot-search')].map(node => ({ value: node.value, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, visibility: getComputedStyle(node).visibility, display: getComputedStyle(node).display })), composers: document.querySelectorAll('.bot-composer textarea').length })).catch(() => null);
  if (page && app) await tracePaging('failure').catch(() => {});
  if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  const failureOutput = process.argv.indexOf('--output');
  if (page && failureOutput >= 0) await page.screenshot({ path: path.join(path.dirname(process.argv[failureOutput + 1]), 'bot-shell-failure.png') }).catch(() => {});
} finally {
  if (tracing) {
    const output = process.argv.indexOf('--output');
    await app.context().tracing.stop({ path: path.join(output >= 0 ? path.dirname(process.argv[output + 1]) : root, 'bot-shell-trace.zip') }).catch(() => {});
  }
  if (handle) report.ownedStop = await owned.stop({ handleId: handle, reason: 'owned' });
  report.finishedAt = new Date().toISOString();
  report.mainAuthorizationErrors = logs.filter(line => line.includes('ERR_PEER_DESKTOP_IPC_UNAUTHORIZED'));
  writeFileSync(path.join(root, 'main.log'), logs.join(''));
  writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0) writeFileSync(process.argv[outputIndex + 1], JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }));
}
