import assert from 'node:assert/strict';
import { sourceFingerprint, sha256 } from './input-prediction-evidence.mjs';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright-core';
import { createConversationStore } from '@peer-agent/conversation-store';
import { prepareLabIsolation } from './lab-workspace-isolate.mjs';
import { createOwnedProcessRegistry } from './lab-process-identity.mjs';
import { seedBotShellHome } from './seed-bot-shell-home.mjs';
import { createLlmConfigStore } from '../electron/main/llm-config-store.mjs';

const source = fileURLToPath(new URL('../../..', import.meta.url));
const argument = process.argv.indexOf('--output');
const root = argument >= 0 ? path.resolve(process.argv[argument + 1]) : mkdtempSync(path.join(os.tmpdir(), 'peer-input-prediction-'));
mkdirSync(root, { recursive: true });
const home = path.join(root, 'data'); mkdirSync(home, { recursive: true });
const fixture = seedBotShellHome({ home, scale: { bots: 2, messages: 2, memories: 0, inboxEvents: 0 } });
const conversations = createConversationStore({ storeDir: path.join(home, 'conversations') });
const bot = fixture.bots[0], other = fixture.bots[1];
conversations.replaceMessages(bot.conversationId, [
  { id: 'prediction-user', role: 'user', kind: 'user_input', content: '帮我修改这篇文章，先不发布。', createdAt: new Date().toISOString() },
  { id: 'prediction-reply', role: 'assistant', kind: 'agent_reply', content: '文章已修改，第三段衔接和技术说明已保留。', createdAt: new Date().toISOString() },
]);
conversations.replaceMessages(other.conversationId, [
  { id: 'other-user', role: 'user', kind: 'user_input', content: '核对另一份文档。', createdAt: new Date().toISOString() },
  { id: 'other-reply', role: 'assistant', kind: 'agent_reply', content: '另一份文档已核对。', createdAt: new Date().toISOString() },
]);
const classic = conversations.createConversation({ title: '输入建议验收', workspacePath: bot.path });
conversations.appendMessage(classic.id, { id: 'classic-user', role: 'user', content: '修改文章，先不发布。' });
conversations.appendMessage(classic.id, { id: 'classic-reply', role: 'assistant', content: '文章已修改，技术说明已保留。' });

const serverState = { delay: 0, fail: false, none: false, insertion: null, calls: [] };
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  let data; try { data = JSON.parse(body.messages?.at(-1)?.content || '{}'); } catch { data = {}; }
  serverState.calls.push({ at: Date.now(), mode: data.mode, draft: data.draft, body });
  const fail = serverState.fail, none = serverState.none;
  await new Promise(resolve => setTimeout(resolve, serverState.delay));
  if (response.destroyed) return;
  if (fail) { response.writeHead(503); response.end('CONTROLLED_PRIVATE_ECHO'); return; }
  const result = none ? { kind: 'none' } : data.mode === 'continuation'
    ? { kind: 'continuation', suffix: serverState.insertion ?? '检查一下过渡。' } : { kind: 'next_turn', text: serverState.insertion ?? '请再检查一下过渡。' };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 60, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const secrets = new Map();
const models = createLlmConfigStore({ configFile: path.join(home, 'llm-providers.json'),
  credentialClient: { getSecret: key => secrets.get(key) ?? null, setSecret: (key, value) => secrets.set(key, value), deleteSecret: key => secrets.delete(key) },
  providerFetch: () => { throw Error('No model discovery network in this fixture'); } });
models.addProvider({ provider: 'openai-compatible', name: '输入建议验收模型', model: 'prediction-fixture', modelLabel: 'Prediction fixture',
  apiKey: 'isolated-fixture-only', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  metadataSource: 'custom', supportsReasoning: false, supportsTools: true, contextWindow: 8192, inputPrice: 1, outputPrice: 1 });
const provider = models.listProviders()[0];
const settings = JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8'));
settings.memory = { enabled: false };
settings.inputPrediction = { schemaVersion: 1, enabled: true, continuationEnabled: true, disabledWorkspaceIds: [], dailyRequestLimit: 100, dailyTokenLimit: 100000 };
settings.modelRouting = { roles: { input_predictor: { mode: 'fixed', modelProviderId: provider.id } } };
writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
const isolation = prepareLabIsolation({ sourceRoot: source, labHome: home });
cpSync(path.join(source, 'apps/desktop/dist'), isolation.launch.distDir, { recursive: true });
const main = path.join(isolation.launch.desktopDir, 'electron/main/main.mjs');
let mainSource = readFileSync(main, 'utf8');
for (const [needle, replacement] of [
  ['const llmConfigStore = createLlmConfigStore();', 'const llmConfigStore = createLlmConfigStore({credentialClient:globalThis.predictionFixtureCredentials});llmConfigStore.resolveCredentialAsync=async()=>({apiKey:globalThis.predictionFixtureApiKey});'],
  ['const agentTurnExecutor = createAgentTurnExecutor({ llmChatService });',
    'const agentTurnExecutor = createAgentTurnExecutor({llmChatService:{...globalThis.predictionFixtureAgent,readDelegationCapabilities:input=>llmChatService.readDelegationCapabilities(input)}});'],
]) { assert.equal(mainSource.split(needle).length, 2, `unique fixture seam: ${needle}`); mainSource = mainSource.replace(needle, replacement); }
mainSource = mainSource.replace('...createInputPredictionIpcRegistrations({ prediction: inputPrediction }),',
  `...createInputPredictionIpcRegistrations({prediction:{...inputPrediction,request:async(...args)=>{const value=await inputPrediction.request(...args);console.log('[prediction-result]',args[0]?.surface,value.kind,value.reason??value.code??'');return value;}}}),`);
writeFileSync(main, mainSource);
const entry = path.join(root, 'entry.mjs');
writeFileSync(entry, `import {app} from 'electron';
const secrets=new Map(${JSON.stringify([...secrets])});
globalThis.predictionFixtureApiKey='isolated-fixture-only';
globalThis.predictionFixtureCredentials={getSecret:key=>secrets.get(key)??null,setSecret:(key,value)=>secrets.set(key,value),deleteSecret:key=>secrets.delete(key)};
globalThis.predictionFixtureAgent={resolveGoalRole(){return {ok:true,selection:{modelProviderId:${JSON.stringify(provider.id)},modelId:'prediction-fixture',providerId:${JSON.stringify(provider.id)}}};},async sendMessage(){return {terminalStatus:'done',text:'受控执行器收到输入。'};},abort(){}};
app.setPath('userData',${JSON.stringify(path.join(root, 'chromium'))});
app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(main).href)})).catch(error=>{console.error(error);app.exit(1)});
`);
const owned = createOwnedProcessRegistry();
const report = { schemaVersion: 1, startedAt: new Date().toISOString(),
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  sourceFingerprint: sourceFingerprint(source), independent: false, scope: 'Production Electron main/preload/renderer, prediction Provider HTTP, Context, budget and draft storage. Controlled HTTP cognition and in-memory fixture credentials; no installed-build or OS IME certification.',
  cases: [], screenshots: [], pageErrors: [], passed: false };
const logs = [];
let app, handle, page;
const until = async (read, predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error(`Timed out: ${String(read).slice(0, 180)}`);
};
async function check(name, run) { if (process.argv.includes('--submission-only') && name !== 'accepted draft is submitted exactly once through the original Bot input chain' || process.argv.includes('--acceptance-only') && name !== 'pointer and accessible keyboard acceptance only edit the draft and preserve focus') return; console.log(`START ${name}`); await run(); report.cases.push({ name, passed: true }); console.log(`PASS ${name}`); }
async function capture(name) { const file = path.join(root, `${name}.png`); await page.screenshot({ path: file }); report.screenshots.push({ name, file, sha256: sha256(readFileSync(file)) }); }
async function settleRate() { await new Promise(resolve => setTimeout(resolve, 5200)); }
async function suggestion() { await page.locator('.input-prediction-accept').waitFor({ state: 'visible', timeout: 12000 }); }
async function newDraft(text) {
  const field = page.locator('.bot-composer textarea');
  await settleRate(); await field.fill(text); await field.focus(); return field;
}
try {
  const env = { ...process.env, PEER_AGENT_HOME: home, PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1',
    PEER_AGENT_DISABLE_LOCAL_SKILL: '1', PEER_AGENT_PROVIDER_TRACE: '1', PEER_WORKSPACE_ROOT: bot.path };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: [entry], env, cwd: isolation.launch.desktopDir, timeout: 30000 });
  handle = owned.register({ process: app.process(), close: () => app.close() });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', data => logs.push(String(data)));
  page = await until(() => app.windows().find(window => window.url().includes('/dist/index.html') && !window.url().includes('window=')), Boolean, 60000);
  page.on('pageerror', error => report.pageErrors.push(error.message)); page.setDefaultTimeout(15000);
  await page.locator('.bot-shell').waitFor({ timeout: 60000 }); await page.bringToFront();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('.bot-row').filter({ hasText: 'project-000' }).first().click();
  const field = page.locator('.bot-composer textarea'); await field.waitFor(); await field.focus();
  if (!process.argv.includes('--classic-only')) {
  await check('next-turn ghost is separate from real draft and cannot be sent with empty Enter', async () => {
    await suggestion(); assert.equal(await field.inputValue(), '');
    const count = await page.locator('.bot-thread [id^="bot-msg-"]').count();
    await capture('bot-next-turn-dark'); await field.press('Enter');
    assert.equal(await field.inputValue(), ''); assert.equal(await page.locator('.bot-thread [id^="bot-msg-"]').count(), count);
  });
  await check('Tab accepts exactly once and subsequent Tab can navigate away', async () => {
    await settleRate(); await field.blur(); await field.focus(); await suggestion();
    await field.press('Tab'); await until(() => field.inputValue(), value => value === '请再检查一下过渡。');
    await field.press('Tab'); assert.equal(await field.evaluate(node => document.activeElement === node), false);
    await capture('bot-accepted-draft');
  });
  await check('acceptance and following manual edits undo in their real editor order', async () => {
    await field.focus(); await field.press('End'); await page.keyboard.insertText('谢谢');
    await field.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    assert.equal(await field.inputValue(), '请再检查一下过渡。');
    await field.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); assert.equal(await field.inputValue(), '');
    await field.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
    assert.equal(await field.inputValue(), '请再检查一下过渡。');
  });
  await check('continuation uses Right Arrow only at the end and leaves prefix intact', async () => {
    await newDraft('请再'); await suggestion(); await capture('bot-continuation-dark');
    await field.press('ArrowRight'); await until(() => field.inputValue(), value => value === '请再检查一下过渡。');
    await field.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); assert.equal(await field.inputValue(), '请再');
  });
  await check('selected text, mid-line caret and composition keep native keyboard behavior', async () => {
    await newDraft('请仔细'); await suggestion();
    await field.evaluate(node => { node.setSelectionRange(0, 1); node.dispatchEvent(new Event('select', { bubbles: true })); });
    await until(() => page.locator('.input-prediction-accept').count(), value => value === 0);
    await field.press('ArrowRight'); assert.equal(await field.inputValue(), '请仔细');
    await field.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' })));
    const count = await page.locator('.bot-thread [id^="bot-msg-"]').count();
    await field.press('Enter'); assert.equal((await field.inputValue()).replaceAll('\n', ''), '请仔细');
    assert.equal(await page.locator('.bot-thread [id^="bot-msg-"]').count(), count);
    await capture('bot-composition-preserved');
    await field.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
    const client = await page.context().newCDPSession(page);
    await client.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await field.press('ArrowRight');
    assert.equal(await page.locator('.input-prediction-accept').count(), 0);
    await client.send('Input.insertText', { text: '中文' }); await client.detach();
    assert.ok((await field.inputValue()).includes('中文'));

  });
  await check('late HTTP response cannot override newer typing', async () => {
    serverState.delay = 1000; await newDraft('旧草稿');
    const previous = serverState.calls.length; await until(() => serverState.calls.length, count => count > previous);
    await field.fill('用户已经改变表达'); await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(await field.inputValue(), '用户已经改变表达'); serverState.delay = 0;
  });
  await check('Escape dismisses without changing the draft; Shift Tab retains focus navigation', async () => {
    await newDraft('再看看'); await suggestion(); await field.press('Escape');
    assert.equal(await field.inputValue(), '再看看');
    await field.blur(); await field.focus(); await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(await page.locator('.input-prediction-accept').count(), 0);
    await newDraft('请核对'); await suggestion(); await field.press('Shift+Tab');
    assert.equal(await field.inputValue(), '请核对');
    assert.equal(await field.evaluate(node => document.activeElement === node), false);
  });
  await check('pointer and accessible keyboard acceptance only edit the draft and preserve focus', async () => {
    await newDraft('重新'); await suggestion();
    await page.getByRole('button', { name: '采纳建议: 检查一下过渡。', exact: true }).click();
    await until(() => field.inputValue(), value => value === '重新检查一下过渡。');
    assert.equal(await page.locator('.input-prediction-accept').count(), 0);
    await newDraft('键盘操作'); await suggestion();
    const accessible = page.getByRole('button', { name: '采纳建议: 检查一下过渡。', exact: true });
    await accessible.focus(); await accessible.press('Enter');
    await until(() => field.inputValue(), value => value === '键盘操作检查一下过渡。');
    assert.equal(await field.evaluate(node => document.activeElement === node), true, 'keyboard activation restores the same input focus');
  });
  await check('an unsent attachment suspends prediction and keeps the real draft', async () => {
    await settleRate(); await field.fill('带附件的真实草稿');
    await page.locator('.bot-composer input[type="file"]').setInputFiles({ name: 'prediction-context.txt', mimeType: 'text/plain', buffer: Buffer.from('DO_NOT_SEND_PREDICTION_ATTACHMENT') });
    await page.getByRole('button', { name: '移除附件 prediction-context.txt', exact: true }).waitFor();
    const calls = serverState.calls.length; await field.focus(); await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(serverState.calls.length, calls); assert.equal(await field.inputValue(), '带附件的真实草稿');
    await page.getByRole('button', { name: '移除附件 prediction-context.txt', exact: true }).click();
  });
  await check('switching Bots cancels an old pending response without transferring its draft', async () => {
    serverState.delay = 1200; const previous = serverState.calls.length;
    await newDraft('仅属于第一个项目'); await until(() => serverState.calls.length, count => count > previous);
    await page.locator('.bot-row').filter({ hasText: 'project-001' }).first().click();
    await page.locator('.bot-composer textarea').focus(); await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(await page.locator('.bot-composer textarea').inputValue(), '');
    serverState.delay = 0;
    await page.locator('.bot-row').filter({ hasText: 'project-000' }).first().click();
    assert.equal(await page.locator('.bot-composer textarea').inputValue(), '仅属于第一个项目');
  });
  await check('provider error is truthful and ordinary editing recovers on a subsequent request', async () => {
    serverState.fail = true; await newDraft('失败后仍可编辑');
    await until(() => page.evaluate(() => window.peerAgent.inputPredictionStatus()), value => value.reason === 'provider_error');
    assert.equal(await field.inputValue(), '失败后仍可编辑'); assert.equal(await page.locator('.input-prediction-accept').count(), 0);
    serverState.fail = false; await newDraft('恢复后的草稿'); await suggestion();
    assert.equal((await page.evaluate(() => window.peerAgent.inputPredictionStatus())).reason, 'ready');
  });
  await check('daily quota rejects before HTTP and survives an unrelated settings save', async () => {
    await page.evaluate(() => window.peerAgent.updateSettings({ inputPrediction: { schemaVersion: 1, enabled: true, continuationEnabled: true,
      disabledWorkspaceIds: [], dailyRequestLimit: 0, dailyTokenLimit: 100000 } }));
    await newDraft('预算限制'); const calls = serverState.calls.length;
    await new Promise(resolve => setTimeout(resolve, 900)); assert.equal(serverState.calls.length, calls);
    assert.equal((await page.evaluate(() => window.peerAgent.inputPredictionStatus())).reason, 'budget');
    await page.evaluate(() => window.peerAgent.updateSettings({ inputPrediction: { schemaVersion: 1, enabled: true, continuationEnabled: true,
      disabledWorkspaceIds: [], dailyRequestLimit: 100, dailyTokenLimit: 100000 } }));
  });
  await check('feature settings disclose draft sharing beside the shared model picker and use one switch', async () => {
    await page.locator('.bot-app-menu-button').click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('heading', { name: '智能输入建议', exact: true }).waitFor();
    await page.getByRole('heading', { name: '智能输入建议', exact: true }).scrollIntoViewIfNeeded();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    const section = page.locator('.input-prediction-settings');
    await section.scrollIntoViewIfNeeded();
    await until(() => section.getByRole('switch').isEnabled(), Boolean);
    await until(() => section.locator('.model-selection-trigger-label').innerText(), text => text.includes('Prediction fixture'));
    await capture('settings-input-prediction-light');
    assert.equal(await section.getByRole('switch').count(), 1);
    const enabled = section.getByRole('switch', { name: '开启智能输入建议', exact: true });
    await enabled.click();
    await until(() => page.evaluate(() => window.peerAgent.getSettings()), value => value.inputPrediction.enabled === false);
    await enabled.click();
    await until(() => page.evaluate(() => window.peerAgent.getSettings()), value => value.inputPrediction.enabled === true && value.inputPrediction.continuationEnabled === true);
    const picker = section.getByRole('button', { name: /^输入建议模型:/ });
    const disclosure = await picker.getAttribute('aria-describedby');
    assert.match(await page.locator(`[id="${disclosure}"]`).innerText(), /当前对话和未发送的草稿/);
    await page.evaluate(() => window.peerAgent.updateSettings({ inputPrediction: { schemaVersion: 1, enabled: true, continuationEnabled: false,
      disabledWorkspaceIds: [], dailyRequestLimit: 100, dailyTokenLimit: 100000 } }));
    await page.locator('.settings-nav-header').getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.bot-app-menu-button').click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('heading', { name: '智能输入建议', exact: true }).scrollIntoViewIfNeeded();
    await picker.click();
    await page.locator('.model-selection-model').filter({ has: page.getByText('Prediction fixture', { exact: true }) }).click();
    await until(() => page.evaluate(() => window.peerAgent.getSettings()), value => value.inputPrediction.continuationEnabled === true);
  });
  await check('unsent-draft sharing and the global switch stop requests immediately', async () => {
    // An existing explicit refusal stays effective without a removed UI switch.
    await page.evaluate(() => window.peerAgent.updateSettings({ inputPrediction: { schemaVersion: 1, enabled: true, continuationEnabled: false,
      disabledWorkspaceIds: [], dailyRequestLimit: 100, dailyTokenLimit: 100000 } }));
    await page.locator('.settings-nav-header').getByRole('button', { name: '设置', exact: true }).click();
    await newDraft('这份草稿不上传'); const calls = serverState.calls.length;
    await new Promise(resolve => setTimeout(resolve, 900)); assert.equal(serverState.calls.length, calls);
    await page.evaluate(() => window.peerAgent.updateSettings({ inputPrediction: { schemaVersion: 1, enabled: false, continuationEnabled: true,
      disabledWorkspaceIds: [], dailyRequestLimit: 100, dailyTokenLimit: 100000 } }));
    await newDraft(''); const disabledCalls = serverState.calls.length;
    await new Promise(resolve => setTimeout(resolve, 900)); assert.equal(serverState.calls.length, disabledCalls);
    await page.evaluate(() => window.peerAgent.updateSettings({ inputPrediction: { schemaVersion: 1, enabled: true, continuationEnabled: true,
      disabledWorkspaceIds: [], dailyRequestLimit: 100, dailyTokenLimit: 100000 } }));
  });
  }
  await check('classic shell uses the same empty draft, Enter, Tab and undo contract', async () => {
    await page.locator('.bot-app-menu-button').click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '界面', exact: true }).click();
    await page.getByRole('option', { name: '经典界面', exact: true }).click();
    await page.locator('.bot-shell').waitFor({ state: 'detached' });
    await page.locator('.settings-nav').getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.sidebar-workspace-node.is-collapsed').filter({ hasText: 'project-000' }).locator('.sidebar-workspace-row').click();
    await page.locator('.app-sidebar').getByText('输入建议验收', { exact: true }).click();
    const editor = page.locator('.chat-composer textarea'); await editor.waitFor();
    await settleRate(); await editor.focus(); await suggestion();
    assert.equal(await editor.inputValue(), ''); await editor.press('Enter'); assert.equal(await editor.inputValue(), '');
    await settleRate(); await editor.blur(); await editor.focus(); await suggestion();
    await capture('classic-next-turn-light'); await editor.press('Tab');
    await until(() => editor.inputValue(), value => value === '请再检查一下过渡。');
    await editor.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); assert.equal(await editor.inputValue(), '');
  });
  await check('classic continuation preserves slash and mention priority and uses the ordinary draft', async () => {
    const editor = page.locator('.chat-composer textarea');
    await settleRate(); await editor.fill('/'); await editor.focus();
    await page.locator('.slash-command-menu').waitFor(); const calls = serverState.calls.length;
    await new Promise(resolve => setTimeout(resolve, 800)); assert.equal(serverState.calls.length, calls);
    await editor.press('Tab'); assert.equal(await editor.inputValue(), '/compact');
    await settleRate(); await editor.fill('请继续'); await editor.focus(); await suggestion();
    await editor.press('ArrowRight'); await until(() => editor.inputValue(), value => value === '请继续检查一下过渡。');
    await capture('classic-accepted-light');
  });
  await check('reduced motion and large text retain a fully visible actionable suggestion', async () => {
    const editor = page.locator('.chat-composer textarea');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1040, height: 860 });
    await page.addStyleTag({ content: '.chat-composer textarea {font-size:28px !important;line-height:1.5 !important;}' });
    await settleRate(); await editor.fill('再'); await editor.focus(); await suggestion();
    const box = await page.locator('.input-prediction-accept').boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 1040);
    await capture('classic-large-text-reduced-motion');
    const client = await page.context().newCDPSession(page);
    await client.send('Accessibility.enable');
    const tree = await client.send('Accessibility.getFullAXTree');
    const name = tree.nodes.find(node => node.role?.value === 'button' && node.name?.value === '采纳建议: 检查一下过渡。');
    assert.ok(name && !name.ignored, 'acceptance button is available in Chromium accessibility tree');
    await client.detach();
    await editor.press('ArrowRight'); await until(() => editor.inputValue(), value => value === '再检查一下过渡。');
  });
  await check('unaccepted suggestions stay outside persistent drafts and provider traces', async () => {
    serverState.insertion = '尚未采纳的唯一建议文本';
    const editor = page.locator('.chat-composer textarea'); await settleRate(); await editor.fill('持久草稿'); await editor.focus(); await suggestion();
    await new Promise(resolve => setTimeout(resolve, 600));
    function files(directory) { return readdirSync(directory, { withFileTypes: true }).flatMap(row => row.isDirectory() ? files(path.join(directory, row.name)) : row.isFile() ? [path.join(directory, row.name)] : []); }
    for (const file of files(home).filter(file => !file.includes('/isolated-workspace/'))) {
      assert.equal(readFileSync(file).includes(Buffer.from(serverState.insertion)), false, `unaccepted candidate leaked: ${path.relative(home, file)}`);
    }
    assert.equal(existsSync(path.join(home, 'provider-traces')), false);
    assert.equal(logs.join('').includes('CONTROLLED_PRIVATE_ECHO'), false);
    await editor.press('Escape'); assert.equal(await editor.inputValue(), '持久草稿');
    serverState.insertion = null;
  });
  await check('accepted draft is submitted exactly once through the original Bot input chain', async () => {
    if (await page.locator('.app-sidebar').isVisible()) {
      await page.locator('.app-sidebar').getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '界面', exact: true }).click();
      await page.getByRole('option', { name: '机器人列表', exact: true }).click();
      await page.locator('.settings-nav').getByRole('button', { name: '设置', exact: true }).click();
      await page.locator('.bot-row').filter({ hasText: 'project-000' }).first().click();
    }
    const editor = await newDraft('提交前缀'); await suggestion(); await editor.press('Tab');
    await until(() => editor.inputValue(), value => value === '提交前缀检查一下过渡。');
    const before = conversations.getPersistedConversationHistory(bot.conversationId).messages.filter(row => row.kind === 'user_input').length;
    await editor.press('Enter');
    await until(() => conversations.getPersistedConversationHistory(bot.conversationId).messages.filter(row => row.kind === 'user_input'),
      rows => rows.some(row => row.content === '提交前缀检查一下过渡。'));
    const rows = conversations.getPersistedConversationHistory(bot.conversationId).messages.filter(row => row.kind === 'user_input');
    assert.equal(rows.length, before + 1); assert.equal(rows.at(-1).content, '提交前缀检查一下过渡。');
    await until(() => editor.inputValue(), value => value === '');
  });
  assert.equal(report.pageErrors.length, 0, 'no renderer exceptions');
  assert.equal(serverState.calls.some(row => row.body.tools?.length), false, 'prediction never exposes tools');
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error);
  if (page) { await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    report.dom = (await page.locator('body').innerText().catch(() => '')).slice(-12000);
    report.debug = await page.evaluate(() => [...document.querySelectorAll('.input-prediction-mirror, .chat-composer textarea')].map(node => ({
      className: node.className, text: node.textContent, value: node.value, rect: node.getBoundingClientRect().toJSON(),
      computed: { font: getComputedStyle(node).font, lineHeight: getComputedStyle(node).lineHeight, visibility: getComputedStyle(node).visibility },
      suffix: node.lastElementChild?.getBoundingClientRect().toJSON() }))).catch(() => []); }
} finally {
  report.providerCalls = serverState.calls.map(({ at, mode, draft, body }) => ({ at, mode, draftLength: typeof draft === 'string' ? draft.length : 0, hasTools: !!body.tools?.length }));
  report.traceExists = existsSync(path.join(home, 'provider-traces'));
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(root, 'machine.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(root, 'electron.log'), logs.join(''));
  if (handle) await owned.stop({ handleId: handle, reason: 'owned', timeoutMs: 10000 }).catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, output: root, error: report.error }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
