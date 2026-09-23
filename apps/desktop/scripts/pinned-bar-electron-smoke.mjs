// Isolated, real Electron main/preload + production dist. No user's app/webview attachment.
// Conversation history is seeded test data; no provider requests or tool execution are simulated.
// Run after `pnpm --filter @peer-agent/desktop build`.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConversationStore } from '../../../packages/conversation-store/src/index.mjs';
import { checkMonitorGlassPixels } from './task-monitor-glass-pixels.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '../..');
const artifactParent = path.join(repo, '.peer-preview');
await mkdir(artifactParent, { recursive: true });
const root = await mkdtemp(path.join(artifactParent, 'pinned-electron-'));
const home = path.join(root, 'data');
const workspace = path.join(root, 'workspace');
await mkdir(home, { recursive: true });
await mkdir(workspace, { recursive: true });
const store = createConversationStore({ storeDir: path.join(home, 'conversations') });
const conversation = store.createConversation({ title: 'Pinned bar acceptance / 置顶验收', workspacePath: workspace });
const prompts = ['第一轮：核对置顶条随消息列居中', '第二轮：监控栏切换后不遮挡当前问题', '第三轮：真实 Electron 生产构建验收'];
for (const [i, content] of prompts.entries()) {
  store.appendMessage(conversation.id, { id: `pin-user-${i}`, role: 'user', content, timestamp: Date.now() + i * 2 });
  store.appendMessage(conversation.id, { id: `pin-assistant-${i}`, role: 'assistant', timestamp: Date.now() + i * 2 + 1,
    content: Array.from({ length: 45 }, (_, j) => `验收段落 ${j + 1}：这是隔离测试会话的数据，不是真实模型输出。观察滚动、消息列与置顶条的对齐关系。`).join('\n\n') });
}
const digest = (data) => createHash('sha256').update(data).digest('hex');
const cssFiles = (await readdir(path.join(desktop, 'dist/assets'))).filter((name) => name.endsWith('.css'));
assert.ok(cssFiles.length, 'production CSS exists; build desktop first');
const assets = await Promise.all(cssFiles.map(async (name) => ({ name, sha256: digest(await readFile(path.join(desktop, 'dist/assets', name))) })));
const indexUrl = pathToFileURL(path.join(desktop, 'dist/index.html')).href;
const sourcePath = path.join(desktop, 'renderer/src/chat/styles/chat-surface.css');
const identity = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  sourceSha256: digest(await readFile(sourcePath)), assets, indexUrl, platform: process.platform, arch: process.arch,
  scope: 'real Electron source main/preload and production dist; not a signed installed release' };
await writeFile(path.join(root, 'build-identity.json'), JSON.stringify(identity, null, 2));
const entry = path.join(root, 'entry.mjs');
await writeFile(entry, `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(path.join(root, 'chromium'))});\napp.setPath('home', ${JSON.stringify(root)});\nawait import(${JSON.stringify(pathToFileURL(path.join(desktop, 'electron/main/main.mjs')).href)});\n`);
const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, PEER_AGENT_HOME: home, PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1' };
const require = createRequire(path.join(desktop, 'package.json'));
const results = [], errors = [], logs = [];
let app, page, passed = false;
const deadline = setTimeout(() => { console.error('PINNED_DEADLINE', root); app?.process().kill('SIGTERM'); }, 180000);
console.log('PINNED_ROOT', root);
try {
  app = await electron.launch({ executablePath: require('electron'), args: [entry], env, timeout: 25000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (data) => logs.push(data.toString()));
  for (let i = 0; i < 150 && !page; i++) {
    page = app.windows().find((window) => window.url() === indexUrl);
    if (!page) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(page, 'real app loaded production dist/index.html');
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(String(error)));
  identity.runtime = await app.evaluate(({ app }) => ({ versions: process.versions, packaged: app.isPackaged, userData: app.getPath('userData'), home: app.getPath('home') }));
  await writeFile(path.join(root, 'build-identity.json'), JSON.stringify(identity, null, 2));
  assert.equal(identity.runtime.userData, path.join(root, 'chromium'));
  const row = page.locator(`[data-conversation-id="${conversation.id}"]`);
  await row.waitFor();
  const workspaceRow = row.locator('xpath=ancestor::div[contains(@class,"sidebar-workspace-node")][1]').locator('.sidebar-workspace-row').first();
  if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click();
  await row.click();
  await page.locator('.chat-task-monitor-toggle').waitFor();
  const toggle = page.locator('.chat-task-monitor-toggle');
  const pin = page.locator('.current-turn-context');
  const setMonitor = async (open) => {
    if ((await toggle.getAttribute('aria-expanded') === 'true') !== open) await toggle.click();
    await page.locator('.task-monitor-rail').waitFor({ state: open ? 'visible' : 'detached' });
    await page.waitForTimeout(300);
  };
  const setWorkbench = async (open) => {
    if ((await page.locator('.workbench-panel--open').count() > 0) !== open) await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Backslash' : 'Control+Backslash');
    await page.locator('.workbench-panel--open').waitFor({ state: open ? 'visible' : 'detached' });
    await page.waitForTimeout(350);
  };
  const scrollToTurn = async (index) => {
    await page.locator('.chat-thread').evaluate((thread, index) => {
      const turn = thread.querySelectorAll('[data-chat-turn-id]')[index];
      if (!turn) throw new Error('missing fixture turn ' + index);
      thread.scrollTop += turn.getBoundingClientRect().top - thread.getBoundingClientRect().top + 400;
      thread.dispatchEvent(new Event('scroll'));
    }, index);
    await pin.waitFor();
    await page.waitForFunction((text) => document.querySelector('.current-turn-context-text')?.textContent === text, prompts[index]);
    await page.waitForTimeout(150);
  };
  const measure = () => page.evaluate(() => {
    const rect = (element) => { if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
    const surface = document.querySelector('.chat-surface');
    const pin = document.querySelector('.current-turn-context');
    const style = getComputedStyle(surface);
    const card = document.querySelector('.task-monitor-card');
    const rail = document.querySelector('.task-monitor-rail');
    const p = rect(pin), c = rect(card);
    const overlap = p && c && Math.min(p.right, c.right) > Math.max(p.x, c.x) && Math.min(p.bottom, c.bottom) > Math.max(p.y, c.y);
    const front = overlap ? document.elementFromPoint((Math.max(p.x, c.x) + Math.min(p.right, c.right)) / 2, (Math.max(p.y, c.y) + Math.min(p.bottom, c.bottom)) / 2) : null;
    return { viewport: { w: innerWidth, h: innerHeight }, surface: rect(surface), pin: p,
      thread: rect(document.querySelector('.chat-thread')), composer: rect(document.querySelector('.chat-composer-wrap')),
      messageRail: rect(document.querySelector('.message-rail')), card: c, rail: rect(rail),
      workbench: rect(document.querySelector('.workbench-panel--open')), paddingRight: parseFloat(style.paddingRight), paddingTop: parseFloat(style.paddingTop),
      pinZ: pin ? Number(getComputedStyle(pin).zIndex) : null, railZ: rail ? Number(getComputedStyle(rail).zIndex) : null,
      overlayHit: !!front && !!card?.contains(front), scrollTop: document.querySelector('.chat-thread').scrollTop,
      maxWidth: pin ? getComputedStyle(pin).maxWidth : null, text: pin?.textContent,
      css: [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.href) };
  });
  const sameLayout = (actual, expected, name) => {
    for (const part of ['surface', 'pin', 'thread', 'composer', 'messageRail', 'workbench']) {
      assert.equal(!!actual[part], !!expected[part], `${name}: ${part} presence`);
      if (actual[part]) for (const axis of ['x', 'y', 'w', 'h']) {
        assert.ok(Math.abs(actual[part][axis] - expected[part][axis]) < 1, `${name}: ${part}.${axis} moved (${expected[part][axis]} -> ${actual[part][axis]})`);
      }
    }
    assert.ok(Math.abs(actual.scrollTop - expected.scrollTop) < 1, `${name}: scroll position moved`);
  };
  for (const width of [1440, 1040]) {
    await app.evaluate(({ BrowserWindow }, { indexUrl, width }) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === indexUrl);
      window.setContentSize(width, 900);
      window.show();
    }, { indexUrl, width });
    for (const workbenchOpen of [false, true]) {
      await setWorkbench(workbenchOpen);
      for (const monitorOpen of [false, true]) {
        const name = `${width}-workbench-${workbenchOpen}-monitor-${monitorOpen}`;
        // Establish the closed geometry before opening, not after scrolling behind an overlay.
        await setMonitor(false);
        const threadBox = await page.locator('.chat-thread').boundingBox();
        await page.mouse.move(threadBox.x + threadBox.width / 2, threadBox.y + threadBox.height / 2);
        await page.mouse.wheel(0, -100000);
        await page.waitForFunction(() => document.querySelector('.chat-thread').scrollTop < 1);
        await pin.waitFor({ state: 'detached' });
        await scrollToTurn(0);
        const closed = await measure();
        await setMonitor(monitorOpen);
        const geometry = await measure();
        const { pin: p, surface: s, card: c } = geometry;
        geometry.centerError = Math.abs((p.x + p.right) / 2 - (s.x + (s.w - geometry.paddingRight) / 2));
        const overlaps = (a, b) => b && Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
        const screenshot = path.join(root, name + '.png');
        await page.screenshot({ path: screenshot });
        const narrow = s.w <= 640;
        results.push({ name, mode: narrow ? 'overlay' : 'side', closed, geometry, screenshot, passed: false });
        assert.ok(geometry.centerError < 2, `${name}: center error ${geometry.centerError}`);
        assert.ok(p.w > 0 && p.x >= s.x - 1 && p.right <= s.right + 1, `${name}: pinned within surface`);
        if (narrow) {
          sameLayout(geometry, closed, name);
          if (monitorOpen) {
            assert.equal(geometry.paddingRight, 0, `${name}: no side reservation`);
            assert.equal(geometry.paddingTop, 0, `${name}: no top reservation`);
            assert.ok(overlaps(p, c) && geometry.overlayHit, `${name}: overlay must paint above pinned content`);
            assert.ok(geometry.railZ > geometry.pinZ, `${name}: overlay layer above pin`);
            assert.ok(c.x >= s.x && c.right <= s.right && c.bottom <= s.bottom, `${name}: overlay within conversation`);
          }
        } else {
          assert.ok(!overlaps(p, c), `${name}: side monitor must not cover pin`);
          if (monitorOpen) {
            assert.ok(geometry.paddingRight > 0 && geometry.thread.w < closed.thread.w, `${name}: reserve side space`);
            assert.equal(geometry.thread.y, closed.thread.y, `${name}: no vertical displacement`);
          }
        }
        assert.ok(!overlaps(p, geometry.workbench), `${name}: pinned overlaps Workbench`);
        assert.ok(geometry.css.some((url) => assets.some(({ name }) => url.endsWith('/' + name))), 'loaded verified production CSS');
        if (monitorOpen && narrow) {
          await page.locator('.task-monitor-close').click();
          await page.locator('.task-monitor-rail').waitFor({ state: 'detached' });
          sameLayout(await measure(), closed, `${name}: after close`);
        }
        await scrollToTurn(1);
        assert.ok((await pin.innerText()).includes(prompts[1]), `${name}: correct current turn after scrolling`);
        results.at(-1).passed = true;
        console.log('PINNED_PASS', name, JSON.stringify({ conversationWidth: s.w, centerError: geometry.centerError, pin: p, card: c }));
      }
    }
  }
  assert.equal(results.length, 8);
  assert.ok(results.some(({ geometry: g }) => g.surface.w <= 640 && g.card), 'real narrow conversation exercises overlay card');
  // Resize with the monitor still open: side card ↔ overlay must not reset its state.
  await setWorkbench(true);
  await setMonitor(true);
  for (const width of [1440, 1040]) {
    await app.evaluate(({ BrowserWindow }, { indexUrl, width }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === indexUrl).setContentSize(width, 900);
    }, { indexUrl, width });
    await page.waitForTimeout(400);
    const resized = await measure();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'resize keeps monitor open');
    if (resized.pin) assert.equal(resized.pin.y, resized.surface.y + 40, 'resize never stacks pin below card');
    assert.equal(resized.paddingTop, 0, 'resize never reserves top space');
    if (resized.surface.w <= 640) {
      assert.equal(resized.paddingRight, 0);
      assert.ok(resized.card && resized.railZ > 30, 'resized narrow card is on overlay layer');
      if (resized.pin) assert.ok(resized.overlayHit, 'resized narrow card overlays pinned content');
      await setMonitor(false);
      sameLayout(await measure(), resized, 'close after resize to narrow');
      await setMonitor(true);
    } else {
      assert.ok(resized.paddingRight > 0 && !resized.overlayHit, 'resized wide card reserves side space');
    }
  }
  console.log('PINNED_RESIZE_PASS side -> overlay, open state preserved');
  await setWorkbench(false);
  await setMonitor(true);
  await scrollToTurn(0);
  await toggle.click();
  await toggle.click();
  await page.locator('.task-monitor-rail').waitFor();
  await page.waitForTimeout(600);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'rapid reopen survives old exit timer');
  await page.reload();
  await row.waitFor();
  if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click();
  await row.click();
  await page.locator('[data-chat-turn-id]').first().waitFor();
  const restoredThread = await page.locator('.chat-thread').boundingBox();
  await page.mouse.move(restoredThread.x + restoredThread.width / 2, restoredThread.y + restoredThread.height / 2);
  await page.mouse.wheel(0, -100000);
  await page.waitForFunction(() => document.querySelector('.chat-thread').scrollTop < 1);
  await scrollToTurn(0);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'reopening restored history has no stale open monitor');
  const materials = [];
  // Theme attribute exercises the production CSS tokens without changing stored preferences.
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    for (const workbenchOpen of [false, true]) {
      await setMonitor(false);
      await setWorkbench(workbenchOpen);
      await setMonitor(true);
      const material = await page.locator('.task-monitor-card').evaluate((card) => {
        const style = getComputedStyle(card);
        return { background: style.backgroundColor, filter: style.backdropFilter,
          width: card.closest('.chat-surface').getBoundingClientRect().width };
      });
      if (material.width <= 640) {
        assert.match(material.filter, /blur\(24px\).*saturate/);
        assert.match(material.background, /rgba\(/, 'glass background must be translucent');
      } else assert.equal(material.filter, 'none', 'wide side card unchanged');
      const screenshot = path.join(root, `material-${theme}-${workbenchOpen ? 'overlay' : 'side'}.png`);
      await page.screenshot({ path: screenshot });
      const pixels = material.width <= 640 ? await checkMonitorGlassPixels(page, root, theme) : [];
      materials.push({ theme, ...material, screenshot, pixels });
    }
  }
  await writeFile(path.join(root, 'materials.json'), JSON.stringify(materials, null, 2));
  console.log('MATERIAL_PASS', JSON.stringify(materials));
  assert.equal(errors.length, 0, `renderer exceptions: ${errors.join('\n')}`);
  assert.equal(digest(await readFile(sourcePath)), identity.sourceSha256, 'source unchanged throughout validation');
  passed = true;
  console.log('PINNED_ELECTRON_PASS', root);
} catch (error) {
  await writeFile(path.join(root, 'failure.txt'), String(error.stack ?? error));
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    await writeFile(path.join(root, 'failure-dom.txt'), await page.locator('body').innerText()).catch(() => {});
  }
  throw error;
} finally {
  clearTimeout(deadline);
  await writeFile(path.join(root, 'results.json'), JSON.stringify({ passed, identity, results, errors }, null, 2));
  await writeFile(path.join(root, 'main.log'), logs.join(''));
  await app?.close().catch(() => {});
}
