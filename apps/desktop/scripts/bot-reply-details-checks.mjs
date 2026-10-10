import assert from 'node:assert/strict';

/** Enter the actual reply drawer by keyboard, never an inline disclosure. */
export async function openReplyDetails(page, message) {
  const button = message.locator('.bot-reply-context > button');
  assert.equal(await message.locator('.bot-reply-context details, .bot-reply-context > summary').count(), 0);
  await page.locator('.bot-composer textarea').focus();
  await page.mouse.move(1, 1);
  await page.waitForFunction(node => getComputedStyle(node).opacity === '0', await button.elementHandle());
  assert.equal(await button.evaluate(node => getComputedStyle(node).opacity), '0', 'reply details stay quiet until the reply is hovered or focused');
  const placement = await button.evaluate(node => {
    const action = node.getBoundingClientRect(), footer = node.parentElement.getBoundingClientRect();
    const status = node.parentElement.querySelector('.bot-context-running')?.getBoundingClientRect();
    const bubbles = [...node.closest('.bot-reply, .bot-system').querySelectorAll(
      ':scope > .bot-reply-body, :scope > .bot-narration .markdown-content > *, '
      + ':scope > .bot-stopped-reply > .bot-reply-body, :scope > .bot-unavailable-reply > .bot-reply-body')];
    const bubble = bubbles.findLast(element => element.getBoundingClientRect().width > 0)?.getBoundingClientRect();
    return { right: Math.abs(action.right - footer.right), bubbleRight: bubble ? Math.abs(action.right - bubble.right) : null,
      gap: status && action.top < status.bottom ? action.left - status.right : null };
  });
  assert.ok(placement.right <= 2, 'details action aligns with its footer');
  if (placement.bubbleRight !== null) assert.ok(placement.bubbleRight <= 2, 'details action aligns with the current bubble, not the conversation column');
  if (placement.gap !== null) assert.ok(placement.gap >= 24, 'running status and details action have separate sides');
  await message.hover();
  await page.waitForFunction(node => getComputedStyle(node).opacity === '1', await button.elementHandle());
  assert.equal(await button.evaluate(node => getComputedStyle(node).opacity), '1', 'hovering the reply reveals its details');
  await page.mouse.move(1, 1);
  await button.focus(); await button.press('Enter');
  const details = page.locator('.bot-reply-details');
  await details.waitFor({ state: 'visible' });
  assert.equal(await details.evaluate(node => Boolean(node.closest('.bot-drawer-body'))), true);
  assert.equal(await message.locator('.bot-turn-process, .bot-evidence-list, .bot-context-error').count(), 0);
  assert.equal(await page.locator('.bot-drawer-head > p').innerText(), '回复详情');
  return details;
}

export async function closeReplyDetails(page) {
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.bot-drawer-body').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.bot-reply-context > button')), true, 'close restores the current reply footer without scrolling it into view');
}
