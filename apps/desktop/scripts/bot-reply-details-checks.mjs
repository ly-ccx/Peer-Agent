import assert from 'node:assert/strict';

/** Enter the actual reply drawer by keyboard, never an inline disclosure. */
export async function openReplyDetails(page, message) {
  const button = message.locator('.bot-reply-context > button');
  assert.equal(await message.locator('.bot-reply-context details, .bot-reply-context > summary').count(), 0);
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
