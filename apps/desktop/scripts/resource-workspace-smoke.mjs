/** Focused production Electron check. Synthetic data/home only; no model or user-task execution. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { _electron } from 'playwright-core';
import { seedBotShellHome } from './seed-bot-shell-home.mjs';
import { createOwnedProcessRegistry } from './lab-process-identity.mjs';
import { createGoalPlanStore } from '@peer-agent/runtime-node';

const source = fileURLToPath(new URL('../../..', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'peer-resource-ui-'));
const home = path.join(root, 'data');
const fixture = seedBotShellHome({ home, scale: { bots: 2, messages: 0, inboxEvents: 0, memories: 0 } });
const theme = process.argv.includes('--dark') ? 'dark' : 'light';
const settingsPath = path.join(home, 'settings.json');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
settings.appearance = { mode: theme };
writeFileSync(settingsPath, JSON.stringify(settings));
const project = fixture.bots[0].path;
const knowledge = path.join(path.dirname(project), 'Peer-Knowledge');
mkdirSync(path.join(knowledge, 'knowledge'), { recursive: true });
writeFileSync(path.join(knowledge, 'knowledge/decision.md'), '# KNOWLEDGE_BODY_OK\n\n[Nested](nested.md)\n');
writeFileSync(path.join(knowledge, 'knowledge/nested.md'), '# NESTED_BODY_OK\n');
execFileSync('git', ['init', '--quiet', knowledge]);
execFileSync('git', ['-C', knowledge, 'remote', 'add', 'origin', 'https://github.com/ly-ccx/Peer-Knowledge.git']);
writeFileSync(path.join(project, 'guide.md'), '# DOCUMENT_BODY_OK\n\nLocal Markdown content.\n');
writeFileSync(path.join(project, 'long.md'), '# LONG_DOCUMENT_OK\n\n' + Array.from({ length: 180 }, (_, i) => `Paragraph ${i + 1}: reading continuity.\n`).join('\n'));
writeFileSync(path.join(project, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ2kAAAAASUVORK5CYII=', 'base64'));
mkdirSync(path.join(project, 'scripts'));
writeFileSync(path.join(project, 'scripts/host-lease.mjs'), 'export const SOURCE_BINDING_OK = true;\n');
execFileSync('git', ['init', '--quiet', project]);
execFileSync('git', ['-C', project, '-c', 'user.name=Resource Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '.']);
execFileSync('git', ['-C', project, '-c', 'user.name=Resource Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'synthetic baseline']);
const baseCommit = execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(path.join(project, 'revision.md'), '# FIXED_REVISION_OK\n');
execFileSync('git', ['-C', project, 'add', 'revision.md']);
execFileSync('git', ['-C', project, '-c', 'user.name=Resource Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'synthetic next revision']);
const endCommit = execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
execFileSync('git', ['-C', project, 'branch', 'moving-base', baseCommit]);
writeFileSync(path.join(project, 'staged.md'), '# STAGED_CHANGE_OK\n');
execFileSync('git', ['-C', project, 'add', 'staged.md']);
writeFileSync(path.join(project, 'guide.md'), '# DOCUMENT_BODY_OK\n\nDIFF_CHANGE_OK\n');
const outside = path.join(home, 'private.txt'); writeFileSync(outside, 'OUTSIDE_SECRET_MUST_NOT_RENDER');
const now = new Date().toISOString();
const taskTree = path.join(home, 'internal-task-worktrees', 'fixture');
mkdirSync(path.dirname(taskTree), { recursive: true });
execFileSync('git', ['-C', project, 'worktree', 'add', '--quiet', '--detach', taskTree, baseCommit]);
writeFileSync(path.join(taskTree, 'guide.md'), '# TASK_WORKTREE_BODY_OK\n\nTASK_WORKTREE_DIFF_OK\n\n[Nested](task-nested.md)\n');
writeFileSync(path.join(taskTree, 'task-nested.md'), '# TASK_NESTED_OK\n');
const task = { sessionId: 'resource-task-fixture', planId: 'resource-plan-fixture' };
const model = { providerId: 'fixture', modelId: 'fixture', modelProviderId: 'fixture', family: 'fixture' };
createGoalPlanStore({ storeDir: path.join(home, 'goal-plans') }).createPlan({
  planId: task.planId, title: 'Isolated resource fixture', goal: 'Read only', tasks: [], status: 'paused',
  deliveryBinding: { repoId: 'resource-fixture', targetBranch: 'fixture', targetBranchSource: 'user_confirmed',
    executionIsolation: 'worktree', worktreePath: taskTree, targetWorkspacePath: project, baseCommit },
  delegationOrigin: { workspaceId: fixture.bots[0].workspaceId, sessionId: task.sessionId, parentConversationId: fixture.bots[0].conversationId,
    anchorMessageId: 'input-fixture', inputId: 'input-fixture', phase: 'paused',
    modelSelection: { worker: model, explorer: model, verifier: { ...model, sameFamilyAsWorker: true }, source: { worker: 'global' }, resolvedAt: now } },
});
const history = [{ id: 'input-fixture', kind: 'user_input', role: 'user', content: 'Read a fixture file.', createdAt: now },
  { id: 'turn-fixture', kind: 'agent_turn', role: 'assistant', createdAt: now, rounds: [{ toolCalls: [{ name: 'read_file', result: JSON.stringify({ kind: 'local_file_ref', tool: 'read_file', path: path.join(project, 'scripts/host-lease.mjs') }) }] }] },
  { id: 'reply-fixture', turnId: 'turn-fixture', kind: 'agent_reply', role: 'assistant', content: 'Source: `host-lease.mjs`.', createdAt: now, replyTo: ['input-fixture'] }];
writeFileSync(path.join(home, 'conversations', fixture.bots[0].conversationId + '.jsonl'), history.map(row => JSON.stringify(row)).join('\n') + '\n');
const entry = path.join(root, 'entry.mjs');
writeFileSync(entry, `import {app} from 'electron';\napp.setPath('userData',${JSON.stringify(path.join(root, 'chromium'))});\nawait import(${JSON.stringify(pathToFileURL(path.join(source, 'apps/desktop/electron/main/main.mjs')).href)});\n`);
const report = { synthetic: true, checks: [], pageErrors: [], screenshots: [], root, theme, scope: 'Fresh production Electron main/preload/renderer; no real model, installed build or user profile.' };
const logs = [], owned = createOwnedProcessRegistry();
let app, handle, page, requests = 0;
let imageRequests = 0;
const server = createServer((req, res) => { requests++; if (req.url === '/tracking.png') imageRequests++;
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><h1>WEB_BODY_OK</h1><input id="draft" value="WEB_DRAFT_OK">'); });
const snapshotFiles = directory => Object.fromEntries(readdirSync(directory, { withFileTypes: true }).filter(entry => entry.name !== '.git').flatMap(entry => {
  const target = path.join(directory, entry.name);
  return entry.isDirectory() ? Object.entries(snapshotFiles(target)) : [[target, createHash('sha256').update(readFileSync(target)).digest('hex')]];
}));
const until = async (read, predicate, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for resource state');
};
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  writeFileSync(path.join(project, 'remote.md'), `# REMOTE_IMAGE_OK\n\n![tracking](http://127.0.0.1:${server.address().port}/tracking.png)\n`);
  const filesBefore = snapshotFiles(project), knowledgeBefore = snapshotFiles(knowledge), taskBefore = snapshotFiles(taskTree);
  const indexBefore = readFileSync(path.join(project, '.git/index'));
  const taskIndexPath = execFileSync('git', ['-C', taskTree, 'rev-parse', '--git-path', 'index'], { encoding: 'utf8' }).trim();
  const taskIndexBefore = readFileSync(taskIndexPath);
  const env = { ...process.env, PEER_AGENT_HOME: home, PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1', PEER_WORKSPACE_ROOT: project };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; delete env.PEER_KNOWLEDGE_ROOT;
  app = await _electron.launch({ args: [entry], env, cwd: path.join(source, 'apps/desktop'), timeout: 30000 });
  handle = owned.register({ process: app.process(), close: () => app.close() });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', data => logs.push(String(data)));
  page = await until(async () => app.windows().find(window => window.url().includes('/dist/index.html') && !window.url().includes('window=')), Boolean, 30000);
  page.setDefaultTimeout(15000); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await until(() => page.locator('html').getAttribute('data-theme'), value => value === theme);
  await page.locator('.bot-row').first().click();
  const workspaceButton = page.getByRole('button', { name: '工作区', exact: true });
  await until(() => workspaceButton.isEnabled(), Boolean);
  const baselineShell = await page.locator('.bot-main').evaluate(el => { const style = getComputedStyle(el); return { radius: style.borderTopLeftRadius, border: style.borderTopWidth, shadow: style.boxShadow, background: style.backgroundColor, curve: style.getPropertyValue('corner-shape') }; });
  const nativeButtons = process.platform === 'darwin' ? await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/dist/index.html') && !win.webContents.getURL().includes('window=')).getWindowButtonPosition()) : null;
  report.shellGeometry = [];
  const draft = page.locator('.bot-main textarea').first(); await draft.fill('COMPOSER_DRAFT_OK');
  const panel = page.locator('.resource-workspace');
  const shot = async name => { const file = path.join(root, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(file); };
  const openLauncher = async () => { await panel.locator('.resource-tab-action').first().click(); await page.locator('.resource-address input').waitFor({ state: 'visible' }); };
  const openPath = async target => {
    await openLauncher(); await page.locator('.resource-address input').fill(target); await page.locator('.resource-address input').press('Enter');
    if (!/[\\/]/.test(target)) await panel.locator('.resource-search-hit').filter({ hasText: target }).click();
  };
  await workspaceButton.click();
  await page.locator('.resource-launcher').waitFor({ state: 'visible' });
  assert.equal(await page.locator('webview').count(), 0, 'launcher must not allocate a guest');
  report.checks.push('nonmodal launcher without guest allocation');
  await openPath('guide.md');
  await page.locator('.resource-document[data-active="true"] h1').filter({ hasText: 'DOCUMENT_BODY_OK' }).waitFor();
  assert.equal(await draft.inputValue(), 'COMPOSER_DRAFT_OK');
  await panel.getByRole('button', { name: '源码', exact: true }).click();
  await until(() => page.locator('.resource-document[data-active="true"] .resource-document-body').innerText(), text => text.includes('# DOCUMENT_BODY_OK'));
  await panel.getByRole('button', { name: '正文', exact: true }).click();
  report.checks.push('Markdown body/source and Composer draft survive opening');
  await openPath('./long.md');
  const documentBody = page.locator('.resource-document[data-active="true"] .resource-document-body');
  await page.locator('.resource-document[data-active="true"] h1').filter({ hasText: 'LONG_DOCUMENT_OK' }).waitFor();
  await documentBody.evaluate(el => { el.scrollTop = 600; el.dispatchEvent(new Event('scroll')); });
  await panel.getByRole('button', { name: '源码', exact: true }).click();
  await until(() => documentBody.locator('[data-source-line]').count(), count => count > 100);
  await documentBody.evaluate(el => { el.scrollTop = 1000; el.dispatchEvent(new Event('scroll')); });
  await panel.getByRole('button', { name: '正文', exact: true }).click();
  assert.ok(Math.abs(await documentBody.evaluate(el => el.scrollTop) - 600) < 2);
  await panel.getByRole('button', { name: '源码', exact: true }).click();
  assert.ok(Math.abs(await documentBody.evaluate(el => el.scrollTop) - 1000) < 2);
  await openPath('./long.md#L120');
  await until(() => documentBody.evaluate(el => Math.abs(el.querySelector('[data-source-line="120"]').getBoundingClientRect().top - el.getBoundingClientRect().top)), value => value < 2);
  await openPath('./long.md#L9999');
  await page.locator('.resource-document[data-active="true"]').getByRole('status').filter({ hasText: '行号超出' }).waitFor();
  await shot('workspace-line-warning');
  report.checks.push('real DOM mode reading positions, repeated line intents and missing-line fallback');
  await openPath('./remote.md');
  await documentBody.getByRole('button', { name: /打开外部图片/ }).waitFor();
  assert.equal(await documentBody.locator('img').count(), 0); assert.equal(imageRequests, 0);
  await shot('workspace-static-image');
  await documentBody.getByRole('button', { name: /打开外部图片/ }).click();
  await until(() => imageRequests, value => value > 0);
  report.checks.push('static Markdown external image makes no request before explicit opening');
  await openPath('./pixel.png');
  await until(() => documentBody.locator('img.resource-image').evaluate(el => el.complete && el.naturalWidth > 0), Boolean);
  report.checks.push('scoped local image decoded by production host');
  await openPath('./missing.md');
  await page.locator('.resource-document[data-active="true"]').getByRole('alert').filter({ hasText: '未能按此引用定位文件' }).waitFor();
  report.checks.push('missing file has a local error without blocking other resources');
  await page.locator('.bot-reply-text .markdown-file-path').filter({ hasText: 'host-lease.mjs' }).click();
  await until(() => page.locator('.resource-document[data-active="true"] .resource-document-body').innerText(), text => text.includes('SOURCE_BINDING_OK'));
  report.checks.push('same-turn short filename resolves to its full tool-result source');
  await openPath('Peer-Knowledge/knowledge/decision.md');
  await page.locator('.resource-document[data-active="true"] h1').filter({ hasText: 'KNOWLEDGE_BODY_OK' }).waitFor();
  await page.locator('.resource-document[data-active="true"]').getByRole('link', { name: 'Nested', exact: true }).click();
  await page.locator('.resource-document[data-active="true"] h1').filter({ hasText: 'NESTED_BODY_OK' }).waitFor();
  report.checks.push('confirmed cross-repository Markdown and nested relative link');
  await openLauncher(); await panel.getByRole('button', { name: '文件与目录', exact: true }).click();
  await page.locator('.resource-navigator .workbench-files').waitFor({ state: 'visible' });
  await until(() => page.locator('.workbench-files').innerText(), text => text.includes('guide.md'));
  report.checks.push('independent bounded directory view');
  await openLauncher(); await panel.getByRole('button', { name: '查看更改', exact: true }).click();
  await until(() => page.locator('.resource-changes').innerText(), text => text.includes('DIFF_CHANGE_OK'));
  report.checks.push('full unstaged repository Diff');
  const changes = page.locator('.resource-changes');
  await changes.getByRole('combobox', { name: '比较范围', exact: true }).selectOption('staged');
  await until(() => changes.innerText(), text => text.includes('STAGED_CHANGE_OK'));
  await changes.getByRole('combobox', { name: '比较范围', exact: true }).selectOption('range');
  await changes.getByRole('textbox', { name: '起始引用', exact: true }).fill('moving-base');
  await changes.getByRole('textbox', { name: '目标引用（空为工作树）', exact: true }).fill(endCommit);
  await changes.getByRole('button', { name: '比较', exact: true }).click();
  await until(() => changes.locator('.resource-comparison:visible').innerText(), text => text.includes('FIXED_REVISION_OK') && text.includes(baseCommit));
  execFileSync('git', ['-C', project, 'branch', '-f', 'moving-base', endCommit]);
  await changes.locator('.resource-comparison:visible').getByRole('button', { name: '刷新', exact: true }).click();
  await until(() => changes.locator('.resource-comparison:visible').getAttribute('aria-busy'), busy => busy === 'false');
  assert.ok((await changes.locator('.resource-comparison:visible').innerText()).includes(baseCommit));
  await changes.getByRole('button', { name: '在独立标签保留比较', exact: true }).filter({ visible: true }).click();
  await until(() => documentBody.innerText(), text => text.includes('FIXED_REVISION_OK') && text.includes(baseCommit));
  const fixedTab = panel.getByRole('tab').filter({ hasText: `Diff · ${baseCommit.slice(0, 8)}` });
  await fixedTab.waitFor({ state: 'visible' });
  await openLauncher(); await panel.getByRole('button', { name: '查看更改', exact: true }).click();
  await changes.getByRole('combobox', { name: '比较范围', exact: true }).selectOption('staged');
  await changes.locator('.resource-comparison:visible').getByRole('button', { name: '在独立标签保留比较', exact: true }).click();
  await until(() => documentBody.innerText(), text => text.includes('STAGED_CHANGE_OK'));
  await fixedTab.click();
  await until(() => documentBody.innerText(), text => text.includes('FIXED_REVISION_OK') && !text.includes('STAGED_CHANGE_OK'));
  await shot('workspace-comparison-tabs');
  report.checks.push('staged Diff, pinned moving revision refresh and independent comparison tabs');
  await openLauncher(); await panel.getByRole('button', { name: '查看更改', exact: true }).click();
  await changes.getByRole('combobox', { name: '比较范围', exact: true }).selectOption('task');
  await changes.getByRole('combobox', { name: '任务比较来源', exact: true }).selectOption(task.sessionId);
  await until(() => changes.locator('.resource-comparison:visible').innerText(), text => text.includes('TASK_WORKTREE_DIFF_OK'));
  await changes.locator('.resource-comparison:visible').getByRole('button', { name: '在独立标签保留比较', exact: true }).click();
  await until(() => documentBody.innerText(), text => text.includes('TASK_WORKTREE_DIFF_OK'));
  await page.locator('.resource-document[data-active="true"]').getByRole('button', { name: '打开当前文件', exact: true }).click();
  await page.locator('.resource-document[data-active="true"] h1').filter({ hasText: 'TASK_WORKTREE_BODY_OK' }).waitFor();
  await page.locator('.resource-document[data-active="true"]').getByRole('link', { name: 'Nested', exact: true }).click();
  await page.locator('.resource-document[data-active="true"] h1').filter({ hasText: 'TASK_NESTED_OK' }).waitFor();
  await openLauncher();
  await panel.locator('.resource-recent').filter({ hasText: 'task-nested.md' }).click();
  await page.locator('.resource-document[data-active="true"] h1').filter({ hasText: 'TASK_NESTED_OK' }).waitFor();
  const taskReads = await page.evaluate(async ({ workspaceId, task, path }) => {
    const read = reference => window.peerAgent.readFile('', undefined, undefined, reference);
    return Promise.all([read({ workspaceId, path }), read({ workspaceId, path, task }),
      read({ workspaceId, path, task: { ...task, sessionId: 'forged-session' } })]);
  }, { workspaceId: fixture.bots[0].workspaceId, task, path: path.join(taskTree, 'guide.md') });
  assert.equal(taskReads[0].status, 'scope_denied'); assert.equal(taskReads[1].ok, true); assert.equal(taskReads[2].status, 'scope_denied');
  report.checks.push('host-owned unregistered task worktree comparison, retained tab/current file/nested link and forged-scope rejection');
  await openPath(outside);
  await page.locator('.resource-document[data-active="true"] [role="alert"]').filter({ hasText: '超出' }).waitFor();
  assert.equal((await panel.innerText()).includes('OUTSIDE_SECRET_MUST_NOT_RENDER'), false);
  report.checks.push('outside-scope denial without content leak');
  await openPath(`http://127.0.0.1:${server.address().port}/`);
  const guest = await until(() => page.evaluate(() => [...document.querySelectorAll('webview')].map(el => { try { return el.getWebContentsId(); } catch { return 0; } }).find(Boolean)), Boolean);
  await until(() => requests, value => value > 0);
  await until(() => app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.querySelector('#draft')?.value"), guest), value => value === 'WEB_DRAFT_OK');
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.querySelector('#draft').value='USER_WEB_DRAFT_OK'"), guest);
  await openPath('guide.md');
  const browserTab = panel.getByRole('tab').filter({ hasText: '127.0.0.1' }).first(); await browserTab.click();
  const retainedGuest = await page.evaluate(() => [...document.querySelectorAll('webview')].map(el => { try { return el.getWebContentsId(); } catch { return 0; } }).find(Boolean));
  assert.equal(retainedGuest, guest, 'switching content domains must retain the same WebContents');
  assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.querySelector('#draft').value"), guest), 'USER_WEB_DRAFT_OK');
  report.checks.push('real browser guest preserved across mixed document/web tabs');
  await openPath('guide.md');
  const checkShell = async mode => {
    await until(() => panel.evaluate(el => {
      const frame = el.closest('.bot-resource-layout');
      const gap = parseFloat(getComputedStyle(frame).getPropertyValue('--bot-float-gap')) || 0;
      return Math.abs(frame.getBoundingClientRect().right - el.getBoundingClientRect().right - gap) <= 1;
    }), Boolean);
    const geometry = await page.evaluate(() => {
      const frame = document.querySelector('.bot-resource-layout'), panel = document.querySelector('.resource-workspace');
      const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      const style = getComputedStyle(panel), button = frame.querySelector('.resource-switcher');
      const header = panel.querySelector('.resource-workspace-header');
      const controls = [...header.querySelectorAll('.resource-workspace-controls button')];
      const controlRects = controls.map(rect), headerRect = rect(header);
      const headerStyle = getComputedStyle(header), panelStyle = getComputedStyle(panel);
      return { measuredWidth: Number(frame.dataset.resourceMeasuredWidth), floating: document.documentElement.dataset.vibrancy === 'true', gap: parseFloat(getComputedStyle(frame).getPropertyValue('--bot-float-gap')) || 0,
        radius: style.borderTopLeftRadius, border: style.borderTopWidth, shadow: style.boxShadow, background: style.backgroundColor, curve: style.getPropertyValue('corner-shape'), overflow: style.overflow,
        hostBackgrounds: [...panel.querySelectorAll('.document-view, .browser-view')].map(el => getComputedStyle(el).backgroundColor),
        toolbarInsets: { top: Math.min(...controlRects.map(r => r.top)) - headerRect.top,
          bottom: headerRect.bottom - parseFloat(headerStyle.borderBottomWidth) - Math.max(...controlRects.map(r => r.bottom)),
          right: rect(panel).right - parseFloat(panelStyle.borderRightWidth) - Math.max(...controlRects.map(r => r.right)) },
        headerPadding: [headerStyle.paddingTop, headerStyle.paddingRight, headerStyle.paddingBottom, headerStyle.paddingLeft],
        buttonSizes: controlRects.map(r => ({ width: r.right - r.left, height: r.bottom - r.top })),
        root: rect(frame), panel: rect(panel), main: rect(document.querySelector('.bot-main')), button: button ? rect(button) : null,
        bar: button ? rect(button.closest('.resource-navigation-bar')) : null };
    });
    report.shellGeometry.push({ mode, nativeButtons, ...geometry });
    assert.ok(geometry.measuredWidth > 0 && Math.abs(geometry.measuredWidth - (geometry.root.right - geometry.root.left)) <= 1, `${mode}: attached container has a current positive measurement`);
    assert.deepEqual(geometry.headerPadding, ['8px', '8px', '8px', '8px'], `${mode}: equal padding on all sides`);
    for (const [side, value] of Object.entries(geometry.toolbarInsets)) assert.ok(Math.abs(value - 8) <= 0.5, `${mode}: exact ${side} inset`);
    for (const size of geometry.buttonSizes) assert.deepEqual(size, { width: 32, height: 32 }, `${mode}: square icon button`);
    if (geometry.floating) {
      for (const key of ['radius', 'border', 'shadow', 'background', 'curve']) assert.equal(geometry[key], baselineShell[key], `${mode}: same conversation ${key}`);
      assert.equal(geometry.overflow, 'hidden');
      assert.ok(geometry.hostBackgrounds.every(background => background === baselineShell.background), `${mode}: host content uses the conversation paper`);
      assert.ok(Math.abs(geometry.root.right - geometry.panel.right - geometry.gap) <= 1, `${mode}: outer right gap`);
      assert.ok(Math.abs(geometry.root.bottom - geometry.panel.bottom - geometry.gap) <= 1, `${mode}: outer bottom gap`);
      if (mode === 'split') {
        assert.ok(Math.abs(geometry.panel.top - geometry.main.top) <= 1, 'panel tops align');
        assert.ok(Math.abs(geometry.panel.bottom - geometry.main.bottom) <= 1, 'panel bottoms align');
        assert.ok(Math.abs(geometry.panel.left - geometry.main.right - geometry.gap) <= 1, 'one shared gap between panels');
      } else {
        assert.ok(Math.abs(geometry.panel.left - geometry.root.left - geometry.gap) <= 1, `${mode}: outer left gap`);
        assert.ok(Math.abs(geometry.panel.top - geometry.bar.bottom - geometry.gap) <= 1, `${mode}: gap below native navigation bar`);
      }
    }
    if (nativeButtons && geometry.button) assert.ok(geometry.button.left >= nativeButtons.x + 72 || geometry.button.top >= nativeButtons.y + 20, `${mode}: native traffic lights remain unobstructed`);
  };

  await until(() => panel.locator('.resource-workspace-header [aria-selected="true"]').evaluate(el => {
    const item = el.getBoundingClientRect(), rail = el.closest('.resource-tabs').getBoundingClientRect();
    return item.left >= rail.left - 1 && item.right <= rail.right + 1;
  }), Boolean);
  await checkShell('split');
  const resizeHandle = panel.getByRole('separator', { name: '拖拽调整工作台宽度', exact: true });
  const resizeBox = await resizeHandle.boundingBox();
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + 80);
  await page.mouse.down(); await page.mouse.move(resizeBox.x - 30, resizeBox.y + 80);
  await resizeHandle.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', isPrimary: true });
  await page.mouse.up();
  await until(() => resizeHandle.getAttribute('data-active'), value => value !== 'true');
  assert.equal(await draft.inputValue(), 'COMPOSER_DRAFT_OK');
  report.checks.push('pointer resize cancellation cleans up and retains Composer draft');
  await shot('workspace-wide');
  await panel.getByRole('button', { name: '展开工作区', exact: true }).click();
  await until(() => page.locator('.bot-resource-layout').getAttribute('data-resource-maximized'), value => value === 'true');
  await page.setViewportSize({ width: 1316, height: 896 });
  await openLauncher();
  await checkShell('expanded');
  await shot('workspace-expanded-launcher');
  const corner = await panel.boundingBox();
  const clipX = Math.max(0, Math.floor(corner.x + corner.width - 220));
  const cornerFile = path.join(root, 'workspace-toolbar-corner.png');
  await page.screenshot({ path: cornerFile, clip: { x: clipX, y: Math.max(0, Math.floor(corner.y - 8)), width: Math.min(230, page.viewportSize().width - clipX), height: 130 } });
  report.screenshots.push(cornerFile);
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await until(() => page.locator('.bot-resource-layout').getAttribute('data-resource-maximized'), value => value === 'false');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openPath('guide.md');
  await page.setViewportSize({ width: 850, height: 900 });
  await until(() => page.locator('.bot-resource-layout').getAttribute('data-resource-navigation-collapsed'), value => value === 'true');
  assert.equal(await page.locator('.bot-resource-layout').getAttribute('data-resource-compact'), 'false');
  assert.equal(await page.locator('.bot-column').isVisible(), false);
  assert.equal(await draft.isVisible(), true);
  const separator = panel.getByRole('separator', { name: '拖拽调整工作台宽度', exact: true });
  await separator.focus(); await separator.press('End');
  assert.equal(await page.locator('.bot-resource-layout').getAttribute('data-resource-maximized'), 'false');
  assert.equal(await draft.isVisible(), true);
  await page.getByRole('button', { name: '显示机器人列表', exact: true }).click();
  await page.locator('.bot-column').waitFor({ state: 'visible' });
  assert.equal(await draft.inputValue(), 'COMPOSER_DRAFT_OK');
  await workspaceButton.click();
  await until(() => panel.isVisible(), Boolean);
  assert.equal(await page.locator('.bot-resource-layout').getAttribute('data-resource-maximized'), 'false');
  report.checks.push('side opening collapses navigation before the conversation; resize never automatically maximizes');
  await openPath('guide.md');
  await page.setViewportSize({ width: 760, height: 900 });
  await until(() => page.locator('.bot-resource-layout').getAttribute('data-resource-compact'), value => value === 'true');
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  assert.equal(await draft.inputValue(), 'COMPOSER_DRAFT_OK');
  await page.getByRole('button', { name: '返回资源', exact: true }).click();
  await page.locator('.resource-document[data-active="true"] h1').filter({ hasText: 'DOCUMENT_BODY_OK' }).waitFor();
  await checkShell('compact');
  assert.equal(await page.evaluate(() => document.documentElement.scrollLeft), 0);
  assert.equal(await page.evaluate(() => document.body.clientWidth), 760);
  await shot('workspace-compact');
  await openLauncher();
  await checkShell('compact-launcher');
  await shot('workspace-compact-launcher');
  report.checks.push('compact view returns to the same resource and Composer draft');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await panel.getByRole('button', { name: '收起工作区', exact: true }).click();
  await until(() => page.evaluate(() => document.querySelector('.bot-resource-primary')?.contains(document.activeElement)), Boolean);
  await page.locator('.bot-row').nth(1).click();
  await until(() => page.locator('.bot-resource-layout').getAttribute('data-resource-open'), value => value === 'false');
  await until(() => workspaceButton.isEnabled(), Boolean); await workspaceButton.click();
  assert.equal(await panel.getByRole('tab').filter({ hasText: 'guide.md' }).count(), 0);
  report.checks.push('ordinary Bot switch starts collapsed and does not inherit another Bot resource tabs');
  assert.deepEqual(snapshotFiles(project), filesBefore); assert.deepEqual(snapshotFiles(knowledge), knowledgeBefore);
  assert.deepEqual(snapshotFiles(taskTree), taskBefore); assert.deepEqual(readFileSync(taskIndexPath), taskIndexBefore);
  assert.deepEqual(readFileSync(path.join(project, '.git/index')), indexBefore);
  assert.equal(execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), endCommit);
  report.checks.push('all resource interactions preserve fixture files, Git index and current commit');
  assert.deepEqual(report.pageErrors, []);
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = error.stack; process.exitCode = 1;
  if (page) report.failureGeometry = await page.evaluate(() => [...document.querySelectorAll('html, body, #root, .app-layout, .bot-resource-layout, .resource-navigation-bar, .resource-workspace, .resource-tabs')].map(el => ({ name: el.className || el.tagName,
    scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, width: el.clientWidth, left: el.getBoundingClientRect().left, overflow: getComputedStyle(el).overflow }))).catch(() => []);
  if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
} finally {
  if (handle) report.ownedStop = await owned.stop({ handleId: handle, reason: 'owned' });
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  writeFileSync(path.join(root, 'main.log'), logs.join(''));
  writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
