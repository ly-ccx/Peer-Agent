import { BOT_DETAIL_SURFACE, BOT_DETAIL_CLOSE } from './bot-detail-surface-selectors.mjs';
import { scrollToBotMessage, wheelBotConversation } from './bot-reply-details-checks.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';

/** A long historical reply remains quotable after its old question controls retire. */
export async function checkBotSelectionQuote({ page, until, report, captureDirectory }) {
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const reply = page.locator('#bot-msg-rc-message-9996');
  const body = reply.locator('.bot-reply-text');
  const action = page.locator('.bot-quote-action[data-surface-state="open"]:not([inert])');
  const input = page.locator('.bot-composer textarea');
  const draft = await input.inputValue();
  const phrase = '叶子证据和独立校验都通过了';
  const select = async (mouseUp = true) => {
    // Reading an already-mounted old row still needs explicit history intent;
    // scrollIntoView alone must not masquerade as the user's choice to stop following.
    await wheelBotConversation(page, -1);
    await scrollToBotMessage(page, reply);
    await body.locator('p').first().scrollIntoViewIfNeeded();
    await body.evaluate((node, params) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text; while ((text = walker.nextNode()) && !text.textContent.includes(params.phrase)) {}
      if (!text) throw Error('selection fixture phrase missing');
      const start = text.textContent.indexOf(params.phrase), range = document.createRange();
      range.setStart(text, start); range.setEnd(text, start + params.phrase.length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      if (params.mouseUp) node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, { phrase, mouseUp });
    await action.waitFor({ state: 'visible' });
  };
  const measure = () => action.evaluate(node => {
    const selected = window.getSelection().getRangeAt(0).getClientRects()[0];
    const button = node.getBoundingClientRect(), thread = document.querySelector('.bot-thread').getBoundingClientRect();
    return { gap: Math.min(Math.abs(button.bottom - selected.top), Math.abs(button.top - selected.bottom)),
      left: button.left, right: button.right, top: button.top, bottom: button.bottom,
      fits: button.left >= thread.left && button.right <= thread.right && button.top >= thread.top && button.bottom <= thread.bottom,
      inReply: Boolean(node.closest('.bot-reply')), selectedTop: selected.top };
  });
  const cases = [];
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 860 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    await select();
    const position = await measure();
    assert.ok(position.gap <= 12 && position.fits && !position.inReply,
      `quote action must float beside the selection, not below the long reply: ${JSON.stringify(position)}`);
    assert.equal(await action.locator('svg').count(), 1);
    await page.screenshot({ path: path.join(captureDirectory, `selection-quote-${width}-${appearance}.png`), animations: 'disabled' });
    await page.locator('.bot-thread').evaluate(node => { node.scrollTop += 18; });
    await until(measure, next => Math.abs(next.top - position.top) > 10 && next.gap <= 12);
    if (width === 1280) {
      await page.setViewportSize({ width: 760, height: 860 });
      await until(measure, next => next.fits && next.gap <= 12 && next.right <= 760);
      await page.setViewportSize({ width, height: 860 });
      await until(measure, next => next.fits && next.gap <= 12);
    }
    await page.keyboard.press('Escape'); await action.waitFor({ state: 'detached' });
    await select(false); // Native selectionchange must also support keyboard-created selections.
    await page.keyboard.press('Tab');
    assert.equal(await action.evaluate(node => node === document.activeElement), true);
    await input.fill('已有草稿要保留');
    await action.waitFor({ state: 'detached' });
    await select(false);
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    await action.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.bot-quote-chip .bot-reply-bar-excerpt').textContent(), phrase);
    assert.equal(await input.inputValue(), '已有草稿要保留');
    await page.locator('.bot-quote-chip').getByRole('button', { name: '取消引用', exact: true }).click();
    await select();
    await action.click(); // Mouse-up must not remove the portal before its click is delivered.
    await action.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.bot-quote-chip .bot-reply-bar-excerpt').textContent(), phrase);
    assert.equal(await input.inputValue(), '已有草稿要保留');
    await page.locator('.bot-quote-chip').getByRole('button', { name: '取消引用', exact: true }).click();
    await select();
    await page.locator('.bot-thread').evaluate(node => { node.scrollTop += 500; });
    await action.waitFor({ state: 'detached' });
    await select();
    // The old question is closed; extending into adjacent reply controls still
    // must not turn UI copy into a quote of the body.
    assert.equal(await reply.locator('.bot-cards').count(), 0);
    await reply.evaluate(node => {
      const range = window.getSelection().getRangeAt(0); range.setEndAfter(node.querySelector('.bot-reply-context'));
      document.dispatchEvent(new Event('selectionchange'));
    });
    await action.waitFor({ state: 'detached' });
    cases.push({ width, appearance, ...position });
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.getByRole('button', { name: '机器人设置', exact: true }).click();
  await page.locator(BOT_DETAIL_SURFACE).waitFor();
  await until(() => page.locator('.bot-convo').evaluate(node => node.getBoundingClientRect().width < 700), Boolean);
  await select();
  const docked = await measure();
  assert.ok(docked.fits && docked.gap <= 12);
  await page.screenshot({ path: path.join(captureDirectory, 'selection-quote-docked-light.png'), animations: 'disabled' });
  await page.locator(BOT_DETAIL_CLOSE).click();
  await action.waitFor({ state: 'detached' });
  await until(() => page.locator(BOT_DETAIL_SURFACE).count(), count => count === 0);
  await input.fill(draft);
  await page.setViewportSize(viewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; window.getSelection()?.removeAllRanges(); }, theme);
  // This check deliberately reads an older long reply; return to the newest
  // exchange so the following streaming scenario starts in its declared state.
  const latest = page.getByRole('button', { name: '回到最新消息', exact: true });
  if (await latest.count()) await latest.click();
  await until(() => page.locator('.bot-thread').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop), gap => gap < 2);
  report.selectionQuote = { anchored: true, scrollTracking: true, offscreenDismissed: true,
    keyboard: true, mouseClick: true, draftPreserved: true, bodyBoundary: true, widthReflow: true, dockedFits: true, cases,
    scope: 'Production long Markdown reply, retired question and adjacent reply controls; real browser Range and selectionchange; no model call or user acceptance' };
}
