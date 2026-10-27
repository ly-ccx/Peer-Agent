/** R5-02/03 + R5a + R6 combination: production Electron/IPC, disposable files, no model/user tasks. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { seedBotShellHome } from './seed-bot-shell-home.mjs';
import { createOwnedProcessRegistry } from './lab-process-identity.mjs';

const source = fileURLToPath(new URL('../../..', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'peer-resource-r5-r6-')), home = path.join(root, 'data');
const fixture = seedBotShellHome({ home, scale: { bots: 2, messages: 0, inboxEvents: 0, memories: 0 } });
const theme = process.argv.includes('--dark') ? 'dark' : 'light', settingsPath = path.join(home, 'settings.json');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8')); settings.appearance = { mode: theme }; writeFileSync(settingsPath, JSON.stringify(settings));
const project = fixture.bots[0].path;
// Deterministic native PNG fixture: real CRC/deflate bytes, not an image-admission stub.
const chunk = (kind, data) => {
  const body = Buffer.concat([Buffer.from(kind), data]), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); body.copy(result, 4);
  let crc = 0xffffffff; for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
};
const header = Buffer.alloc(13); header.writeUInt32BE(160); header.writeUInt32BE(96, 4); header[8] = 8; header[9] = 6;
const pixels = Buffer.alloc((160 * 4 + 1) * 96);
for (let y = 0; y < 96; y++) for (let x = 0; x < 160; x++) {
  const offset = y * (160 * 4 + 1) + 1 + x * 4; pixels.set(x < 80 ? [77,115,171,255] : [219,171,81,255], offset);
}
const imageBytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
let externalRequests = 0;
const server = createServer((req, res) => {
  if (req.url === '/image.png' || req.url === '/embedded') { externalRequests++; res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(imageBytes); }
  else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>组合网页</title><style>body{font:16px system-ui;color:CanvasText;background:Canvas;margin:24px}input{font:inherit;padding:8px;max-width:90%}</style><h1>测试网页</h1><label for="draft">网页草稿</label><p><input id="draft" aria-label="网页草稿"></p></html>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const put = (name, value) => { const target = path.join(project, name); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, value); };
put('history/guide.md', '# 历史正文\n\n[Nested](nested.md)\n'); put('history/nested.md', '# 历史嵌套正文\n');
put('source.ts', 'export const version = 1;\n');
for (let i = 0; i < 70; i++) put(`directory/branch/item-${String(i).padStart(2, '0')}.txt`, 'temporary fixture\n');
const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Resource Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'disposable baseline');
const commit = git('rev-parse', 'HEAD');
put('history/guide.md', '# 当前正文\n\n[Nested](nested.md)\n'); put('history/nested.md', '# 当前嵌套正文\n'); put('source.ts', 'export const version = 2;\n');
put('safe.html', `<script>window.__LOCAL_EXECUTED=true</script><img src="${url}/embedded">`);
put('safe.svg', `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="${url}/embedded"/></svg>`);
put('remote.md', `# 静态文档\n\n![外部图片](${url}/image.png)\n\n<script>window.__LOCAL_EXECUTED=true</script>\n`);
put('huge.txt', '\n'.repeat(50_000)); put('pixel.png', imageBytes);
const broken = Buffer.alloc(33); imageBytes.copy(broken, 0, 0, 33); put('broken.png', broken);
const now = new Date().toISOString(), conversationPath = path.join(home, 'conversations', fixture.bots[0].conversationId + '.jsonl');
const history = [{ id: 'combo-input', kind: 'user_input', role: 'user', content: '查看组合测试文档。', createdAt: now },
  { id: 'combo-reply', kind: 'agent_reply', role: 'assistant', replyTo: ['combo-input'], content: `已准备好临时文档：[查看正文](${path.join(project, 'history/guide.md')})`, createdAt: now }];
writeFileSync(conversationPath, history.map(item => JSON.stringify(item)).join('\n') + '\n');
const originalConversation = readFileSync(conversationPath), originalSource = readFileSync(path.join(project, 'source.ts'));
const entry = path.join(root, 'entry.mjs');
writeFileSync(entry, `import {app} from 'electron';\napp.setPath('userData',${JSON.stringify(path.join(root, 'chromium'))});\nawait import(${JSON.stringify(pathToFileURL(path.join(source, 'apps/desktop/electron/main/main.mjs')).href)});`);
const report = { root, theme, synthetic: true, checks: [], screenshots: [], pageErrors: [], stops: [], scope: 'Production main/preload/renderer. Local disposable fixture and loopback server; no real model, user task, personal profile or installed-build/release acceptance.' };
const registry = createOwnedProcessRegistry(), logs = []; let app, handle, page;
const until = async (read, accept, label, timeout = 15000) => { const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error(`Timed out: ${label}`); };
const settle = () => until(() => page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity && animation.playState === 'running').length), value => value === 0, 'finite animations');
const shot = async name => { await settle(); const target = path.join(root, `${theme}-${name}.png`); await page.screenshot({ path: target }); report.screenshots.push({ name, path: target, sha256: createHash('sha256').update(readFileSync(target)).digest('hex') }); };
const launch = async () => {
  const env = { ...process.env, PEER_AGENT_HOME: home, PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1', PEER_WORKSPACE_ROOT: project };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; delete env.PEER_KNOWLEDGE_ROOT;
  app = await _electron.launch({ args: [entry], env, cwd: path.join(source, 'apps/desktop'), timeout: 30000 });
  handle = registry.register({ process: app.process(), close: () => app.close() });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', chunk => logs.push(String(chunk)));
  page = await until(async () => app.windows().find(win => win.url().includes('/dist/index.html') && !win.url().includes('window=')), Boolean, 'main window', 30000);
  page.setDefaultTimeout(15000); page.on('pageerror', error => report.pageErrors.push(error.message)); await page.setViewportSize({ width: 1600, height: 1000 });
  await until(() => page.locator('html').getAttribute('data-theme'), value => value === theme, 'theme'); await page.locator('.bot-row').first().click();
};
const stop = async () => { if (handle) { report.stops.push(await registry.stop({ handleId: handle, reason: 'owned' })); handle = undefined; } };
const panel = () => page.locator('.resource-workspace'), active = () => page.locator('.resource-document[data-active="true"]'), body = () => active().locator('.resource-document-body');
const open = async target => { await panel().getByRole('button', { name: '新标签页', exact: true }).click();
  await page.locator('.resource-address input').fill(target); await page.locator('.resource-address input').press('Enter'); };
const read = reference => page.evaluate(reference => window.peerAgent.readFile('', undefined, undefined, reference), reference);
try {
  await launch(); await page.getByRole('button', { name: '工作区', exact: true }).click();
  const draft = () => page.locator('.bot-main textarea').first(); await draft().fill('主对话草稿保留');
  await open('./history/guide.md'); await body().getByRole('heading', { name: '当前正文', exact: true }).waitFor();
  await active().locator('.resource-document-history summary').click(); await active().getByRole('textbox', { name: '完整提交 SHA', exact: true }).fill(commit);
  await active().getByRole('button', { name: '打开历史版本', exact: true }).click(); await body().getByRole('heading', { name: '历史正文', exact: true }).waitFor();
  const metadata = await read({ workspaceId: fixture.bots[0].workspaceId, path: path.join(project, 'history/guide.md'), revision: { kind: 'git', commit } });
  assert.equal(metadata.ok, true); assert.equal(metadata.revision.commit, commit); assert.match(metadata.content, /历史正文/);
  await body().getByRole('link', { name: 'Nested', exact: true }).click(); await body().getByRole('heading', { name: '历史嵌套正文', exact: true }).waitFor();
  assert.ok((await active().innerText()).includes(commit)); await shot('01-history-nested');
  await active().getByRole('button', { name: '打开当前文件', exact: true }).click(); await body().getByRole('heading', { name: '当前嵌套正文', exact: true }).waitFor();
  const missing = await read({ workspaceId: fixture.bots[0].workspaceId, path: 'absent.md', revision: { kind: 'git', commit } }); assert.equal(missing.ok, false);
  report.checks.push('R5-02 actual Git blob, immutable commit, nested same-commit navigation, separate live tab and missing history failure');

  await page.getByRole('button', { name: '机器人设置', exact: true }).click();
  const slot = page.locator('.resource-details-slot'); await slot.getByRole('tab', { name: '设置', exact: true }).click();
  const nameInput = slot.locator('.bot-settings-name-row input'); await nameInput.waitFor(); await until(() => nameInput.isEnabled(), Boolean, 'Bot name loaded');
  await nameInput.fill('尚未保存的名字'); const originalInput = await nameInput.elementHandle();
  await panel().getByRole('button', { name: '浏览目录', exact: true }).click();
  await page.locator('.workbench-tree-row').filter({ hasText: /^history$/ }).waitFor();
  await panel().getByRole('button', { name: '返回机器人信息', exact: true }).click();
  assert.equal(await nameInput.inputValue(), '尚未保存的名字'); assert.equal(await originalInput.evaluate(el => el === document.querySelector('.resource-details-slot .bot-settings-name-row input')), true);
  assert.equal(await page.locator('.app-drawer-overlay:visible').count(), 0); assert.equal(await draft().inputValue(), '主对话草稿保留');
  await shot('02-details-draft-return'); report.checks.push('R5a settings and resource share one pane; one-step return preserves exact field DOM, unsaved name and main Composer; no overlay');

  await panel().getByRole('button', { name: '浏览目录', exact: true }).click();
  const row = name => page.locator('.workbench-tree-row').filter({ hasText: new RegExp(`^${name}$`) });
  await row('directory').click(); await row('branch').click(); await row('item-69.txt').waitFor();
  const tree = () => page.locator('.workbench-tree'); await tree().evaluate(el => { el.scrollTop = 440; el.dispatchEvent(new Event('scroll')); });
  await until(async () => JSON.parse(readFileSync(settingsPath, 'utf8')).workbench?.directorySessions?.[fixture.bots[0].workspaceId]?.readings, entries => entries?.some(entry => entry.expanded.includes('directory/branch')), 'directory metadata saved');
  await panel().getByRole('button', { name: '新标签页', exact: true }).click(); await panel().getByRole('button', { name: '浏览目录', exact: true }).click();
  await row('item-69.txt').waitFor(); await shot('03-directory-restored'); report.checks.push('R5-03 expanded directory branches persist and recover through the real host without opening the selected file');

  for (const name of ['safe.html', 'safe.svg']) { await open(`./${name}`); await body().locator('.source-line').first().waitFor();
    assert.equal(await body().locator('iframe,webview,object,img,script').count(), 0); assert.equal(externalRequests, 0); }
  await open('./remote.md'); await body().getByRole('button', { name: /打开外部图片/ }).waitFor();
  assert.equal(await body().locator('img,script').count(), 0); assert.equal(externalRequests, 0); await shot('04-static-markdown');
  await open('./huge.txt'); await until(() => body().locator('[data-source-line]').count(), count => count === 4000, 'bounded source');
  assert.ok((await active().innerText()).includes('50001')); report.checks.push('R6 local HTML/SVG never execute or request embeds; Markdown remote image is explicit; 50,001-line source bounded to 4,000 rows');

  await open('./pixel.png'); const image = body().locator('img.resource-raster-image'); await until(() => image.evaluate(el => el.complete && el.naturalWidth > 0), Boolean, 'native image decode');
  await body().getByRole('button', { name: '放大图片', exact: true }).click(); assert.ok((await body().innerText()).includes('125%'));
  await body().getByRole('button', { name: '恢复适应宽度', exact: true }).click(); await shot('05-raster');
  await open('./broken.png'); await body().getByRole('alert').filter({ hasText: '图片解码失败' }).waitFor();
  await body().getByRole('button', { name: '重新读取', exact: true }).click(); await body().getByRole('alert').filter({ hasText: '图片解码失败' }).waitFor();
  report.checks.push('R6 valid PNG native decoding and fit/zoom; truncated PNG produces local decoder failure and explicit retry');
  await open('./source.ts'); await active().getByRole('button', { name: 'Diff', exact: true }).click();
  await body().locator('.diff-line--add').waitFor(); assert.ok((await body().innerText()).includes('version = 2'));
  await shot('06-code-diff');
  git('update-index', '--chmod=+x', 'source.ts'); await active().getByRole('button', { name: '刷新', exact: true }).click();
  await body().getByRole('status').filter({ hasText: '元数据' }).waitFor(); assert.ok((await body().innerText()).includes('old mode'));
  assert.equal(await body().locator('.diff-gutter').count(), 0); await shot('06b-mode-diff-raw'); git('update-index', '--chmod=-x', 'source.ts');
  report.checks.push('R6 normal Git change renders real two-way hunk positions after document and image transitions');

  await open(url); const guest = () => page.locator('webview.browser-webview[data-active="true"]');
  await until(() => guest().evaluate(wv => { try { return wv.getURL().startsWith('http://127.0.0.1:'); } catch { return false; } }), Boolean, 'loopback guest');
  await guest().evaluate(wv => wv.executeJavaScript('document.querySelector("#draft").value="网页未提交草稿"'));
  const guestId = await guest().evaluate(wv => wv.getWebContentsId());
  await open('./history/guide.md'); await body().getByRole('heading', { name: '当前正文', exact: true }).waitFor();
  await panel().getByRole('button', { name: '打开网页视图', exact: true }).click(); assert.equal(await guest().evaluate(wv => wv.getWebContentsId()), guestId);
  assert.equal(await guest().evaluate(wv => wv.executeJavaScript('document.querySelector("#draft").value')), '网页未提交草稿');
  await shot('07-web-keepalive');
  await until(async () => JSON.parse(readFileSync(settingsPath, 'utf8')).workbench?.browserSessions, sessions => sessions && Object.values(sessions).some(session => session.tabs?.some(tab => tab.url?.startsWith(url))), 'browser address acknowledged on disk');
  await stop(); await launch(); await page.getByRole('button', { name: '工作区', exact: true }).click();
  await panel().getByRole('button', { name: '打开网页视图', exact: true }).click(); await page.locator('.browser-recovery-notice').waitFor();
  await until(() => guest().evaluate(wv => { try { return wv.getURL().startsWith('http://127.0.0.1:'); } catch { return false; } }), Boolean, 'reopened loopback guest');
  assert.equal(await guest().evaluate(wv => wv.executeJavaScript('document.querySelector("#draft").value')), '');
  await shot('08-web-url-recovery');
  const reopenedGuest = await guest().evaluate(wv => wv.getWebContentsId());
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).forcefullyCrashRenderer(), reopenedGuest);
  await page.locator('.browser-error').waitFor(); await page.locator('.browser-error-retry').click();
  await until(() => page.locator('.browser-error').count(), count => count === 0, 'explicit crashed guest recovery');
  await until(() => guest().evaluate(wv => wv.executeJavaScript('Boolean(document.querySelector("#draft"))')), Boolean, 'recovered guest DOM');
  await panel().getByRole('button', { name: '浏览目录', exact: true }).click(); await row('item-69.txt').waitFor();
  await until(() => tree().evaluate(el => el.scrollTop), value => Math.abs(value - 440) < 2, 'directory reading position after fresh process');
  assert.equal(await tree().locator('.workbench-tree-row[data-selected="true"]').innerText(), 'branch');
  await shot('09-directory-process-recovery');
  report.checks.push('R5-03 real guest crash has local failure and explicit recovery; fresh process restores directory branches, selection and exact 440px reading position');
  report.checks.push('R5-03 real guest retains form/identity while hidden; fresh Electron restores URL with a truthful notice, not the former form');
  assert.deepEqual(readFileSync(conversationPath), originalConversation); assert.deepEqual(readFileSync(path.join(project, 'source.ts')), originalSource);
  assert.deepEqual(report.pageErrors, []); report.checks.push('synthetic conversation and source bytes unchanged by UI; no model/task/replay; no renderer pageErrors'); report.ok = true;
} catch (error) {
  report.ok = false; report.failure = error.stack; process.exitCode = 1;
  if (page) { report.failureText = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
} finally { await stop(); await new Promise(resolve => server.close(resolve)); writeFileSync(path.join(root, 'main.log'), logs.join(''));
  writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
