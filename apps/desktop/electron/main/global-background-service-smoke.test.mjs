import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';

// Opt-in UI test: a display and the Desktop build are required. The default
// suite still exercises real HTTP services in global-background-tasks.test.mjs.
test('isolated Electron: projected service appears globally and UI stop releases its port', {
  skip: process.env.PEER_BACKGROUND_UI_SMOKE !== '1', timeout: 90_000,
}, async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'peer-background-ui-'));
  const env = { ...process.env, PEER_AGENT_HOME: home, PEER_BACKGROUND_SMOKE_HOME: home, PEER_BACKGROUND_SMOKE_NODE: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const ports = [];
  t.after(async () => {
    try { if (app) await app.evaluate(async () => globalThis.peerBackgroundSmoke.dispose()); }
    finally {
      try { await app?.close(); }
      finally { rmSync(home, { recursive: true, force: true }); }
    }
    for (const port of ports) {
      const probe = createServer();
      try { await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); }); }
      finally { await new Promise((resolve) => probe.close(resolve)); }
    }
  });
  app = await electron.launch({ args: [fileURLToPath(new URL('../../scripts/background-tasks-electron-fixture.mjs', import.meta.url))], env, timeout: 10_000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(12_000);
  const button = page.locator('.background-runtime-trigger');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [360, 1120]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 850), width);
      await page.waitForFunction((width) => innerWidth === width, width);
      const geometry = await page.locator('.chat-header').evaluate((el) => {
        const button = el.querySelector('.background-runtime-trigger');
        const entry = button.getBoundingClientRect();
        const search = el.querySelector('[aria-label="搜索"]').getBoundingClientRect();
        return { entry: { x: entry.x, y: entry.y, right: entry.right, bottom: entry.bottom, width: entry.width },
          searchX: search.x, text: button.textContent, overflow: el.scrollWidth - el.clientWidth };
      });
      assert.equal(await button.count(), 1);
      assert.equal(await page.locator('.sidebar-bottom .background-runtime-trigger').count(), 0);
      assert.equal(geometry.text, '');
      assert.ok(geometry.entry.width > 0 && geometry.entry.right <= geometry.searchX, `header icon before search: ${theme}/${width}`);
      assert.ok(geometry.entry.x >= 0 && geometry.entry.right <= width);
      assert.equal(geometry.overflow, 0);
      await button.click();
      const panel = page.getByRole('dialog');
      await panel.waitFor();
      const bounds = await panel.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= geometry.entry.bottom);
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await panel.waitFor({ state: 'hidden' });
    }
  }
  await button.click();
  await page.getByText('暂无后台运行', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  const id = await app.evaluate(() => globalThis.peerBackgroundSmoke.launch('source-A'));
  let row;
  for (let n = 0; n < 120; n++) {
    row = await app.evaluate((_, id) => globalThis.peerBackgroundSmoke.list().find((task) => task.taskId === id), id);
    if (row.listeners.length) break;
    await delay(50);
  }
  assert.ok(row.listeners.length, JSON.stringify(row));
  const port = row.listeners[0].port;
  ports.push(port);
  const url = `http://127.0.0.1:${port}/ui-proof`;
  assert.equal(await (await fetch(url)).text(), 'managed-smoke-ok');
  const switched = await app.evaluate(() => globalThis.peerBackgroundSmoke.switchConversation('source-B'));
  assert.equal(switched.success, true);
  await app.evaluate(() => globalThis.peerBackgroundSmoke.deleteSource('source-A'));
  await button.click();
  assert.equal(await page.getByRole('dialog').getAttribute('aria-modal'), null);
  await page.locator('.background-run-row').click();
  const detail = page.locator('.background-run-detail');
  await detail.getByText(`127.0.0.1:${port}`, { exact: true }).waitFor();
  assert.equal(await detail.locator('details[open]').count(), 0);
  await detail.locator('summary').getByText('日志', { exact: true }).click();
  await detail.locator('.background-run-output').getByText(/request:\/ui-proof/).waitFor();
  await detail.locator('summary').getByText('技术信息', { exact: true }).click();
  assert.match(await detail.innerText(), new RegExp(row.toolCallId));
  assert.equal(row.conversationId, 'source-A');
  for (const [width, height] of [[1120, 850], [760, 640]]) {
    await page.setViewportSize({ width, height });
    const overflow = await page.locator('.background-runtime-panel').evaluate((element) => ({
      x: element.getBoundingClientRect().x, right: element.getBoundingClientRect().right,
      client: element.clientWidth, scroll: element.scrollWidth,
    }));
    assert.ok(overflow.x >= 0 && overflow.right <= width + 1 && overflow.scroll <= overflow.client + 1, JSON.stringify(overflow));
  }
  await page.setViewportSize({ width: 1120, height: 850 });
  if (process.env.PEER_BACKGROUND_SMOKE_SCREENSHOT) {
    await page.screenshot({ path: process.env.PEER_BACKGROUND_SMOKE_SCREENSHOT, fullPage: true });
    t.diagnostic(`UI screenshot: ${process.env.PEER_BACKGROUND_SMOKE_SCREENSHOT}`);
  }
  // A rejected stop must be visible and must not claim termination.
  await app.evaluate(() => globalThis.peerBackgroundSmoke.denyStop());
  await detail.getByRole('button', { name: '停止…', exact: true }).click();
  await detail.getByRole('button', { name: '停止运行', exact: true }).click();
  await detail.getByRole('alert').getByText('test_stop_denied').waitFor();
  await delay(2700); // Polling must not erase an action error.
  assert.equal(await detail.getByRole('alert').innerText(), 'test_stop_denied');
  assert.equal(await (await fetch(url)).text(), 'managed-smoke-ok');
  const closePanel = async () => {
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  };
  const openDetails = async (taskId) => {
    await button.click();
    const target = page.locator(`[data-run-id="${taskId}"]`);
    if (!(await target.count())) {
      const history = page.getByRole('button', { name: /^最近结束/ });
      if (await history.count()) await history.click();
    }
    await target.click();
  };
  await closePanel();
  await openDetails(id);
  await detail.getByRole('alert').getByText('test_stop_denied').waitFor();
  await detail.getByRole('button', { name: '停止…', exact: true }).click();
  await detail.getByRole('button', { name: '停止运行', exact: true }).click();
  await detail.getByRole('status').getByText('已停止', { exact: true }).waitFor();
  await detail.locator('summary').filter({ hasText: '日志' }).click();
  await detail.getByText(/local-shell-artifact:\/\//).first().waitFor();
  assert.equal(await detail.getByRole('alert').count(), 0);
  await assert.rejects(fetch(url));
  await closePanel();
  await openDetails(id);
  await detail.getByRole('status').getByText('已停止', { exact: true }).waitFor();
  assert.equal(await detail.getByRole('alert').count(), 0);
  await closePanel();

  // Required cross product: presentation lifetime × request result.
  const contexts = ['kept_open', 'closed_reopened', 'header_remounted'];
  const selectedContext = process.env.PEER_BACKGROUND_STOP_CONTEXT;
  assert.ok(!selectedContext || contexts.includes(selectedContext), `Unknown stop context: ${selectedContext}`);
  for (const context of contexts.filter((value) => !selectedContext || value === selectedContext)) {
    const runId = await app.evaluate((_, source) => globalThis.peerBackgroundSmoke.launch(source), context);
    await openDetails(runId);
    const suspendPanel = async () => {
      if (context === 'closed_reopened') await closePanel();
      if (context === 'header_remounted') {
        const oldHeader = await page.locator('.chat-header').elementHandle();
        const generation = Number(await oldHeader.getAttribute('data-generation'));
        await page.evaluate(() => globalThis.remountBackgroundHeader());
        await page.waitForFunction((generation) => Number(document.querySelector('.chat-header').dataset.generation) > generation, generation);
        assert.equal(await oldHeader.evaluate((el) => el.isConnected), false, 'old header must unmount, not merely rerender');
        await oldHeader.dispose();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        assert.equal(await button.getAttribute('aria-expanded'), 'false');
      }
    };
    const resumePanel = async () => { if (context !== 'kept_open') await openDetails(runId); };
    const reopen = async () => { await suspendPanel(); await resumePanel(); };
    const submit = async (mode) => {
      await app.evaluate((_, mode) => globalThis.peerBackgroundSmoke.deferStop(mode), mode);
      await detail.getByRole('button', { name: '停止…', exact: true }).click();
      await detail.getByRole('button', { name: '停止运行', exact: true }).click();
      await detail.getByText('正在请求停止', { exact: true }).waitFor();
    };
    await t.test(`${context} × waiting (deduplicated, never optimistic)`, async () => {
      const calls = await app.evaluate(() => globalThis.peerBackgroundSmoke.stopCalls());
      await submit('deny');
      await reopen();
      await detail.getByText('正在请求停止', { exact: true }).waitFor();
      assert.equal(await detail.getByRole('button', { name: '停止…', exact: true }).isDisabled(), true);
      assert.equal(await app.evaluate(() => globalThis.peerBackgroundSmoke.stopCalls()), calls + 1);
      await detail.getByText('尚未确认停止', { exact: true }).waitFor();
      assert.equal(await app.evaluate((_, id) => globalThis.peerBackgroundSmoke.list().find((r) => r.taskId === id).status, runId), 'running');
    });
    await t.test(`${context} × rejected (late reply remains visible)`, async () => {
      await suspendPanel();
      await app.evaluate(() => globalThis.peerBackgroundSmoke.releaseStop());
      await resumePanel();
      await detail.getByRole('alert').getByText('test_stop_denied').waitFor();
      await reopen();
      await detail.getByRole('alert').getByText('test_stop_denied').waitFor();
      assert.equal(await detail.getByRole('button', { name: '停止…', exact: true }).isEnabled(), true);
    });
    await t.test(`${context} × acknowledged (snapshot still running)`, async () => {
      await submit('ack');
      await suspendPanel();
      await app.evaluate(() => globalThis.peerBackgroundSmoke.releaseStop());
      await resumePanel();
      await detail.getByText('尚未确认停止', { exact: true }).waitFor();
      await reopen();
      await detail.getByText('尚未确认停止', { exact: true }).waitFor();
      assert.equal(await detail.getByRole('button', { name: '停止…', exact: true }).isDisabled(), true);
      assert.equal(await app.evaluate((_, id) => globalThis.peerBackgroundSmoke.list().find((r) => r.taskId === id).status, runId), 'running');
      // Selecting another run must not inherit this request's feedback.
      await closePanel();
      await openDetails(id);
      assert.equal(await detail.getByText('尚未确认停止', { exact: true }).count(), 0);
      await closePanel();
      await openDetails(runId);
      await detail.getByText('尚未确认停止', { exact: true }).waitFor();
    });
    await t.test(`${context} × terminal (Runtime clears stale feedback)`, async () => {
      await suspendPanel();
      await app.evaluate((_, id) => globalThis.peerBackgroundSmoke.stopDirect(id), runId);
      await resumePanel();
      await detail.getByRole('status').getByText('已停止', { exact: true }).waitFor();
      assert.equal(await detail.getByText('尚未确认停止', { exact: true }).count(), 0);
      assert.equal(await detail.getByRole('alert').count(), 0);
    });
    await closePanel();
  }
  assert.deepEqual(errors, []);
  t.diagnostic(`Production component + preload + IPC: ${id}, source retained, live TCP ${port}, log evidence, stop-feedback cross product and explicit stop verified.`);
});
