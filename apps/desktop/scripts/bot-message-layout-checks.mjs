import { openReplyDetails, closeReplyDetails } from './bot-reply-details-checks.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';

/** Failures stay visible; long provider diagnostics are readable on request. */
export async function checkBotMessageLayout({ page, until, report, captureDirectory, expectedText }) {
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const message = page.locator('#bot-msg-rc-message-9998');
  const card = message.locator('.bot-card');
  const details = page.locator('.bot-reply-details');
  const rawError = details.locator('.bot-context-error pre');
  const budgetMessage = page.locator('#bot-msg-rc-message-9997');
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    await budgetMessage.scrollIntoViewIfNeeded();
    assert.equal(await budgetMessage.locator('.bot-card > p').textContent(), '本轮检查已达到上限，回复尚未完成。已有进展已保留，你可以重试或发送新消息。');
    assert.equal(await budgetMessage.getByRole('button', { name: '重发', exact: true }).count(), 1);
    assert.equal(await budgetMessage.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.doesNotMatch(await budgetMessage.innerText(), /agent_tool_budget_exhausted/);
    await openReplyDetails(page, budgetMessage);
    assert.match(await rawError.textContent(), /^代理暂时不可用：agent_tool_budget_exhausted:/);
    await closeReplyDetails(page);
    await budgetMessage.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(captureDirectory, `budget-exhausted-${appearance}.png`), animations: 'disabled' });
  }
  report.budgetFailure = { reasonVisible: true, diagnosticInDrawer: true, retryVisible: true, narrowFits: true };
  const cases = [];
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 780 });
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
      for (const docked of width === 1280 ? [false, true] : [false]) {
        if (docked) {
          await page.locator('.bot-profile').click();
          await page.locator('.bot-drawer-dock.is-open').waitFor();
          await until(() => page.locator('.bot-convo').evaluate(node => node.getBoundingClientRect().width < 700), Boolean);
        }
        await card.scrollIntoViewIfNeeded();
        if (await page.getByRole('button', { name: '关闭', exact: true }).isVisible()) {
          await page.getByRole('button', { name: '关闭', exact: true }).click();
          await page.locator('.bot-drawer-body').waitFor({ state: 'hidden' });
        }
        await rawError.waitFor({ state: 'hidden' });
        assert.equal(await card.locator(':scope > p').textContent(), '暂时无法完成回复。', 'failure is stated plainly outside technical details');
        assert.equal(await rawError.isVisible(), false, 'raw provider JSON is not in the default conversation');
        await openReplyDetails(page, message);
        await rawError.waitFor({ state: 'visible' });
        assert.equal(await rawError.textContent(), expectedText, 'full error must remain available, without truncation');
        const bounds = await details.evaluate(node => {
          const paragraph = node.querySelector('.bot-context-error pre');
          const rect = paragraph.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(paragraph);
          const fragments = [...range.getClientRects()].filter(box => box.width > 0);
          return {
            textFits: fragments.every(box => box.left >= rect.left - 1 && box.right <= rect.right + 1),
            lines: fragments.length,
            cardFits: node.scrollWidth <= node.clientWidth,
            conversationFits: document.querySelector('.bot-convo').scrollWidth <= document.querySelector('.bot-convo').clientWidth,
          };
        });
        assert.ok(bounds.textFits && bounds.cardFits && bounds.conversationFits,
          `long error must fit its text area, card and conversation: ${JSON.stringify({ width, appearance, docked, ...bounds })}`);
        assert.ok(bounds.lines > 1, 'long error should wrap into readable lines');
        cases.push({ viewportWidth: width, appearance, docked, diagnosticsCollapsed: true, detailsKeyboard: true, ...bounds });
        if (width === 760 && appearance === 'dark') await closeReplyDetails(page);
        await page.waitForTimeout(180);
        await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `long-error-${docked ? 'docked' : width}-${appearance}.png`) });
        if (await page.getByRole('button', { name: '关闭', exact: true }).isVisible()) await closeReplyDetails(page);
      }
    }
  }
  await page.setViewportSize(viewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.locator('#bot-msg-rc-message-9999').scrollIntoViewIfNeeded();
  assert.equal(await message.locator('.bot-reply-context > button').count(), 1);
  report.messageLayout = { completeText: true, fitBounds: true, diagnosticsCollapsed: true, detailsKeyboard: true, cases,
    scope: 'Production system-card rendering from isolated canonical conversation data, including long JSON, URL and unbroken ID; no provider network' };
}
