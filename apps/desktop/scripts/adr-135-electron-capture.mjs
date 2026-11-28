import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES } from '@peer-agent/protocol';
import { seedBotShellHome } from './seed-bot-shell-home.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const output = mkdtempSync(path.join(os.tmpdir(), 'peer-adr135-'));
console.log(output);
const home = path.join(output, 'data');
const { bots } = seedBotShellHome({ home, scale: { bots: 8, messages: 2, inboxEvents: 0, memories: 0 } });
const names = {
  circle: '望月黑猫', square: '三花小猫', pill: '橘猫画师', arch: '拿铁暹罗',
  hex: '蓝猫学者', diamond: '奶牛绅士', triangle: '珍珠白猫', star: '暖棕狸花',
};
for (const [index, bot] of bots.entries()) {
  const shape = BOT_AVATAR_SHAPES[index];
  const file = path.join(home, 'projects', bot.workspaceId, 'profile.json');
  const profile = JSON.parse(readFileSync(file, 'utf8'));
  profile.displayName = names[shape];
  profile.avatar = { kind: 'generated', shape, color: BOT_AVATAR_COLORS[index], variant: 0 };
  writeFileSync(file, JSON.stringify(profile));
}
const first = bots[0];
const tasks = [
  ['running', 'live_execution', 'bot', '检查项目目录与构建入口', '执行中'],
  ['waiting_user', 'human_request', 'user', '确认交付清单与验收范围'],
  ['result_ready', 'verification_failed', 'bot', '复核变更与回归结果'],
  ['queued', 'live_execution', 'bot', '整理任务证据与测试记录'],
  ['queued', 'live_execution', 'bot', '收集打包日志'],
  ['accepted', 'settled', 'none', '盘点既有项目配置', '已完成'],
].map(([status, reason, owner, title, statusLabel], index) => ({
  sessionId: `adr135-task-${index}`, title, status, statusLabel, spawnedAt: new Date(Date.now() - index * 1000).toISOString(),
  workspaceId: first.workspaceId,
  origin: { anchorMessageId: 'rc-message-0', parentConversationId: first.conversationId },
  followUp: { inCurrentList: owner !== 'none', owner, reason },
}));
const historyFile = path.join(home, 'conversations', first.conversationId + '.jsonl');
const messages = readFileSync(historyFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
messages[0].content = '帮我梳理这个项目的交付工作。';
messages[1].content = '我已把交付准备分成几项并行任务。可以从下面进入任务现场，查看进度和需要你确认的事项。';
messages[1].sources = tasks.slice(0, 3).map(task => task.sessionId);
// Deliberately stale report: the visible row should follow the current session projection.
messages[1].meta = { sessionStates: tasks.slice(0, 3).map(task => ({ sessionId: task.sessionId, status: 'starting' })) };
writeFileSync(historyFile, messages.map(row => JSON.stringify(row)).join('\n') + '\n');

const chromium = path.join(output, 'chromium');
mkdirSync(chromium);
const entry = path.join(output, 'entry.mjs');
writeFileSync(entry, `
import { app, BrowserWindow, ipcMain } from 'electron';
app.setPath('userData', ${JSON.stringify(chromium)});
app.setPath('home', ${JSON.stringify(output)});
app.getVersion = () => ${JSON.stringify(JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).version)};
let sessions = ${JSON.stringify(tasks)};
const workspaceId = ${JSON.stringify(first.workspaceId)};
const provider = { id: 'adr135-fixture', provider: 'openai', model: 'fixture', apiKeyConfigured: true,
  modelLabel: 'Fixture model', name: 'Fixture channel', enabled: true };
const modelOptions = [{ id: provider.id, label: provider.modelLabel, providerName: provider.name, groupId: provider.id,
  model: provider.model, authMethod: 'api_key', supportsVision: false, supportsTools: true, supportsStructured: true,
  contextTokens: 128000, available: true }];
const roleView = { eligibleModelIds: [provider.id], resolution: { ok: true, source: 'global',
  selection: { providerId: provider.provider, modelId: provider.model, modelProviderId: provider.id, family: 'fixture' } } };
const modelViews = Object.fromEntries(['project_agent', 'session_worker', 'verifier', 'explorer', 'visual_verifier',
  'memory_curator', 'objective_probe'].map(role => [role, roleView]));
const withTaskSummary = item => item.workspaceId === workspaceId
  ? { ...item, state: { ...item.state, running: 1, needsYou: 1 }, activeSessions: sessions.slice(0, 5),
    activeSessionTotal: 5, historySessionTotal: 1 }
  : item;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (event, payload) => {
  if (channel === 'llm:list') return [provider];
  if (payload?.workspaceId === workspaceId) {
    if (channel === 'project-agent:list-sessions') return { ok: true, sessions };
    if (channel === 'project-agent:get-session') {
      const session = sessions.find(row => row.sessionId === payload.sessionId);
      return session ? { ok: true, session } : { ok: false, code: 'NOT_FOUND' };
    }
  }
  const result = await listener(event, payload);
  if (channel === 'project-agent:list' && result.ok) return { ...result, items: result.items.map(withTaskSummary) };
  if (channel === 'project-agent:get' && result.ok && result.item) return { ...result, item: withTaskSummary(result.item), modelOptions, modelViews };
  return result;
});
globalThis.setADR135Status = (status) => {
  sessions = sessions.map((row, index) => index === 0 ? { ...row, status } : row);
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('project-agent:changed', { workspaceIds: [workspaceId] });
};
await import(${JSON.stringify(pathToFileURL(path.join(desktop, 'electron/main/main.mjs')).href)});
`);
const env = {
  ...process.env,
  PEER_AGENT_HOME: home,
  PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1',
  PEER_WORKSPACE_ROOT: first.path,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const electron = await _electron.launch({ args: [entry], env, cwd: desktop, timeout: 30000 });
electron.process().stderr?.on('data', chunk => process.stderr.write(chunk));
let page;
try {
  const isMainWindow = (window) => {
    const url = new URL(window.url());
    return url.pathname.endsWith('/dist/index.html') && !url.searchParams.has('window');
  };
  page = electron.windows().find(isMainWindow)
    ?? await electron.waitForEvent('window', { predicate: isMainWindow, timeout: 30000 });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error); });
  const window = await electron.browserWindow(page);
  await window.evaluate(win => { win.setContentSize(1280, 860); });
  await page.setViewportSize({ width: 1280, height: 860 });
  page.setDefaultTimeout(15000);
  const sidebar = page.locator('.bot-column');
  const rows = sidebar.locator('.bot-row');
  await rows.last().waitFor();
  assert.equal(await rows.count(), 8);
  assert.deepEqual(await rows.locator('[data-avatar-shape]').evaluateAll(nodes => nodes.map(node => node.dataset.avatarShape).sort()), [...BOT_AVATAR_SHAPES].sort());
  assert.equal(await page.locator('.bot-avatar-executor').count(), 0);
  await page.locator('.bot-home-hero').waitFor();
  assert.equal(await page.locator('.bot-search-frame').count(), 0);
  const filter = page.locator('.bot-search');
  await page.keyboard.press('Meta+f');
  await filter.waitFor();
  assert.equal(await filter.evaluate(input => input === document.activeElement), true);
  await filter.fill('望月黑猫');
  await page.keyboard.press('Escape');
  assert.equal(await filter.isVisible(), true);
  await filter.clear();
  await page.keyboard.press('Escape');
  await filter.waitFor({ state: 'detached' });
  await page.keyboard.press('Meta+k');
  await page.locator('.conversation-search').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.conversation-search').waitFor({ state: 'hidden' });

  const theme = async (value) => {
    if (await page.locator('html').getAttribute('data-theme') !== value) await page.locator('.bot-dock-theme').click();
    await page.locator(`html[data-theme="${value}"]`).waitFor({ state: 'attached' });
  };
  const shot = async (surface, scheme) => {
    await page.screenshot({ path: path.join(output, `verify-${surface}-${scheme}.png`), animations: 'disabled' });
  };
  const capture = async (surface) => {
    for (const scheme of ['light', 'dark']) {
      await theme(scheme);
      await shot(surface, scheme);
    }
  };
  await page.locator('.bot-home-hero h1').click();
  await capture('home');
  const bot = rows.filter({ hasText: '望月黑猫' });
  await bot.click();
  const feed = page.locator('.bot-inline-worker-row');
  await feed.last().waitFor();
  assert.deepEqual(await feed.locator('.bot-inline-worker-status').allTextContents(), ['执行中', '待你确认', '核验未通过']);
  assert.equal(await feed.locator('[data-executor-kind="peer"]').count(), 3);
  const alignment = await feed.first().evaluate(row => {
    const body = row.closest('.bot-continuous-reply').querySelector('.bot-reply-text');
    const icon = row.querySelector('.bot-inline-worker-cli');
    const style = getComputedStyle(row);
    return [icon.getBoundingClientRect().left - body.getBoundingClientRect().left, style.borderTopWidth, style.backgroundColor];
  });
  assert.deepEqual(alignment, [0, '0px', 'rgba(0, 0, 0, 0)']);
  await electron.evaluate(() => { globalThis.setADR135Status('verifying'); });
  await feed.first().getByText('核验中', { exact: true }).waitFor();
  await electron.evaluate(() => { globalThis.setADR135Status('running'); });
  await feed.first().getByText('执行中').waitFor();
  await feed.first().hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.bot-inline-worker-row')).backgroundColor !== 'rgba(0, 0, 0, 0)');
  const summary = page.locator('.bot-touchbar-summary');
  assert.equal(await summary.locator('.bot-tb-status-text').innerText(), '5 个任务 · 待你决定 1 · 核验未通过 1 · 执行中 1 · 排队中 2');
  await summary.locator('.bot-tb-status').click();
  await page.locator('.bot-tray-row-title-line [data-executor-kind="peer"]').last().waitFor();
  await page.keyboard.press('Escape');
  await capture('inline-stream');

  const tasksInSidebar = sidebar.locator('.bot-sidebar-task');
  assert.equal(await tasksInSidebar.count(), 4);
  assert.deepEqual(await tasksInSidebar.evaluateAll(nodes => nodes.map(node => node.dataset.taskTone)), ['warn', 'danger', 'active', 'queued']);
  const more = sidebar.locator('.bot-sidebar-task-more');
  assert.equal(await more.innerText(), '再显示 1 个任务');
  await more.click();
  assert.equal(await tasksInSidebar.count(), 5);
  await more.click();
  assert.equal(await tasksInSidebar.count(), 4);
  assert.match(await bot.innerText(), /1 个工作中/);
  assert.equal(await sidebar.locator('.bot-sidebar-task-tag').count(), 0);
  const draft = page.locator('.bot-composer textarea').first();
  await draft.fill('保留这段未发送的草稿');
  await feed.first().focus();
  await page.keyboard.press('Enter');
  await sidebar.locator('.bot-sidebar-task.is-selected[data-session-id="adr135-task-0"]').waitFor();
  assert.equal(await page.locator('.bot-main-crumbs .bot-crumb-current').innerText(), '检查项目目录与构建入口');
  await capture('sidebar-tasks');
  await page.locator('.bot-crumb-parent').click();
  await feed.first().waitFor();
  assert.equal(await draft.inputValue(), '保留这段未发送的草稿');
  await draft.clear();

  const drawer = page.locator('.bot-drawer-body');
  await page.locator('[data-profile-drawer]').click();
  const overview = drawer.getByRole('tab', { name: '概况', exact: true });
  const settings = drawer.getByRole('tab', { name: '设置', exact: true });
  for (const scheme of ['light', 'dark']) {
    await theme(scheme);
    await overview.click();
    await drawer.locator('.bot-overview-details').waitFor();
    await shot('drawer-overview', scheme);
    await settings.click();
    const avatar = drawer.locator('.bot-avatar-settings .bot-avatar');
    await avatar.waitFor();
    assert.equal(await avatar.evaluate(node => node.getBoundingClientRect().width), 56);
    const headers = drawer.locator('.bot-model-settings-head:visible');
    assert.equal(await headers.count(), 3);
    for (const header of await headers.all()) {
      const source = header.locator('.bot-model-source');
      assert.equal(await source.innerText(), '跟随全局');
      assert.equal(await header.locator('..').locator('.bot-model-control .bot-model-source').count(), 0);
    }
    await shot('drawer', scheme);
  }
  const preview = drawer.locator('.bot-avatar-settings .bot-avatar');
  const initialBreed = await preview.getAttribute('data-avatar-breed');
  const swatch = drawer.locator('.bot-avatar-color').nth(1);
  await swatch.click();
  await page.waitForFunction(() => document.querySelectorAll('.bot-avatar-color')[1]?.ariaPressed === 'true');
  assert.equal(await preview.getAttribute('data-avatar-breed'), initialBreed);
  await drawer.getByRole('button', { name: '重新生成', exact: true }).click();
  await page.waitForFunction(breed => document.querySelector('.bot-avatar-settings .bot-avatar')?.dataset.avatarBreed !== breed, initialBreed);
  assert.deepEqual(errors, []);
  console.log('ADR 135 screenshots and isolated Electron checks passed.');
} catch (error) {
  if (page) {
    console.error(await page.locator('body').innerText().catch(() => 'Renderer unavailable'));
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  await electron.close();
}
