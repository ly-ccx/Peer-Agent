/** R5-01 focused acceptance: production Electron/IPC, synthetic files and profile only. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { seedBotShellHome } from './seed-bot-shell-home.mjs';
import { createOwnedProcessRegistry } from './lab-process-identity.mjs';

const source = fileURLToPath(new URL('../../..', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'peer-resource-r5-'));
const home = path.join(root, 'data');
const fixture = seedBotShellHome({ home, scale: { bots: 2, messages: 0, inboxEvents: 0, memories: 0 } });
const theme = process.argv.includes('--dark') ? 'dark' : 'light';
const settingsPath = path.join(home, 'settings.json');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
settings.appearance = { mode: theme };
writeFileSync(settingsPath, JSON.stringify(settings));
const project = fixture.bots[0].path;
const file = path.join(project, 'versioned.md');
const body = version => `# 资源工作区说明 · ${version}\n\n${version === '初稿' ? '当前阅读的是原始内容。外部修改不会直接替换这份正文。' : '这是用户明确加载后的新版正文，原来的刷新提示应当消失。'}\n\n`
  + Array.from({ length: 100 }, (_, i) => `## 第 ${i + 1} 节：阅读与恢复\n\n保留用户正在阅读的位置；预览、源码和各个内容版本分别记录，切换页面不会发送消息或重新执行任务。\n`).join('\n');
const original = body('初稿'), revised = body('新版');
writeFileSync(file, original);
const now = new Date().toISOString();
const history = [
  { id: 'r5-input', kind: 'user_input', role: 'user', content: '帮我整理工作区的资源阅读方案。', createdAt: now },
  { id: 'r5-reply', kind: 'agent_reply', role: 'assistant', content: `资源说明已整理好，可以在右侧阅读。\n\n[打开资源工作区说明](${file})\n\n如果文件有新的修改，刷新时会先保留你正在看的内容，由你决定是否加载新版。`, replyTo: ['r5-input'], createdAt: now },
];
writeFileSync(path.join(home, 'conversations', fixture.bots[0].conversationId + '.jsonl'), history.map(row => JSON.stringify(row)).join('\n') + '\n');
const conversationBefore = readFileSync(path.join(home, 'conversations', fixture.bots[0].conversationId + '.jsonl'));
const entry = path.join(root, 'entry.mjs');
writeFileSync(entry, `import {app} from 'electron';\napp.setPath('userData',${JSON.stringify(path.join(root, 'chromium'))});\nawait import(${JSON.stringify(pathToFileURL(path.join(source, 'apps/desktop/electron/main/main.mjs')).href)});\n`);
const owned = createOwnedProcessRegistry(), logs = [];
const report = { root, theme, synthetic: true, checks: [], screenshots: [], pageErrors: [], stops: [],
  scope: 'R5-01 real production Electron main/preload/renderer; synthetic fixture, no model, personal profile, installed build or full release acceptance.' };
let app, handle, page;
const until = async (read, predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error(`Timed out: ${label}`);
};
const settle = async () => until(() => page.evaluate(() => document.getAnimations().filter(animation => {
  const timing = animation.effect?.getComputedTiming();
  return timing?.iterations !== Infinity && animation.playState === 'running';
}).length), value => value === 0, 'finite layout animations');
const capture = async name => { await settle(); const target = path.join(root, `${theme}-${name}.png`); await page.screenshot({ path: target });
  report.screenshots.push({ name, path: target, sha256: createHash('sha256').update(readFileSync(target)).digest('hex') }); };
const launch = async () => {
  const env = { ...process.env, PEER_AGENT_HOME: home, PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1', PEER_WORKSPACE_ROOT: project };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; delete env.PEER_KNOWLEDGE_ROOT;
  app = await _electron.launch({ args: [entry], env, cwd: path.join(source, 'apps/desktop'), timeout: 30000 });
  handle = owned.register({ process: app.process(), close: () => app.close() });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', chunk => logs.push(String(chunk)));
  page = await until(async () => app.windows().find(window => window.url().includes('/dist/index.html') && !window.url().includes('window=')), Boolean, 'main window', 30000);
  page.setDefaultTimeout(15000); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await until(() => page.locator('html').getAttribute('data-theme'), value => value === theme, 'theme');
  await page.locator('.bot-row').first().click();
};
const stop = async () => { if (handle) { report.stops.push(await owned.stop({ handleId: handle, reason: 'owned' })); handle = undefined; } };
try {
  await launch();
  const panel = () => page.locator('.resource-workspace');
  const active = () => page.locator('.resource-document[data-active="true"]');
  const content = () => active().locator('.resource-document-body');
  const draft = () => page.locator('.bot-main textarea').first();
  await draft().fill('阅读文档时，尚未发送的输入仍然保留。');
  const workspace = () => page.getByRole('button', { name: '工作区', exact: true });
  await workspace().click();
  await page.locator('.resource-address input').fill('./versioned.md');
  await page.locator('.resource-address input').press('Enter');
  await content().getByRole('heading', { name: '资源工作区说明 · 初稿', exact: true }).waitFor();
  await capture('01-initial-reading');
  const read = reference => page.evaluate(reference => window.peerAgent.readFile('', undefined, undefined, reference), reference);
  const reference = { workspaceId: fixture.bots[0].workspaceId, path: file };
  const first = await read(reference);
  assert.equal(first.observation.contentVersion, `sha256:${createHash('sha256').update(original).digest('hex')}`);
  const same = await read({ ...reference, expectedObservation: first.observation });
  assert.equal(same.ok, true); assert.equal(same.content, original);
  const initialBody = await content().elementHandle();
  await content().evaluate(el => { el.scrollTop = 320; el.dispatchEvent(new Event('scroll')); });
  writeFileSync(file, revised); // Simulated external editor, synthetic fixture only.
  const changed = await read({ ...reference, expectedObservation: first.observation });
  assert.equal(changed.status, 'version_changed'); assert.equal(changed.content, '');
  await active().getByRole('button', { name: '刷新', exact: true }).click();
  await active().getByRole('button', { name: '加载当前版本', exact: true }).waitFor();
  assert.equal((await content().innerText()).includes('这是用户明确加载后的新版正文'), false);
  assert.ok(Math.abs(await content().evaluate(el => el.scrollTop) - 320) < 2);
  assert.equal(await initialBody.evaluate(el => el === document.querySelector('.resource-document[data-active="true"] .resource-document-body')), true);
  await capture('02-changed-keeps-old');
  report.checks.push('real host hashes actual bytes; unchanged conditional read succeeds; changed read returns no new body; UI keeps accepted content and scroll position');
  if (theme === 'light') {
    await page.setViewportSize({ width: 760, height: 900 }); await settle();
    await capture('03-narrow-version-feedback');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    await page.setViewportSize({ width: 1600, height: 1000 }); await settle();
  }
  await active().getByRole('button', { name: '加载当前版本', exact: true }).click();
  await content().getByRole('heading', { name: '资源工作区说明 · 新版', exact: true }).waitFor();
  await until(() => active().getByRole('button', { name: '加载当前版本', exact: true }).count(), value => value === 0, 'adoption feedback cleared');
  assert.equal(await draft().inputValue(), '阅读文档时，尚未发送的输入仍然保留。');
  await capture('04-adopted-current');
  report.checks.push('explicit adoption displays current body, clears version notice and preserves Composer draft');
  renameSync(file, file + '.temporarily-away');
  await active().getByRole('button', { name: '刷新', exact: true }).click();
  await active().getByRole('status').filter({ hasText: '未能按此引用定位文件' }).waitFor();
  await content().getByRole('heading', { name: '资源工作区说明 · 新版', exact: true }).waitFor();
  await capture('05-failure-keeps-reading');
  renameSync(file + '.temporarily-away', file);
  await active().getByRole('button', { name: '刷新', exact: true }).click();
  await until(() => active().getByRole('status').filter({ hasText: '未能按此引用定位文件' }).count(), value => value === 0, 'retry clears error');
  report.checks.push('missing-file refresh gives a local reason and retains accepted body; retry recovers');
  const outside = path.join(home, 'private.txt'); writeFileSync(outside, 'R5_OUTSIDE_SECRET');
  const denied = await read({ workspaceId: reference.workspaceId, path: outside });
  assert.equal(denied.status, 'scope_denied'); assert.equal(denied.content || '', '');
  const otherBot = await read({ workspaceId: fixture.bots[1].workspaceId, path: file, expectedObservation: first.observation });
  assert.equal(otherBot.ok, false); assert.equal(otherBot.content || '', '');
  report.checks.push('production host rejects outside-scope and other-Bot references without returning their body');
  await content().evaluate(el => { el.scrollTop = 320; el.dispatchEvent(new Event('scroll')); });
  await active().getByRole('button', { name: '源码', exact: true }).click();
  await until(() => content().locator('[data-source-line]').count(), value => value > 100, 'source rows');
  await content().evaluate(el => { el.scrollTop = 650; el.dispatchEvent(new Event('scroll')); });
  await active().getByRole('button', { name: '正文', exact: true }).click();
  assert.ok(Math.abs(await content().evaluate(el => el.scrollTop) - 320) < 2);
  await active().getByRole('button', { name: '源码', exact: true }).click();
  assert.ok(Math.abs(await content().evaluate(el => el.scrollTop) - 650) < 2);
  const currentVersion = `sha256:${createHash('sha256').update(revised).digest('hex')}`;
  await until(async () => JSON.parse(readFileSync(settingsPath, 'utf8')).workbench?.documentSessions, sessions => sessions && Object.values(sessions).some(session => session.tabs?.some(tab =>
    tab.observation?.contentVersion === currentVersion && tab.readingPositions?.[`${currentVersion}:source`]?.top === 650
      && tab.readingPositions?.[`${currentVersion}:preview`]?.top === 320)), 'version and separate reading positions persisted');
  await stop(); await launch();
  await until(() => workspace().isEnabled(), Boolean, 'restored workspace control');
  if (await page.locator('.bot-resource-layout').getAttribute('data-resource-open') !== 'true') await workspace().click();
  await until(() => page.locator('.bot-resource-layout').getAttribute('data-resource-open'), value => value === 'true', 'workspace open after restart');
  const restoredTab = panel().getByRole('tab').filter({ hasText: 'versioned.md' }); await restoredTab.click();
  await until(() => content().locator('[data-source-line]').count(), value => value > 100, 'restored source');
  await until(() => content().evaluate(el => el.scrollTop), value => Math.abs(value - 650) < 2, 'source read position after full process restart');
  await capture('06-restarted-source-position');
  await active().getByRole('button', { name: '正文', exact: true }).click();
  assert.ok(Math.abs(await content().evaluate(el => el.scrollTop) - 320) < 2);
  report.checks.push('real settings persist content observation and separate source/preview coordinates; fresh Electron process revalidates and restores both');
  assert.equal(readFileSync(file, 'utf8'), revised, 'only the fixture editor changed file contents');
  assert.deepEqual(readFileSync(path.join(home, 'conversations', fixture.bots[0].conversationId + '.jsonl')), conversationBefore);
  assert.deepEqual(report.pageErrors, []);
  report.checks.push('conversation history unchanged; no model request, task continuation or completed-write replay');
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = error.stack; process.exitCode = 1;
  if (page) { report.failureText = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
} finally {
  await stop();
  writeFileSync(path.join(root, 'main.log'), logs.join(''));
  writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
