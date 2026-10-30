import { openReplyDetails, closeReplyDetails, hoverBotReply, selectBotByName, wheelBotConversation } from './bot-reply-details-checks.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkBotChoiceMotion } from './bot-choice-motion-checks.mjs';
import { checkReplyPresence } from './bot-reply-presence-checks.mjs';

/** Uses the isolated fixture's actual input queue and the production question projection. */
export async function checkBotChatDetails({ page, app, until, report, captureDirectory, conversationFile }) {
  const checks = report.chatDetails = [];
  const canonical = () => readFileSync(conversationFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const composer = page.locator('.bot-composer textarea');
  const ask = async () => {
    await composer.fill('RC_DETAIL_QUESTION'); await composer.press('Enter');
    const card = page.locator('.bot-reply .bot-question');
    await card.waitFor();
    assert.equal(await page.locator('.bot-system .bot-question').count(), 0);
    const replyId = await card.evaluate(node => node.closest('.bot-reply').id.slice('bot-msg-'.length));
    assert.equal(await card.getAttribute('data-card-id'), `card:question:reply:${replyId}`);
    return { card, replyId };
  };
  const first = await ask();
  const firstReply = page.locator(`[id="bot-msg-${first.replyId}"]`);
  const entryTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const entryChecks = [];
  const entryViewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // Capture the actual view for hover states: surface capture temporarily drops
  // Chromium's :hover even while the pointer, layout and scroll remain unchanged.
  const nativeView = await app.evaluate(({ app, BrowserWindow, screen }, { url, viewport }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url);
    if (!window) throw Error('fixture window missing');
    const previous = window.getContentSize();
    // Quick Chat can hide the main window. A native-view capture requires a
    // visible, composited window; keep that precondition explicit.
    app.show?.();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.setContentSize(viewport.width, viewport.height);
    return { previous, size: window.getContentSize(), density: screen.getDisplayMatching(window.getBounds()).scaleFactor };
  }, { url: page.url(), viewport: entryViewport });
  assert.deepEqual(nativeView.size, [entryViewport.width, entryViewport.height], 'native window matches the established CSS viewport');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    // Finish layout/theme transitions before placing the pointer. Screenshot
    // fast-forwarding must not move the hovered bubble out from under it.
    await until(() => firstReply.evaluate(node => node.getAnimations({ subtree: true })
      .filter(animation => animation.playState === 'running'
        && Number.isFinite(animation.effect?.getComputedTiming().endTime)
        && animation.effect?.target?.checkVisibility()).length), count => count === 0, 5000);
    await composer.focus(); await page.mouse.move(1, 1);
    const button = firstReply.getByRole('button', { name: '回复详情', exact: true });
    await page.waitForFunction(node => getComputedStyle(node).opacity === '0', await button.elementHandle());
    assert.equal(await firstReply.getByRole('button', { name: '引用', exact: true }).isVisible(), false);
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `reply-entry-idle-${theme}.png`) });
    await firstReply.evaluate(async node => {
      const animations = node.closest('.bot-shell').getAnimations({ subtree: true }).filter(animation =>
        animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
      await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
    });
    await checkReplyPresence({ page, reply: firstReply, report, until, state: `short-question-${theme}` });
    const pointer = await hoverBotReply(page, firstReply, button);
    assert.equal(await button.evaluate(node => getComputedStyle(node).opacity), '1');
    const beforeCapture = await firstReply.evaluate(node => ({ hovered: node.matches(':hover'),
      opacity: getComputedStyle(node.querySelector('.bot-reply-context > button')).opacity,
      bounds: node.getBoundingClientRect().toJSON(), top: node.closest('.bot-thread').scrollTop }));
    assert.equal(beforeCapture.hovered, true);
    // Electron's frame capture works for its native window even when Chromium
    // cannot capture a fromSurface=false view. Preserve the real hover state.
    const png = await app.evaluate(async ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url);
      if (!window) throw Error('fixture window missing for hover capture');
      return (await window.webContents.capturePage()).toPNG().toString('base64');
    }, page.url());
    const bytes = Buffer.from(png, 'base64');
    const capture = { method: 'electron-webcontents', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
      cssWidth: entryViewport.width, cssHeight: entryViewport.height, density: nativeView.density };
    assert.equal(capture.width, Math.round(entryViewport.width * capture.density), 'native hover capture covers the full viewport width');
    assert.equal(capture.height, Math.round(entryViewport.height * capture.density), 'native hover capture covers the full viewport height');
    writeFileSync(path.join(captureDirectory, `reply-entry-hover-${theme}.png`), bytes);
    const afterCapture = await firstReply.evaluate(node => ({ hovered: node.matches(':hover'),
      opacity: getComputedStyle(node.querySelector('.bot-reply-context > button')).opacity,
      bounds: node.getBoundingClientRect().toJSON(), top: node.closest('.bot-thread').scrollTop }));
    entryChecks.push({ theme, visibleAtRest: false, pointer, beforeCapture, afterCapture, capture });
    assert.equal(afterCapture.hovered, true, 'real pointer remains over the reply during capture');
    assert.equal(afterCapture.opacity, '1', `details remain visible in captured hover state: ${JSON.stringify(entryChecks.at(-1))}`);
    assert.deepEqual(afterCapture.bounds, beforeCapture.bounds, 'hover capture preserves reply geometry');
    assert.equal(afterCapture.top, beforeCapture.top, 'hover capture preserves the reading position');
  }
  await app.evaluate(({ BrowserWindow }, { url, nativeSize }) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url)?.setContentSize(...nativeSize);
  }, { url: page.url(), nativeSize: nativeView.previous });
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, entryTheme);
  await openReplyDetails(page, firstReply);
  report.replyDetailsEntry = { themes: entryChecks, keyboard: true, leftAligned: true, unifiedActivity: true };
  const timed = page.locator('.bot-turn-process');
  if (!await timed.evaluate(node => node.open)) await timed.locator(':scope > summary').click();
  await timed.locator('.bot-tool-step > summary .bot-process-elapsed').first().waitFor({ state: 'visible' });
  const times = await timed.locator('.bot-tool-step > summary .bot-process-elapsed').allTextContents();
  assert.deepEqual(await timed.locator('.bot-tool-step-label').allTextContents(), ['查看工作会话', '读取文件', '查询工作会话']);
  assert.deepEqual(times, ['2 秒', '少于 1 秒']);
  assert.doesNotMatch(await timed.innerText(), /(?:^|\s)0 秒/);
  assert.equal(await timed.locator('.bot-tool-step').first().locator('.bot-process-elapsed').count(), 0);
  const timingViewport = page.viewportSize();
  const timingTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const [width, theme] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await until(() => page.locator('.bot-shell').evaluate(node => node.getAnimations({ subtree: true })
      .filter(animation => animation.playState === 'running'
        && Number.isFinite(animation.effect?.getComputedTiming().endTime)
        && animation.effect?.target?.checkVisibility()).length), count => count === 0, 5000);
    await timed.locator('.bot-tool-step > summary .bot-process-elapsed').first().waitFor({ state: 'visible' });
    assert.equal(await timed.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `process-timing-${theme}.png`) });
  }
  await page.setViewportSize(timingViewport);
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, timingTheme);
  await timed.locator(':scope > summary').click();
  await until(() => timed.evaluate(node => node.getBoundingClientRect().height
    - node.querySelector(':scope > summary').getBoundingClientRect().height), height => height <= 2, 5000);
  report.replyDetailsEntry.collapsedHeight = true;
  report.processTiming = { subsecond: true, seconds: true, persisted: true, unknownHidden: true, narrowFits: true };
  await page.locator('.bot-reply-rounds > summary').click();
  const process = page.locator('.bot-process'); await process.waitFor();
  const visible = await process.innerText();
  assert.match(visible, /查询工作会话/); assert.match(visible, /发送回复/);
  assert.doesNotMatch(visible, /post_reply|replyTo|RC scripted reply/);
  assert.equal(await process.locator('details[open]').count(), 0);
  const technical = process.locator('details').first();
  await technical.locator('summary').focus(); await technical.locator('summary').press('Enter');
  assert.equal(await technical.getAttribute('open'), '');
  // Native details is open before its content-visibility transition finishes.
  // Keep the visible raw-detail assertion, waiting for the real revealed text.
  assert.match(await until(() => technical.innerText(), text => /post_reply/.test(text)), /post_reply/);
  await technical.locator('summary').press('Enter');
  // A dock's body has its final width while the opening transition is still running.
  await until(() => process.evaluate(node => {
    const dock = node.closest('.resource-workspace, .bot-drawer-dock');
    if (!dock) return true;
    if (dock.matches('.resource-workspace')) return dock.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity);
    return dock.getBoundingClientRect().width >= parseFloat(getComputedStyle(dock).getPropertyValue('--pa-drawer-width'));
  }), Boolean);
  const states = await process.locator('.bot-process-status').allTextContents();
  assert.deepEqual(states, ['已发送', '已结束', '已结束', '已结束']);
  assert.equal(await process.locator('.bot-process-status').last().evaluate(node => node.getBoundingClientRect().right <= innerWidth), true);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'chat-process-summary.png') });
  await closeReplyDetails(page);
  checks.push('exact current-turn process uses localized operations; raw JSON is collapsed and keyboard accessible');
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 760, height: 780 });
  for (const value of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, value);
    await until(() => page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), Boolean);
    assert.equal(await page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    const rect = await first.card.evaluate(node => ({ card: getComputedStyle(node).borderLeftWidth, shadow: getComputedStyle(node).boxShadow,
      user: getComputedStyle(document.querySelector('.bot-user')).backgroundColor }));
    assert.equal(rect.card, '0px'); assert.equal(rect.shadow, 'none'); assert.equal(rect.user, 'rgba(0, 0, 0, 0)');
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `chat-question-${value}.png`) });
  }
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.setViewportSize(viewport);
  await composer.fill('我自己填写：这个应用的历史聊天'); await composer.press('Enter');
  await first.card.waitFor({ state: 'detached' });
  const typed = await until(() => canonical().find(row => row.kind === 'user_input' && row.content === '我自己填写：这个应用的历史聊天'), Boolean);
  assert.equal(typed.answerTo, `card:question:reply:${first.replyId}`);
  await page.locator('.bot-thread').getByText('RC scripted reply: 我自己填写：这个应用的历史聊天', { exact: true }).waitFor();
  checks.push('freeform reply durably binds to its question and removes only those choices');
  const second = await ask();
  await composer.fill('RC_DETAIL_FAIL_ANSWER'); await composer.press('Enter');
  const failed = page.locator('.bot-user').filter({ hasText: 'RC_DETAIL_FAIL_ANSWER' });
  const retry = failed.getByRole('button', { name: '重试同一消息', exact: true });
  await retry.waitFor();
  assert.match(await failed.innerText(), /发送结果尚未确认/);
  const inputId = await failed.getAttribute('data-input-id');
  assert.ok(inputId, 'recovery retains the original input identity');
  assert.equal(await second.card.count(), 1);
  await retry.click();
  await second.card.waitFor({ state: 'detached' });
  const retried = await until(() => canonical().find(row => row.kind === 'user_input' && row.content === 'RC_DETAIL_FAIL_ANSWER'), Boolean);
  assert.equal(retried.answerTo, `card:question:reply:${second.replyId}`);
  assert.equal(retried.inputId, inputId);
  assert.equal(canonical().filter(row => row.kind === 'user_input' && row.content === 'RC_DETAIL_FAIL_ANSWER').length, 1);
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_DETAIL_FAIL_ANSWER', { exact: true }).waitFor();
  checks.push('unconfirmed freeform send retains choices; retry reuses the original input identity and answer association, creating one canonical input');
  const third = await ask();
  await third.card.getByRole('button', { name: '其它工具里的工作记录', exact: true }).click();
  await third.card.waitFor({ state: 'detached' });
  const chosen = await until(() => canonical().find(row => row.kind === 'user_input' && row.answerTo === `card:question:reply:${third.replyId}`), Boolean);
  assert.equal(chosen.content, '其它工具里的工作记录');
  await page.locator('.bot-thread').getByText('RC scripted reply: 其它工具里的工作记录', { exact: true }).waitFor();
  await selectBotByName(page, 'project-001');
  await selectBotByName(page, 'project-000');
  await page.locator('.bot-thread').getByText('RC scripted reply: 其它工具里的工作记录', { exact: true }).waitFor();
  assert.equal(await page.locator('.bot-question').count(), 0);
  checks.push('option click follows the same durable answer path; switching back does not restore answered choices');

  const skipped = await ask();
  const botRow = page.locator('.bot-row.is-open');
  await until(() => botRow.locator('.bot-badge').count(), count => count === 1);
  const beforeMovingOn = canonical().length;
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    await skipped.card.scrollIntoViewIfNeeded();
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `question-pending-${appearance}.png`) });
  }
  // Quoting an older reply must not bind the new topic as an answer to the latest question.
  const oldReply = page.locator(`[id="bot-msg-${third.replyId}"] .bot-reply-text`);
  await wheelBotConversation(page, -300);
  await oldReply.scrollIntoViewIfNeeded();
  await oldReply.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  const quoteAction = page.locator('.bot-selection-quote');
  await quoteAction.waitFor({ state: 'visible' });
  await until(() => quoteAction.getAttribute('data-surface-settled'), value => value === 'true');
  await page.keyboard.press('Tab');
  assert.equal(await quoteAction.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.locator('.bot-quote-chip').waitFor();
  await composer.fill('这两个都先不选，我想继续问别的问题'); await composer.press('Enter');
  await skipped.card.waitFor({ state: 'detached' });
  await until(() => botRow.locator('.bot-badge').count(), count => count === 0);
  const followup = await until(() => canonical().slice(beforeMovingOn).find(row => row.kind === 'user_input'), Boolean);
  assert.equal(followup.answerTo, undefined, 'moving on must not fabricate an answer or select an option');
  assert.ok(followup.quoteRefs.includes(third.replyId));
  await page.locator('.bot-thread').getByText('RC scripted reply: 这两个都先不选，我想继续问别的问题', { exact: true }).waitFor();
  await selectBotByName(page, 'project-001');
  await selectBotByName(page, 'project-000');
  await page.locator(`[id="bot-msg-${skipped.replyId}"]`).waitFor();
  assert.equal(await page.locator('.bot-question').count(), 0);
  assert.equal(canonical().find(row => row.id === skipped.replyId).question.options.length, 2, 'historical question remains intact');
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `question-retired-${appearance}.png`) });
  }
  await page.setViewportSize(viewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  report.questionRetirement = { noImplicitAnswer: true, choicesRetired: true, badgeCleared: true, historyRetained: true, retainedAfterSwitch: true };
  checks.push('a new topic quoting an older reply retires the pending question and needs-you badge without an answer; switching back preserves history without controls');
  await checkBotChoiceMotion({ page, ask, canonical, report, captureDirectory });
}
