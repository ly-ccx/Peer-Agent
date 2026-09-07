// Full Desktop UI smoke using a loopback-only fake provider and fresh data.
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(path.join(tmpdir(), 'peer-selection-ui-smoke-'));
const requests = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'selection-test', object: 'model', owned_by: 'local-test' }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const content = 'Received selection test.\n\nPlain mapping sample.\n\n**Bold mapping sample.**\n\n**Repeated mapping sample.**\n\n**Repeated mapping sample.**';
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const env = { ...process.env, PEER_AGENT_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const deadline = setTimeout(() => {
  app?.process().kill('SIGKILL');
  console.error('SMOKE_DEADLINE', home);
  process.exit(2);
}, 50000);
try {
  app = await electron.launch({ args: [desktop, `--user-data-dir=${path.join(home, 'chromium')}`], env, timeout: 6000 });
  const waitForMainWindow = async () => {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      for (const candidate of app.windows()) {
        const url = candidate.url();
        if (url.startsWith('file:') && new URL(url).pathname.endsWith('/dist/index.html')
          && !new URL(url).searchParams.has('window')) {
          await candidate.bringToFront();
          return candidate;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Main window not ready: ${app.windows().map((window) => window.url()).join(', ')}`);
  };
  const page = await waitForMainWindow();
  page.setDefaultTimeout(5000);
  await page.getByRole('button', { name: 'Connect AI service', exact: true }).click().catch(async (error) => {
    console.error('STARTUP_FAILURE', page.url(), await page.locator('body').innerText());
    throw error;
  });
  await page.getByRole('button', { name: 'Add service', exact: true }).first().click();
  await page.getByText('OpenAI 兼容', { exact: true }).click();
  await page.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  // No real secret and no external model endpoint is used.
  await page.locator('input[type="password"]').fill('local-test-not-a-secret');
  await page.getByRole('button', { name: 'Next: choose models', exact: true }).click();
  await page.getByRole('button', { name: 'Select filtered', exact: true }).click();
  await page.getByRole('button', { name: 'Apply selection (1 models)', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  // Only the native directory chooser is stubbed; production workspace IPC runs.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, home);
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
  await page.locator('textarea').fill('FROZEN_PARENT_MARKER: selection background test');
  await page.locator('textarea').press('Enter');
  await page.getByText('Received selection test.', { exact: true }).waitFor().catch(async (error) => {
    console.error('SEND_FAILURE_DOM', await page.locator('body').innerText());
    console.error('SEND_REQUESTS', JSON.stringify(requests));
    await page.screenshot({ path: path.join(home, 'send-failure.png') });
    console.error('FAILURE_EVIDENCE', home);
    throw error;
  });
  const parentId = await page.locator('[data-conversation-id]').first().getAttribute('data-conversation-id');
  assert.ok(parentId);
  await page.locator('textarea').fill('parent-draft-A');
  const sourceBody = page.locator('.chat-msg-text').filter({ hasText: 'FROZEN_PARENT_MARKER' }).first();
  await sourceBody.scrollIntoViewIfNeeded();
  // Range is used only to measure glyph bounds, never to install a selection.
  const drag = await sourceBody.evaluate((element) => {
    const text = element.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error('Expected plain-text source');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 'FROZEN_PARENT_MARKER'.length);
    const rect = range.getBoundingClientRect();
    return { x: rect.left, endX: rect.right, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.endX, drag.y, { steps: 20 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), 'FROZEN_PARENT_MARKER');
  const toolbar = page.getByRole('group', { name: '选区操作' });
  await toolbar.waitFor({ state: 'visible' });
  const geometry = await toolbar.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const selection = window.getSelection().getRangeAt(0).getClientRects()[0];
    const style = getComputedStyle(element);
    return { position: style.position, parent: element.parentElement.tagName,
      left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      gap: Math.min(Math.abs(selection.top - box.bottom), Math.abs(box.top - selection.bottom)),
      width: innerWidth, height: innerHeight, background: style.backgroundColor };
  });
  assert.equal(geometry.position, 'fixed');
  assert.equal(geometry.parent, 'BODY', 'toolbar must not occupy composer layout');
  assert.ok(geometry.left >= 8 && geometry.right <= geometry.width - 8);
  assert.ok(geometry.top >= 8 && geometry.bottom <= geometry.height - 8);
  assert.ok(Math.abs(geometry.gap - 8) <= 1, JSON.stringify(geometry));
  assert.notEqual(geometry.background, 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: path.join(home, 'selection-toolbar.png') });
  const initialView = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme }));
  const themeColors = new Set();
  for (const theme of ['light', 'dark']) {
    for (const width of [initialView.width, 640]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.setViewportSize({ width, height: initialView.height });
      await sourceBody.scrollIntoViewIfNeeded();
      await toolbar.waitFor({ state: 'visible' });
      // Wait for resize positioning and the renderer's next paint.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const metrics = await toolbar.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const buttons = [...element.querySelectorAll('button')].map((button) => button.getBoundingClientRect());
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
          width: innerWidth, height: innerHeight, background: getComputedStyle(element).backgroundColor,
          buttonGap: buttons[1].left - buttons[0].right };
      });
      assert.ok(metrics.left >= 8 && metrics.right <= metrics.width - 8, JSON.stringify(metrics));
      assert.ok(metrics.top >= 8 && metrics.bottom <= metrics.height - 8, JSON.stringify(metrics));
      assert.ok(metrics.buttonGap >= 4, JSON.stringify(metrics));
      themeColors.add(metrics.background);
      await page.screenshot({ path: path.join(home, `toolbar-${theme}-${width}.png`) });
      console.log('PASS toolbar-theme-viewport', theme, width, JSON.stringify(metrics));
    }
  }
  assert.equal(themeColors.size, 2, 'toolbar follows light and dark theme surfaces');
  await page.setViewportSize({ width: initialView.width, height: initialView.height });
  await page.evaluate((theme) => {
    if (theme === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, initialView.theme);
  await sourceBody.scrollIntoViewIfNeeded();
  await page.keyboard.press('Tab');
  assert.equal(await toolbar.locator('button').first().evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press('Escape');
  await toolbar.waitFor({ state: 'hidden' });
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.endX, drag.y, { steps: 20 });
  await page.mouse.up();
  await toolbar.waitFor({ state: 'visible' });
  await page.locator('textarea').click();
  await toolbar.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('textarea').inputValue(), 'parent-draft-A');
  const selectAgain = async () => {
    await sourceBody.scrollIntoViewIfNeeded();
    const bounds = await sourceBody.evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild, 0);
      range.setEnd(element.firstChild, 'FROZEN_PARENT_MARKER'.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left, endX: rect.right, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(bounds.x, bounds.y);
    await page.mouse.down();
    await page.mouse.move(bounds.endX, bounds.y, { steps: 20 });
    await page.mouse.up();
    await toolbar.waitFor({ state: 'visible' });
  };
  await selectAgain();
  // Exercise the browser's real selectionchange notification, not a synthetic event.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await toolbar.waitFor({ state: 'hidden' });
  await selectAgain();
  console.log('PASS toolbar-outside-click selection-cancel reselect parent-draft-retained');
  // Layout-only fixture: make the short fake response tall enough for real wheel scrolling.
  const reply = page.locator('.markdown-content p').filter({ hasText: 'Received selection test.' }).first();
  const originalStyle = await reply.getAttribute('style');
  await reply.evaluate((element) => { element.style.minHeight = '1600px'; });
  await sourceBody.hover();
  await page.mouse.wheel(0, 900);
  await toolbar.waitFor({ state: 'hidden' });
  const offscreen = await sourceBody.evaluate((element) => {
    let scroller = element.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    return { sourceBottom: element.getBoundingClientRect().bottom,
      viewportTop: scroller?.getBoundingClientRect().top ?? 0, scrollTop: scroller?.scrollTop ?? 0 };
  });
  assert.ok(offscreen.scrollTop > 0 && offscreen.sourceBottom < offscreen.viewportTop, JSON.stringify(offscreen));
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await reply.evaluate((element, style) => {
    if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style);
  }, originalStyle);
  await selectAgain();
  console.log('PASS toolbar-real-wheel-offscreen-dismiss-reselect', JSON.stringify(offscreen));
  // 延迟创建：打开侧栏只准备草稿，不落盘、不进列表、不发送。
  const conversationRowsBefore = await page.locator('[data-conversation-id]').count();
  await page.getByRole('button', { name: '在侧栏打开', exact: true }).click();
  await page.getByRole('dialog', { name: '子会话讨论' }).waitFor();
  const child = page.getByRole('dialog', { name: '子会话讨论' });
  assert.equal(requests.filter((r) => r.url?.endsWith('/chat/completions')).length, 1, 'creation must not send');
  // 打开后列表不变，子会话还未创建。
  assert.equal(await page.locator('[data-conversation-id]').count(), conversationRowsBefore, 'open must not create a session');
  await child.locator('textarea').fill('child-draft-B');
  await child.locator('textarea').press('Escape');
  await child.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('textarea').inputValue(), 'parent-draft-A');
  // 发送后才创建持久子会话并出现在列表中。
  await page.locator(`[data-conversation-id="${parentId}"]`).dispatchEvent('click');
  await page.locator('textarea').waitFor();
  // 重新选择文本后再次打开侧栏。
  await selectAgain();
  await page.getByRole('button', { name: '在侧栏打开', exact: true }).click();
  await child.waitFor();
  await child.locator('textarea').fill('CHILD_QUESTION: what was the parent marker?');
  await child.locator('textarea').press('Enter');
  await page.waitForFunction(() => {
    const confirm = Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === '仍然创建');
    const parent = Array.from(document.querySelectorAll('[data-conversation-id]')).some((row) => {
      const text = row.textContent ?? '';
      return text.includes('来自父会话') || text.includes('From parent');
    });
    return confirm || parent;
  }, undefined, { timeout: 15_000 });
  const stillCreate = child.getByRole('button', { name: '仍然创建', exact: true });
  if (await stillCreate.isVisible().catch(() => false)) {
    await stillCreate.click();
  }
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('[data-conversation-id]');
    return Array.from(rows).some((row) => {
      const text = row.textContent ?? '';
      return text.includes('来自父会话') || text.includes('From parent');
    });
  }, undefined, { timeout: 15_000 });
  await child.locator('.chat-msg-text', { hasText: 'CHILD_QUESTION: what was the parent marker?' }).waitFor({ timeout: 10_000 });
  await child.locator('.markdown-content').filter({ hasText: 'Received selection test.' }).waitFor({ timeout: 10_000 });
  // 列表中新增一行，且显示「来自父会话」。
  const conversationRowsAfter = await page.locator('[data-conversation-id]').count();
  assert.equal(conversationRowsAfter, conversationRowsBefore + 1, 'send must create a session');
  const childRow = page.locator('[data-conversation-id]').filter({ has: page.locator('.sidebar-conv-parent') });
  await childRow.waitFor();
  const chats = requests.filter((r) => r.url?.endsWith('/chat/completions'));
  assert.equal(chats.length, 2);
  const background = chats[1].body.messages.filter((m) => JSON.stringify(m.content).includes('FROZEN_PARENT_MARKER'));
  assert.equal(background.length, 1, 'background admitted once');
  assert.equal(background[0].role, 'user');
  assert.equal(chats[1].body.tools?.length ?? 0, 0);
  await child.locator('textarea').press('Escape');
  await child.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('textarea').inputValue(), 'parent-draft-A');
  await page.locator('textarea').fill('PARENT_AFTER_SNAPSHOT: must not enter frozen background');
  await page.locator('textarea').press('Enter');
  await page.locator('.markdown-content').filter({ hasText: 'Received selection test.' }).nth(1).waitFor();
  await page.locator('textarea').fill('parent-draft-C');
  // 发送后子会话已落盘；Escape 会关掉草稿抽屉，需从子会话导航重新打开。
  await page.getByRole('navigation', { name: '子会话' }).getByRole('button').first().click();
  await child.waitFor();
  await child.locator('textarea').waitFor();
  await child.locator('textarea').fill('CHILD_SECOND_QUESTION: recall the frozen context');
  await child.locator('textarea').press('Enter');
  await child.locator('.markdown-content').filter({ hasText: 'Received selection test.' }).nth(1).waitFor();
  const allChats = requests.filter((r) => r.url?.endsWith('/chat/completions'));
  assert.equal(allChats.length, 4);
  assert.ok(JSON.stringify(allChats[2].body).includes('PARENT_AFTER_SNAPSHOT'));
  assert.ok(!JSON.stringify(allChats[2].body).includes('CHILD_QUESTION'));
  assert.ok(!JSON.stringify(allChats[3].body).includes('PARENT_AFTER_SNAPSHOT'));
  assert.equal(allChats[3].body.messages.filter((m) => JSON.stringify(m.content).includes('FROZEN_PARENT_MARKER')).length, 1);
  assert.equal(allChats[3].body.tools?.length ?? 0, 0);
  await child.locator('textarea').press('Escape');
  await child.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('textarea').inputValue(), 'parent-draft-C');
  // 再次打开已落盘的子会话，写入重启后要恢复的草稿。
  await page.getByRole('navigation', { name: '子会话' }).getByRole('button').first().click();
  await child.waitFor();
  await child.locator('textarea').waitFor();
  await child.locator('textarea').fill('child-restart-draft-D');
  await child.locator('textarea').press('Escape');
  await child.waitFor({ state: 'hidden' });
  const firstProcess = app.process();
  await app.close();
  assert.equal(firstProcess.exitCode, 0);
  app = await electron.launch({ args: [desktop, `--user-data-dir=${path.join(home, 'chromium')}`], env, timeout: 6000 });
  let restored = await waitForMainWindow();
  restored.setDefaultTimeout(5000);
  await restored.locator(`[data-conversation-id="${parentId}"]`).click();
  console.log('RESTART_DOM', await restored.locator('body').innerText());
  // 重启后子会话已落盘；从父会话的子会话导航打开侧栏，而不是切走主会话。
  await restored.getByRole('navigation', { name: '子会话' }).getByRole('button').first().click();
  const restoredChild = restored.getByRole('dialog', { name: '子会话讨论' });
  await restoredChild.waitFor();
  await restoredChild.locator('.markdown-content').filter({ hasText: 'Received selection test.' }).nth(1).waitFor();
  assert.equal(await restoredChild.locator('textarea').inputValue(), 'child-restart-draft-D');
  assert.equal(requests.filter((r) => r.url?.endsWith('/chat/completions')).length, 4, 'restart must not auto-send');
  await restoredChild.locator('textarea').fill('CHILD_AFTER_RESTART: recall the frozen context');
  await restoredChild.locator('textarea').press('Enter');
  await restoredChild.locator('.markdown-content').filter({ hasText: 'Received selection test.' }).nth(2).waitFor();
  const restartedChats = requests.filter((r) => r.url?.endsWith('/chat/completions'));
  assert.equal(restartedChats.length, 5);
  const restartedBody = restartedChats[4].body;
  const restartedBackground = restartedBody.messages.filter((m) => JSON.stringify(m.content).includes('FROZEN_PARENT_MARKER'));
  assert.equal(restartedBackground.length, 1, 'restart admits frozen background once');
  assert.equal(restartedBackground[0].role, 'user');
  assert.ok(!JSON.stringify(restartedBody).includes('PARENT_AFTER_SNAPSHOT'));
  assert.ok(JSON.stringify(restartedBody).includes('CHILD_SECOND_QUESTION'));
  assert.ok(JSON.stringify(restartedBody).includes('CHILD_AFTER_RESTART'));
  assert.equal(restartedBody.tools?.length ?? 0, 0);
  console.log('PASS post-restart-send frozen-background-once child-history-retained parent-update-excluded tools-empty');
  await restored.screenshot({ path: path.join(home, 'restart.png') });
  console.log('PASS restart-child-draft-history-no-auto-send');
  console.log('PASS creation-no-send parent-draft child-draft-reopen background-once user-role child-tools-empty frozen-after-parent-update bidirectional-history-isolation');
  console.log('SETUP_DOM', await restored.locator('body').innerText());
  console.log('REQUEST_PATHS', requests.map((request) => request.url));
  await restoredChild.locator('textarea').press('Escape');
  await restoredChild.waitFor({ state: 'hidden' });
  for (const segmented of [false, true]) {
    let expectedSource;
    let expectedMessageId;
    let expectedStart = 0;
    if (segmented) {
      await app.close();
      // Persisted fixture only, in this run's fresh temporary home. No tool is executed.
      const historyPath = path.join(home, 'conversations', `${parentId}.jsonl`);
      const rows = (await readFile(historyPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      const message = rows.find((row) => row.role === 'assistant');
      assert.ok(message);
      const final = message.content;
      const prefix = `${final}\n\n`;
      message.content = prefix + final;
      expectedSource = message.content;
      expectedMessageId = message.id;
      expectedStart = prefix.length;
      message.segments = [
        { type: 'text', content: prefix },
        { type: 'tool-call', tool: 'read_file', args: { path: 'fixture-only.txt' }, result: 'fixture complete', toolCallId: 'selection-fixture-tool', startedAtMs: 1, endedAtMs: 2 },
        { type: 'text', content: final },
      ];
      await writeFile(historyPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
      app = await electron.launch({ args: [desktop, `--user-data-dir=${path.join(home, 'chromium')}`], env, timeout: 6000 });
      restored = await waitForMainWindow();
      restored.setDefaultTimeout(5000);
      await restored.locator(`[data-conversation-id="${parentId}"]`).click();
    }
  for (const [label, occurrence] of [['Plain mapping sample.', 0], ['Bold mapping sample.', 0], ['Repeated mapping sample.', 1]]) {
    for (const action of ['添加到对话', '在侧栏打开']) {
      const body = segmented
        ? restored.locator(`[data-msg-id="${expectedMessageId}"] .segment-text-after-tools .markdown-content`).last()
        : restored.locator('.markdown-content').first();
      const leaf = body.locator('[data-source-offsets]').filter({ hasText: label }).nth(occurrence);
      if (segmented) {
        assert.equal(await body.getAttribute('data-selection-source'), expectedSource);
        const offsets = JSON.parse(await leaf.getAttribute('data-source-offsets'));
        assert.ok(offsets[0] >= expectedStart, 'must select final text after the tool, not its repeated prefix');
        assert.equal(expectedSource.slice(offsets[0], offsets.at(-1)), label);
      }
      await restored.locator('textarea').click();
      await leaf.scrollIntoViewIfNeeded();
      await restored.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const bounds = await leaf.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left, endX: rect.right, y: rect.top + rect.height / 2 };
      });
      await restored.mouse.move(bounds.x, bounds.y);
      await restored.mouse.down();
      await restored.mouse.move(bounds.endX, bounds.y, { steps: 20 });
      await restored.mouse.up();
      assert.equal(await restored.evaluate(() => getSelection().toString()), label);
      const priorAttachments = await restored.locator('.attachment-chip').count();
      await restored.getByRole('button', { name: action, exact: true }).click();
      if (action === '在侧栏打开') {
        const panel = restored.getByRole('dialog', { name: '子会话讨论' });
        // 打开只准备草稿：不落盘、不要求「仍然创建」。背景缺失确认改到真正发送时。
        await panel.waitFor().catch(async (error) => {
          console.error('SIDEBAR_FAILURE_DOM', await restored.locator('body').innerText());
          throw error;
        });
        assert.equal(await panel.locator('blockquote').innerText(), label);
        const bannerLayout = await panel.evaluate((element) => {
          const header = element.querySelector('.chat-header');
          const banner = element.querySelector('.selection-child-banner');
          if (!header || !banner) return null;
          const headerBox = header.getBoundingClientRect();
          const bannerBox = banner.getBoundingClientRect();
          return {
            headerBottom: headerBox.bottom,
            bannerTop: bannerBox.top,
            belowHeader: bannerBox.top >= headerBox.bottom - 1,
            notAtWindowTop: bannerBox.top > 8,
          };
        });
        assert.ok(bannerLayout?.belowHeader && bannerLayout?.notAtWindowTop, `banner must sit below the chat header: ${JSON.stringify(bannerLayout)}`);
        await panel.locator('textarea').press('Escape');
        await panel.waitFor({ state: 'hidden' });
      } else {
        await restored.locator('.attachment-chip').nth(priorAttachments).waitFor().catch(async (error) => {
          console.error('MAPPING_FAILURE_DOM', await restored.locator('body').innerText());
          throw error;
        });
        await restored.keyboard.press('Escape');
      }
      assert.equal(requests.filter((r) => r.url?.endsWith('/chat/completions')).length, 5);
      console.log('PASS markdown-selection', segmented ? 'tool-segmented' : 'single', label, occurrence, action);
    }
  }
  }
  console.log('EVIDENCE', home);
  console.log('STATUS passed: real mouse plain-text selection, UI create/send/close/reopen; loopback provider and native directory chooser stubbed; process-restart draft/history recovery and subsequent send covered; full product matrix not covered');
} finally {
  if (app) {
    const proc = app.process();
    await app.close();
    console.log('ELECTRON_EXIT', proc.exitCode);
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  clearTimeout(deadline);
}
