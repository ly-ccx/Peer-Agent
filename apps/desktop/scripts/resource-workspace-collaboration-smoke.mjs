/** R7–R10: real Electron, scoped IPC, SQLite, local Grant/Provider/Evidence and disposable files only. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createGoalPlanStore } from '@peer-agent/runtime-node';
import { seedBotShellHome } from './seed-bot-shell-home.mjs';
import { createOwnedProcessRegistry } from './lab-process-identity.mjs';

const source = fileURLToPath(new URL('../../..', import.meta.url)), root = mkdtempSync(path.join(tmpdir(), 'peer-resource-collab-')), home = path.join(root, 'data');
const fixture = seedBotShellHome({ home, scale: { bots: 2, messages: 0, inboxEvents: 0, memories: 0 } });
const bot = fixture.bots[0], theme = process.argv.includes('--dark') ? 'dark' : 'light';
const settingsPath = path.join(home, 'settings.json'), settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
settings.appearance = { mode: theme }; writeFileSync(settingsPath, JSON.stringify(settings));
const file = path.join(bot.path, 'collaboration.md'), untouched = path.join(bot.path, 'existing-work.txt');
const base = '# 协作验收文档\n\n这是保留的原始正文。\n', proposed = '# 协作验收文档\n\n这是本次明确提交的正文。\n', later = proposed + '\n提交后继续输入的草稿，不能被旧回执覆盖。\n';
writeFileSync(file, base); writeFileSync(untouched, 'EXISTING_RESULT_DO_NOT_REPLAY');
const git = (...args) => execFileSync('git', ['-C', bot.path, ...args], { encoding: 'utf8' }).trim();
git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Collaboration Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'synthetic baseline');
const conversation = path.join(home, 'conversations', bot.conversationId + '.jsonl'), originalHistory = readFileSync(conversation);
const evidenceRef = 'tool-result://collaboration-fixture', artifactRef = pathToFileURL(file).href;
createGoalPlanStore({ storeDir: path.join(home, 'goal-plans') }).recordEvidenceRefs({ evidenceRefs: [evidenceRef], conversationId: bot.conversationId,
  capabilityId: 'local.file.read', toolName: 'read_file', bodyPreview: { kind: 'file', text: 'Synthetic canonical evidence body' },
  userArtifacts: [{ kind: 'file', ref: artifactRef, path: file, label: '协作验收文档' }] });
const entry = path.join(root, 'entry.mjs'); writeFileSync(entry, `import {app} from 'electron';app.setPath('userData',${JSON.stringify(path.join(root, 'chromium'))});await import(${JSON.stringify(pathToFileURL(path.join(source, 'apps/desktop/electron/main/main.mjs')).href)});`);
const report = { root, theme, synthetic: true, checks: [], screenshots: [], pageErrors: [], scope: 'Production Electron main/preload/renderer + real temporary files, local SQLite/permissions/Provider. No real model, personal task or installed-build claim.' };
const owned = createOwnedProcessRegistry(), logs = []; let app, handle, page, server;
const until = async (read, accept, label, timeout = 18000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 40)); } throw Error(`Timed out: ${label}`); };
const panel = () => page.locator('.resource-workspace'), active = () => page.locator('.resource-document[data-active="true"]'), editor = () => active().locator('.resource-editor');
const shot = async (name, target = page) => { await until(() => target.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length), n => n === 0, 'finite motion');
  const output = path.join(root, `${theme}-${name}.png`); await target.screenshot({ path: output }); report.screenshots.push({ name, path: output, sha256: createHash('sha256').update(readFileSync(output)).digest('hex') }); };
const open = async target => { await panel().getByRole('button', { name: '新标签页', exact: true }).click(); await page.locator('.resource-address input').fill(target); await page.locator('.resource-address input').press('Enter'); };
const state = async () => page.evaluate(async workspaceId => window.peerAgent.resourceEdits.list({ workspaceId }), bot.workspaceId);
try {
  const env = { ...process.env, PEER_AGENT_HOME: home, PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1', PEER_WORKSPACE_ROOT: bot.path };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; delete env.PEER_KNOWLEDGE_ROOT;
  app = await _electron.launch({ args: [entry], env, cwd: path.join(source, 'apps/desktop'), timeout: 30000 }); handle = owned.register({ process: app.process(), close: () => app.close() });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', data => logs.push(String(data)));
  page = await until(async () => app.windows().find(w => w.url().includes('/dist/index.html') && !w.url().includes('window=')), Boolean, 'main window');
  page.on('pageerror', error => report.pageErrors.push(error.message)); page.setDefaultTimeout(15000); await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator('.bot-row').filter({ hasText: 'project-000' }).click(); await page.locator('.bot-main textarea').first().fill('主对话未发送的输入');
  await page.getByRole('button', { name: '工作区', exact: true }).click(); await open(file);
  await panel().getByRole('separator', { name: '拖拽调整工作台宽度', exact: true }).focus();
  await panel().getByRole('separator', { name: '拖拽调整工作台宽度', exact: true }).press('End');
  await active().getByRole('heading', { name: '协作验收文档', exact: true }).waitFor();
  const delivery = await page.evaluate(async ({ evidenceRef, workspaceId }) => window.peerAgent.projectAgentReadEvidence({ evidenceRef, context: { workspaceId } }), { evidenceRef, workspaceId: bot.workspaceId });
  assert.equal(delivery.deliveryStatus, 'available'); assert.equal(delivery.deliveries[0].artifactRef, artifactRef);
  const denied = await page.evaluate(async ({ evidenceRef, workspaceId }) => window.peerAgent.projectAgentReadEvidence({ evidenceRef, context: { workspaceId } }), { evidenceRef, workspaceId: fixture.bots[1].workspaceId });
  assert.equal(denied.deliveryStatus, 'scope_denied'); report.checks.push('R7 actual canonical evidence projection and other-Bot denial through main preload/IPC');

  await active().locator('.resource-document-body p').first().evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
  await active().getByRole('button', { name: '针对这段提问', exact: true }).click();
  await page.locator('.bot-main .bot-resource-feedback-card').waitFor();
  assert.equal(readFileSync(file, 'utf8'), base); assert.equal(await page.locator('.bot-main textarea').first().inputValue(), '主对话未发送的输入');
  await shot('01-selected-reference');
  report.checks.push('R8 real DOM selection persists a fixed recipient/version input reference, preserving Composer text; no send or file write');

  await active().getByRole('button', { name: '编辑草稿', exact: true }).click();
  const input = () => editor().getByRole('textbox', { name: '草稿原文', exact: true });
  await input().waitFor(); await until(() => input().getAttribute('readonly'), value => value === null, 'writer acquired');
  await input().fill(proposed); await editor().getByRole('button', { name: '保存草稿', exact: true }).click();
  await until(state, value => value.ok && value.drafts[0]?.revision === 1, 'draft saved'); assert.equal(readFileSync(file, 'utf8'), base);
  await shot('02-local-draft');
  const firstDraft = (await state()).drafts[0];
  await page.locator('.bot-row').filter({ hasText: 'project-001' }).click(); await page.locator('.bot-row').filter({ hasText: 'project-000' }).click();
  await page.getByRole('button', { name: '工作区', exact: true }).click();
  const draftTab = panel().getByRole('tab').filter({ hasText: 'collaboration.md' }).last(); await draftTab.click();
  await until(() => input().inputValue(), value => value === proposed, 'same draft after Bot round trip');
  const acquire = editor().getByRole('button', { name: '取得编辑权', exact: true });
  if (await acquire.count()) await acquire.click();
  await until(() => input().getAttribute('readonly'), value => value === null, 'writer reacquired after view restoration');
  report.checks.push('R9 actual saved revision survives Bot switch; source file and later task history are untouched');

  await editor().getByRole('button', { name: '提交当前稿到原文件', exact: true }).click();
  await editor().getByRole('button', { name: '允许本次写入', exact: true }).waitFor(); assert.equal(readFileSync(file, 'utf8'), base);
  await input().fill(later); await editor().getByRole('button', { name: '保存草稿', exact: true }).click();
  await until(state, value => value.ok && value.drafts.find(d => d.id === firstDraft.id)?.revision === 2, 'later draft saved while permission waits');
  const disclosureLayout = await editor().locator('.resource-submission summary').first().evaluate(summary => {
    const icon = summary.querySelector('svg').getBoundingClientRect(), text = document.createRange(); text.selectNodeContents(summary.lastChild);
    const label = text.getBoundingClientRect(); return Math.abs((icon.top + icon.bottom) / 2 - (label.top + label.bottom) / 2);
  });
  assert.ok(disclosureLayout < 4, 'disclosure icon and title share one aligned row');
  await shot('03-permission-with-later-input');
  await editor().getByRole('button', { name: '允许本次写入', exact: true }).click();
  const applied = await until(state, value => value.ok && value.operations.some(op => op.receipt?.outcome === 'applied'), 'real conditional write');
  assert.equal(readFileSync(file, 'utf8'), proposed); assert.equal(await input().inputValue(), later);
  const operation = applied.operations.find(op => op.receipt?.outcome === 'applied');
  assert.equal(operation.draftRevision, 1);
  await editor().getByText('提交稿与实际结果', { exact: true }).click(); await editor().getByRole('button', { name: '实际写入结果', exact: true }).click();
  await editor().getByRole('heading', { name: '实际 Provider 差异预览', exact: true }).waitFor(); await shot('04-applied-result');
  const facts = await page.evaluate(async ({ workspaceId, draftId, requestId }) => {
    const api = window.peerAgent.resourceEdits, resumed = await api.resume({ workspaceId, draftId, requestId: crypto.randomUUID() });
    if (!resumed.ok) return resumed;
    try { return { actual: await api.readExecution({ handle: resumed.handle, requestId }), fixed: await api.readSubmission({ handle: resumed.handle, requestId }), reconcile: await api.reconcileSubmission({ handle: resumed.handle, requestId }) }; }
    finally { await api.close(resumed.handle); }
  }, { workspaceId: bot.workspaceId, draftId: firstDraft.id, requestId: operation.requestId });
  assert.equal(facts.actual.ok, true); assert.equal(facts.actual.record.result.evidence.toolCallId, facts.actual.record.call.toolCallId);
  assert.equal(facts.fixed.text, proposed); assert.equal(facts.reconcile.operation.receipt.outcome, 'applied'); assert.equal(readFileSync(file, 'utf8'), proposed);
  report.checks.push('R10 actual UI permission -> local conditional Provider -> original Grant/ToolCall/Evidence; fixed revision writes once; later input and explicit reconcile do not replay it');

  writeFileSync(file, '# 外部的新版本\n');
  await editor().getByRole('button', { name: '比较', exact: true }).click(); await editor().getByRole('button', { name: '读取当前文件比较', exact: true }).click();
  await editor().getByRole('heading', { name: '明确读取的当前文件', exact: true }).waitFor(); await shot('05-three-way-comparison');
  assert.equal(readFileSync(file, 'utf8'), '# 外部的新版本\n'); assert.equal(await input().count(), 0);
  report.checks.push('R9/R10 external change is compared against preserved base/draft without automatic overwrite or rebase');

  await editor().getByRole('button', { name: '以当前文件另建草稿', exact: true }).click();
  await until(() => input().inputValue(), value => value === '# 外部的新版本\n', 'separate new-base editor mounted');
  await editor().getByRole('button', { name: '取得编辑权', exact: true }).click();
  await until(() => input().getAttribute('readonly'), value => value === null, 'separate draft writer acquired');
  await input().fill('# 另一份明确修改\n'); await editor().getByRole('button', { name: '保存草稿', exact: true }).click();
  await until(() => editor().getByRole('button', { name: '提交当前稿到原文件', exact: true }).isEnabled(), Boolean, 'new-base draft saved');
  await editor().getByRole('button', { name: '提交当前稿到原文件', exact: true }).click(); await editor().getByRole('button', { name: '拒绝', exact: true }).click();
  await until(state, value => value.ok && value.operations.some(op => op.receipt?.outcome === 'denied'), 'denial receipt');
  assert.equal(readFileSync(file, 'utf8'), '# 外部的新版本\n'); await shot('05b-denied-preserved');
  await editor().getByRole('button', { name: '提交当前稿到原文件', exact: true }).click();
  await editor().getByRole('button', { name: '取消本次提交', exact: true }).click();
  await until(state, value => value.ok && value.operations.some(op => op.receipt?.outcome === 'cancelled'), 'cancellation receipt');
  assert.equal(readFileSync(file, 'utf8'), '# 外部的新版本\n');
  await editor().getByRole('button', { name: '提交当前稿到原文件', exact: true }).click();
  await editor().getByRole('button', { name: '允许本次写入', exact: true }).waitFor(); writeFileSync(file, '# 授权等待时外部更新\n');
  await editor().getByRole('button', { name: '允许本次写入', exact: true }).click();
  await until(state, value => value.ok && value.operations.some(op => op.receipt?.outcome === 'conflict'), 'permission-late version conflict');
  assert.equal(readFileSync(file, 'utf8'), '# 授权等待时外部更新\n'); await shot('05c-conflict-preserved');
  report.checks.push('R10 real denial/cancellation have no file effect; version changes during permission yield conflict without overwrite');

  const nativeResult = await page.evaluate(async ({ workspaceId, file }) => window.peerAgent.resourceWindowOpen({ sourceTabId: 'fixture-explicit-copy', resource: { kind: 'document', reference: { workspaceId, path: file }, mode: 'preview' } }), { workspaceId: bot.workspaceId, file });
  assert.equal(nativeResult.ok, true);
  const native = await until(async () => app.windows().find(w => w.url().includes('window=resource')), Boolean, 'native document copy'); native.on('pageerror', error => report.pageErrors.push(error.message));
  await native.getByRole('heading', { name: '授权等待时外部更新', exact: true }).waitFor(); await shot('06-native-document', native);
  await native.getByRole('button', { name: '编辑草稿', exact: true }).click(); const nativeInput = native.getByRole('textbox', { name: '草稿原文', exact: true }); await nativeInput.waitFor();
  await until(() => nativeInput.getAttribute('readonly'), value => value === null, 'native writer');
  await nativeInput.dispatchEvent('compositionstart'); await nativeInput.fill('保留原生组合输入');
  await native.evaluate(() => window.peerResource.close({ viewId: 'invalid', windowId: 'invalid', generation: 1 })).then(result => assert.equal(result.ok, false));
  await app.evaluate(({ BrowserWindow }) => { const target = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=resource')); target.close(); });
  await native.getByText(/窗口已保留/).first().waitFor(); assert.equal(await nativeInput.inputValue(), '保留原生组合输入'); await shot('07-native-close-preserved', native);
  await nativeInput.dispatchEvent('compositionend'); await native.getByRole('button', { name: '保存草稿', exact: true }).click();
  await native.getByRole('button', { name: '关闭此窗口', exact: true }).click(); await until(() => app.windows().some(w => w.url().includes('window=resource')), value => !value, 'safe native close');
  report.checks.push('R5w1/R9 native sender isolation, composition/save-blocked close retains input, safe retry closes only that view');

  for (const kind of ['directory', 'comparison']) {
    const opened = await page.evaluate(async ({ kind, workspaceId, root }) => window.peerAgent.resourceWindowOpen({ resource: kind === 'directory'
      ? { kind, reference: { workspaceId, path: root, kind: 'directory' } }
      : { kind, reference: { workspaceId, path: root, kind: 'directory' }, fromRef: 'HEAD', comparison: 'working' } }), { kind, workspaceId: bot.workspaceId, root: bot.path });
    assert.equal(opened.ok, true); const child = await until(async () => app.windows().find(w => w.url().includes('window=resource')), Boolean, `native ${kind}`);
    child.on('pageerror', error => report.pageErrors.push(error.message));
    if (kind === 'directory') await child.locator('.workbench-tree-row').filter({ hasText: 'collaboration.md' }).waitFor();
    else await child.locator('.diff-line--add').first().waitFor();
    await shot(`08-native-${kind}`, child); await child.getByRole('button', { name: '关闭此窗口', exact: true }).click();
    await until(() => app.windows().some(w => w.url().includes('window=resource')), value => !value, 'native copy close');
  }
  report.checks.push('R5w1 actual native directory and Git comparison windows share scoped readers, render real content, and close independently');

  server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><title>独立网页验收</title><h1>真实网页副本</h1><input id="draft" aria-label="网页草稿">'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); await open(`http://127.0.0.1:${server.address().port}`);
  const guest = page.locator('webview.browser-webview[data-active="true"]');
  await until(() => guest.evaluate(wv => { try { return wv.getURL().startsWith('http://127.0.0.1:'); } catch { return false; } }), Boolean, 'loopback guest');
  await guest.evaluate(wv => wv.executeJavaScript('document.querySelector("#draft").value="原网页未发送输入"'));
  const guestId = await guest.evaluate(wv => wv.getWebContentsId());
  await panel().getByRole('button', { name: '另开网址副本', exact: true }).click();
  const browser = await until(async () => app.windows().find(w => w.url().includes('window=browser-resource')), Boolean, 'native browser copy');
  await until(() => browser.evaluate(async () => (await window.peerBrowserWindow.bootstrap()).state?.url), value => value?.startsWith('http://127.0.0.1:'), 'native copy navigation');
  await until(() => app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=browser-resource'));
    const child = win?.contentView.children.find(view => view.webContents);
    return child ? { bounds: child.getBounds(), text: await child.webContents.executeJavaScript('document.body?.innerText ?? ""') } : null;
  }), value => value?.bounds.width > 100 && value.bounds.height > 100 && value.text.includes('真实网页副本'), 'real native guest content and viewport');
  await shot('09-native-browser', browser);
  // Native WebContentsView is not part of the chrome renderer's DOM capture. Keep the guest's own unmodified pixels too.
  const guestPixels = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=browser-resource'));
    const child = win.contentView.children.find(view => view.webContents); return (await child.webContents.capturePage()).toPNG().toString('base64');
  });
  const guestShot = path.join(root, `${theme}-09b-native-browser-content.png`); writeFileSync(guestShot, Buffer.from(guestPixels, 'base64'));
  report.screenshots.push({ name: '09b-native-browser-content', path: guestShot, sha256: createHash('sha256').update(readFileSync(guestShot)).digest('hex'), scope: 'Actual WebContentsView pixels; separate from native chrome screenshot' });
  assert.equal(await guest.evaluate(wv => wv.getWebContentsId()), guestId);
  assert.equal(await guest.evaluate(wv => wv.executeJavaScript('document.querySelector("#draft").value')), '原网页未发送输入');
  await browser.getByRole('button', { name: '关闭此窗口', exact: true }).click();
  await until(() => app.windows().some(w => w.url().includes('window=browser-resource')), value => !value, 'browser copy close');
  report.checks.push('R5w2 actual WebContentsView address copy; original embedded guest identity and unsent form preserved');

  assert.equal(readFileSync(untouched, 'utf8'), 'EXISTING_RESULT_DO_NOT_REPLAY'); assert.deepEqual(readFileSync(conversation), originalHistory);
  assert.equal(readFileSync(file, 'utf8'), '# 授权等待时外部更新\n'); assert.equal(report.pageErrors.length, 0); report.ok = true;
} catch (error) { report.ok = false; report.failure = error.stack ?? String(error); if (page) await shot('failure').catch(() => {}); }
finally { if (handle) report.ownedStop = await owned.stop({ handleId: handle, reason: 'owned' }); if (server) await new Promise(resolve => server.close(resolve)); writeFileSync(path.join(root, 'electron.log'), logs.join('')); writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
if (!report.ok) process.exitCode = 1;
