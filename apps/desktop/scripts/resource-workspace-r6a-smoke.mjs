/** R6a: production Electron + scoped IPC on disposable repositories; no real model/task. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { seedBotShellHome } from './seed-bot-shell-home.mjs';
import { createOwnedProcessRegistry } from './lab-process-identity.mjs';
const source = fileURLToPath(new URL('../../..', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'peer-resource-r6a-')), home = path.join(root, 'data');
const fixture = seedBotShellHome({ home, scale: { bots: 2, messages: 0, inboxEvents: 0, memories: 0 } });
const project = fixture.bots[0].path, knowledge = path.join(root, 'Peer-Knowledge'); mkdirSync(knowledge);
const theme = process.argv.includes('--dark') ? 'dark' : 'light', settingsPath = path.join(home, 'settings.json');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8')); settings.appearance = { mode: theme }; writeFileSync(settingsPath, JSON.stringify(settings));
const put = (name, value, base = project) => { const file = path.join(base, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); };
const git = (base, ...args) => execFileSync('git', ['-C', base, ...args], { encoding: 'utf8' }).trim();
put('readme.md', '# 导航测试正文\n\n' + '这是临时阅读内容。\n\n'.repeat(100)); put('one.ts', 'export const one = 1;\n'); put('two.ts', 'export const two = 1;\n'); put('folder/initial.txt', 'initial\n'); put('knowledge.md', '# 知识库基线\n', knowledge);
put('.peer-workspace.local.json', JSON.stringify({ peerKnowledgeRoot: knowledge }));
for (const repo of [project, knowledge]) { git(repo, 'init', '--quiet'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=R6a Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'disposable baseline'); }
git(knowledge, 'remote', 'add', 'origin', 'https://github.com/ly-ccx/Peer-Knowledge');
put('one.ts', 'export const one = 2;\n'); put('two.ts', 'export const two = 2;\n'); put('knowledge.md', '# 知识库当前正文\n', knowledge);
const originalConversation = readFileSync(path.join(home, 'conversations', fixture.bots[0].conversationId + '.jsonl'));
const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>body{font:16px system-ui;color:CanvasText;background:Canvas;margin:24px}input{font:inherit;padding:8px}</style><title>导航保活网页</title><h1>导航保活网页</h1><input aria-label="网页草稿">'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
const entry = path.join(root, 'entry.mjs'); writeFileSync(entry, `import {app} from 'electron';\napp.setPath('userData',${JSON.stringify(path.join(root, 'chromium'))});\nawait import(${JSON.stringify(pathToFileURL(path.join(source, 'apps/desktop/electron/main/main.mjs')).href)});`);
const report = { root, theme, synthetic: true, checks: [], screenshots: [], pageErrors: [], scope: 'Production Electron main/preload/renderer, temporary repositories/profile and loopback webpage. No real model, personal task or release acceptance.' };
const registry = createOwnedProcessRegistry(), logs = []; let app, handle, page;
const until = async (read, accept, label, timeout = 18000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error(`Timed out: ${label}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const panel = () => page.locator('.resource-workspace'), active = () => page.locator('.resource-document[data-active="true"]');
const auxiliary = () => panel().locator('.resource-aux-pane[data-active="true"]');
const comparison = () => active().locator('.resource-comparison');
const row = name => page.locator('.workbench-tree-row').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
const shot = async name => { await until(() => page.evaluate(() => document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity && a.playState === 'running').length), n => n === 0, 'finite motion'); const target = path.join(root, `${theme}-${name}.png`); await page.screenshot({ path: target }); report.screenshots.push({ name, path: target, sha256: createHash('sha256').update(readFileSync(target)).digest('hex') }); };
const open = async target => { await panel().getByRole('button', { name: '新标签页', exact: true }).click(); await page.locator('.resource-address input').fill(target); await page.locator('.resource-address input').press('Enter'); };
try {
  const env = { ...process.env, PEER_AGENT_HOME: home, PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1', PEER_WORKSPACE_ROOT: project }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; delete env.PEER_KNOWLEDGE_ROOT;
  app = await _electron.launch({ args: [entry], env, cwd: path.join(source, 'apps/desktop'), timeout: 30000 }); handle = registry.register({ process: app.process(), close: () => app.close() });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', data => logs.push(String(data)));
  page = await until(async () => app.windows().find(w => w.url().includes('/dist/index.html') && !w.url().includes('window=')), Boolean, 'main window', 30000);
  page.setDefaultTimeout(15000); page.on('pageerror', error => report.pageErrors.push(error.message)); await page.setViewportSize({ width: 1600, height: 1000 }); await page.bringToFront();
  await until(() => page.locator('html').getAttribute('data-theme'), value => value === theme, 'theme'); await page.locator('.bot-row').filter({ hasText: 'project-000' }).click();
  const draft = () => page.locator('.bot-main textarea').first(); await draft().fill('R6a 主对话草稿');
  await page.getByRole('button', { name: '工作区', exact: true }).click(); await open('./readme.md'); await active().getByRole('heading', { name: '导航测试正文' }).waitFor();
  if (process.argv.includes('--side-only')) {
    const assertSideBySide = async () => {
      const geometry = await page.evaluate(() => {
        const layout = document.querySelector('.bot-resource-layout[data-resource-active="true"]');
        const main = document.querySelector('.bot-main').getBoundingClientRect(), resource = document.querySelector('.resource-workspace').getBoundingClientRect();
        return { full: layout.getAttribute('data-resource-full'), maximized: layout.getAttribute('data-resource-maximized'), main: { left: main.left, right: main.right, width: main.width }, resource: { left: resource.left, right: resource.right, width: resource.width } };
      });
      assert.equal(geometry.full, 'false'); assert.equal(geometry.maximized, 'false');
      assert.ok(geometry.main.width >= 360); assert.ok(geometry.main.right <= geometry.resource.left + 1, JSON.stringify(geometry));
      assert.equal(await draft().isVisible(), true); await draft().fill('默认侧栏中仍可编辑对话草稿');
      return geometry;
    };
    await shot('00-default-side-by-side'); report.defaultGeometry = await assertSideBySide();
    await page.locator('.bot-resource-pane > .resource-workspace-resizer').focus(); await page.keyboard.press('End');
    await until(() => panel().evaluate(node => node.clientWidth), width => width >= 720, 'wide side pane without maximizing');
    await panel().getByRole('button', { name: '浏览目录', exact: true }).click(); await row('folder').click(); await row('initial.txt').waitFor();
    await shot('00-wide-side-with-files'); report.wideGeometry = await assertSideBySide(); assert.equal(await auxiliary().count(), 1);
    assert.equal(await panel().getByRole('button', { name: '展开工作区', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.deepEqual(report.pageErrors, []); report.checks.push('default and widened side panes both keep the conversation visible/editable, no overlap, full=false/maximized=false; auxiliary Files works without maximize'); report.ok = true;
  } else {
  await panel().getByRole('button', { name: '展开工作区', exact: true }).click(); await panel().getByRole('button', { name: '浏览目录', exact: true }).click(); await row('folder').click(); await row('initial.txt').waitFor();
  const treeHandle = await page.locator('.workbench-files').elementHandle(), docHandle = await active().elementHandle();
  await shot('01-files-auxiliary'); await active().locator('.resource-document-body').evaluate(node => { node.scrollTop = 250; });
  await auxiliary().getByRole('button', { name: '收起辅助导航' }).focus(); await page.keyboard.press('Enter');
  assert.equal(await panel().getByRole('button', { name: '浏览目录', exact: true }).evaluate(node => node === document.activeElement), true); await panel().getByRole('button', { name: '浏览目录', exact: true }).click();
  assert.equal(await treeHandle.evaluate(node => node === document.querySelector('.workbench-files')), true); assert.equal(await docHandle.evaluate(node => node.isConnected), true); assert.ok(Math.abs(await active().locator('.resource-document-body').evaluate(node => node.scrollTop) - 250) < 2); assert.equal(await auxiliary().count(), 1);
  report.checks.push('wide auxiliary Files reuses one tree and document DOM; closing/reopening preserves expanded branches');
  const auto = auxiliary().getByRole('button', { name: '自动检查更新', exact: true }); assert.equal(await auto.getAttribute('aria-pressed'), 'false'); await auto.click(); put('folder/new.txt', 'new\n'); await row('new.txt').waitFor();
  await auxiliary().getByRole('button', { name: '收起辅助导航' }).click(); put('folder/later.txt', 'later\n'); await pause(5700); assert.equal(await row('later.txt').count(), 0);
  await panel().getByRole('button', { name: '浏览目录', exact: true }).click(); await row('later.txt').waitFor(); await shot('02-directory-updates');
  report.checks.push('directory auto-check is opt-in, reads real changes, pauses hidden and resumes without rebuilding tree');
  await auxiliary().getByRole('button', { name: '收起辅助导航' }).click(); await panel().getByRole('button', { name: '浏览变更', exact: true }).click();
  await auxiliary().getByRole('button', { name: '项目变更', exact: true }).click(); await comparison().locator('.resource-diff-file').filter({ hasText: 'two.ts' }).click();
  assert.ok((await comparison().innerText()).includes('export const two = 2;')); await shot('03-comparison-index');
  put('two.ts', 'export const two = 1;\n'); await comparison().getByRole('button', { name: '刷新', exact: true }).click(); await comparison().getByText('所选文件已不在当前比较中，请重新选择。', { exact: true }).waitFor();
  assert.ok(!(await comparison().innerText()).includes('export const one')); assert.ok(!(await comparison().innerText()).includes('export const two')); await auxiliary().getByRole('button', { name: /^one.ts/ }).click();
  await comparison().getByRole('button', { name: '自动检查更新', exact: true }).click(); put('one.ts', 'export const one = 30;\n'); await comparison().getByRole('button', { name: '加载新变更', exact: true }).waitFor();
  assert.ok(!(await comparison().innerText()).includes('one = 30')); await shot('04-pending-candidate'); await comparison().getByRole('button', { name: '加载新变更', exact: true }).click(); assert.ok((await comparison().innerText()).includes('one = 30'));
  renameSync(path.join(project, '.git'), path.join(project, '.git-paused')); await comparison().getByRole('button', { name: '刷新', exact: true }).click(); await comparison().getByRole('alert').waitFor();
  assert.ok((await comparison().innerText()).includes('one = 30')); await shot('05-failure-preserves-reading'); renameSync(path.join(project, '.git-paused'), path.join(project, '.git')); await comparison().getByRole('button', { name: '刷新', exact: true }).click(); await until(() => comparison().getByRole('alert').count(), n => n === 0, 'manual retry');
  report.checks.push('shared comparison index, deleted selection has no first-file fallback, automatic candidate needs adoption, real Git failure keeps accepted content and retry recovers');
  await auxiliary().getByRole('button', { name: '知识库变更', exact: true }).click(); await until(() => comparison().innerText(), text => text.includes('知识库当前正文'), 'knowledge source'); assert.ok((await comparison().innerText()).includes(knowledge));
  await auxiliary().getByRole('button', { name: '项目变更', exact: true }).click(); await until(() => comparison().innerText(), text => text.includes('one = 30'), 'project source'); assert.ok(!(await comparison().innerText()).includes('知识库当前正文'));
  await shot('06-independent-sources'); report.checks.push('project and identity-checked knowledge repository use independent comparisons and confirmed roots');
  await open(url); const guest = () => page.locator('webview').first(); await until(() => guest().evaluate(wv => wv.executeJavaScript('Boolean(document.querySelector("input"))')), Boolean, 'guest DOM');
  const guestId = await guest().evaluate(wv => wv.getWebContentsId()); await guest().evaluate(wv => wv.executeJavaScript('document.querySelector("input").value="网页保留"'));
  await panel().getByRole('button', { name: '浏览目录', exact: true }).click(); await row('initial.txt').waitFor(); await auxiliary().getByRole('button', { name: '收起辅助导航' }).click();
  assert.equal(await guest().evaluate(wv => wv.getWebContentsId()), guestId); assert.equal(await guest().evaluate(wv => wv.executeJavaScript('document.querySelector("input").value')), '网页保留');
  await page.setViewportSize({ width: 600, height: 900 }); await panel().getByRole('button', { name: '浏览目录', exact: true }).click(); await row('initial.txt').waitFor(); assert.equal(await auxiliary().count(), 0); await shot('07-narrow-files');
  await panel().getByRole('button', { name: '打开网页视图', exact: true }).click(); assert.equal(await guest().evaluate(wv => wv.getWebContentsId()), guestId); assert.equal(await guest().evaluate(wv => wv.executeJavaScript('document.querySelector("input").value')), '网页保留');
  await page.setViewportSize({ width: 1600, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await panel().getByRole('button', { name: '浏览目录', exact: true }).click(); await until(() => panel().getAttribute('data-resource-aux-motion'), value => value === 'false', 'reduced motion'); await shot('08-browser-reduced-motion');
  report.checks.push('real Browser guest identity and form survive auxiliary/standalone Files; 600px uses standalone; reduced-motion flag is honored');
  await panel().getByRole('button', { name: '恢复工作区', exact: true }).click(); await page.locator('.bot-row').filter({ hasText: 'project-001' }).click(); await page.getByRole('button', { name: '工作区', exact: true }).click(); assert.equal(await auxiliary().count(), 0);
  await page.locator('.bot-row').filter({ hasText: 'project-000' }).click(); assert.equal(await draft().inputValue(), 'R6a 主对话草稿'); assert.equal(await auxiliary().count(), 0);
  assert.deepEqual(readFileSync(path.join(home, 'conversations', fixture.bots[0].conversationId + '.jsonl')), originalConversation); assert.deepEqual(report.pageErrors, []);
  report.checks.push('Bot owner switch clears auxiliary state; original Composer draft and synthetic conversation bytes remain; no renderer errors'); report.ok = true;
  }
} catch (error) { report.ok = false; report.failure = error.stack; process.exitCode = 1; if (page) { report.failureText = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); } }
finally { if (handle) report.stop = await registry.stop({ handleId: handle, reason: 'owned' }); await new Promise(resolve => server.close(resolve)); writeFileSync(path.join(root, 'main.log'), logs.join('')); writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
