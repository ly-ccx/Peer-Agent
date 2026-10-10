import { openReplyDetails, closeReplyDetails } from './bot-reply-details-checks.mjs';
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
    const button = firstReply.locator('.bot-reply-context > button');
    await page.waitForFunction(node => getComputedStyle(node).opacity === '0', await button.elementHandle());
    assert.equal(await button.evaluate(node => getComputedStyle(node).opacity), '0');
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `reply-entry-idle-${theme}.png`) });
    await firstReply.evaluate(async node => {
      const animations = node.closest('.bot-shell').getAnimations({ subtree: true }).filter(animation =>
        animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
      await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
    });
    const pointer = await firstReply.evaluate(node => {
      const body = node.querySelector('.bot-reply-body').getBoundingClientRect();
      const thread = node.closest('.bot-thread').getBoundingClientRect();
      const left = Math.max(body.left, 0), right = Math.min(body.right, innerWidth);
      const top = Math.max(body.top, thread.top, 0), bottom = Math.min(body.bottom, thread.bottom, innerHeight);
      for (const [x, y] of [[(left + right) / 2, (top + bottom) / 2], [left + 12, top + 12]]) {
        if (right > left && bottom > top && node.contains(document.elementFromPoint(x, y))) return { x, y };
      }
      throw Error('reply body must be visible before hover capture');
    });
    await page.mouse.move(pointer.x, pointer.y);
    await checkReplyPresence({ page, reply: firstReply, report, until, state: `short-question-${theme}` });
    await page.waitForFunction(node => getComputedStyle(node).opacity === '1', await button.elementHandle());
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
    entryChecks.push({ theme, hiddenUntilHover: true, pointer, beforeCapture, afterCapture, capture });
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
  report.replyDetailsEntry = { themes: entryChecks, keyboard: true, rightAligned: true };
  const timed = page.locator('.bot-turn-process');
  if (!await timed.evaluate(node => node.open)) await timed.locator(':scope > summary').click();
  await timed.locator('.bot-tool-step > summary .bot-process-elapsed').first().waitFor({ state: 'visible' });
  const times = await timed.locator('.bot-tool-step > summary .bot-process-elapsed').allTextContents();
  assert.deepEqual(times, ['少于 1 秒', '2 秒']);
  assert.doesNotMatch(await timed.innerText(), /(?:^|\s)0 秒/);
  assert.equal(await timed.locator('.bot-tool-step').last().locator('.bot-process-elapsed').count(), 0);
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
  const technical = process.locator('details').last();
  await technical.locator('summary').focus(); await technical.locator('summary').press('Enter');
  assert.equal(await technical.getAttribute('open'), '');
  assert.match(await technical.innerText(), /post_reply/);
  await technical.locator('summary').press('Enter');
  // A dock's body has its final width while the opening transition is still running.
  await until(() => process.evaluate(node => {
    const dock = node.closest('.bot-drawer-dock');
    if (!dock) return true;
    return dock.getBoundingClientRect().width >= parseFloat(getComputedStyle(dock).getPropertyValue('--pa-drawer-width'));
  }), Boolean);
  const states = await process.locator('.bot-process-status').allTextContents();
  assert.deepEqual(states, ['已结束', '已结束', '已结束', '已发送']);
  assert.equal(await process.locator('.bot-process-status').last().evaluate(node => node.getBoundingClientRect().right <= innerWidth), true);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'chat-process-summary.png') });
  await closeReplyDetails(page);
  checks.push('exact current-turn process uses localized operations; raw JSON is collapsed and keyboard accessible');
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 760, height: 780 });
  for (const value of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, value);
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
  await failed.getByRole('button', { name: '重发', exact: true }).waitFor();
  assert.equal(await second.card.count(), 1);
  await failed.getByRole('button', { name: '重发', exact: true }).click();
  await second.card.waitFor({ state: 'detached' });
  const retried = await until(() => canonical().find(row => row.kind === 'user_input' && row.content === 'RC_DETAIL_FAIL_ANSWER'), Boolean);
  assert.equal(retried.answerTo, `card:question:reply:${second.replyId}`);
  assert.equal(canonical().filter(row => row.kind === 'user_input' && row.content === 'RC_DETAIL_FAIL_ANSWER').length, 1);
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_DETAIL_FAIL_ANSWER', { exact: true }).waitFor();
  checks.push('failed freeform send retains choices; retry retains exact answer association and creates one canonical input');
  const third = await ask();
  await third.card.getByRole('button', { name: '其它工具里的工作记录', exact: true }).click();
  await third.card.waitFor({ state: 'detached' });
  const chosen = await until(() => canonical().find(row => row.kind === 'user_input' && row.answerTo === `card:question:reply:${third.replyId}`), Boolean);
  assert.equal(chosen.content, '其它工具里的工作记录');
  await page.locator('.bot-thread').getByText('RC scripted reply: 其它工具里的工作记录', { exact: true }).waitFor();
  await page.locator('.bot-search').fill('project-001'); await page.locator('.bot-row').first().click();
  await page.locator('.bot-search').fill('project-000'); await page.locator('.bot-row').first().click();
  await page.locator('.bot-thread').getByText('RC scripted reply: 其它工具里的工作记录', { exact: true }).waitFor();
  assert.equal(await page.locator('.bot-question').count(), 0);
  checks.push('option click follows the same durable answer path; switching back does not restore answered choices');
  await checkBotChoiceMotion({ page, ask, canonical, report, captureDirectory });
}
