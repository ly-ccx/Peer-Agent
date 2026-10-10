import assert from 'node:assert/strict';

/** Enter the actual reply drawer by keyboard, never an inline disclosure. */
export async function openReplyDetails(page, message) {
  const button = message.locator('.bot-reply-context > button');
  assert.equal(await message.locator('.bot-reply-context details, .bot-reply-context > summary').count(), 0);
  await page.locator('.bot-composer textarea').focus();
  await page.mouse.move(1, 1);
  await page.waitForFunction(node => getComputedStyle(node).opacity === '0', await button.elementHandle());
  assert.equal(await button.evaluate(node => getComputedStyle(node).opacity), '0', 'reply details stay quiet until the reply is hovered or focused');
  // A pushed drawer's body can disappear before its width transition finishes.
  // Let the actual finite layout animations finish before choosing a pointer position.
  await message.evaluate(async node => {
    const animations = node.closest('.bot-shell').getAnimations({ subtree: true }).filter(animation => animation.playState === 'running'
      && Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.effect?.target?.checkVisibility());
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  });
  const placement = await button.evaluate(node => {
    const action = node.getBoundingClientRect(), footer = node.parentElement.getBoundingClientRect();
    const status = node.parentElement.querySelector('.bot-context-running')?.getBoundingClientRect();
    return { right: Math.abs(action.right - footer.right), gap: status ? action.left - status.right : null };
  });
  assert.ok(placement.right <= 2, 'details action aligns with the right edge of the reply column');
  if (placement.gap !== null) assert.ok(placement.gap >= 24, 'running status and details action have separate sides');
  // Move the pointer over the visible reply. Locator.hover() would first center
  // the whole element with scrollIntoView, scrolling the document at narrow widths.
  const hoverPoint = await message.evaluate(node => {
    const thread = node.closest('.bot-thread').getBoundingClientRect();
    // The floating "latest reply" control may cover the center of a short reply.
    const areas = [...node.querySelectorAll('.bot-reply-body'), node];
    for (const area of areas) {
      const rect = area.getBoundingClientRect();
      const left = Math.max(rect.left, 0), right = Math.min(rect.right, innerWidth);
      const top = Math.max(rect.top, thread.top, 0), bottom = Math.min(rect.bottom, thread.bottom, innerHeight);
      if (right <= left || bottom <= top) continue;
      const inset = Math.min(12, (right - left) / 4, (bottom - top) / 4);
      for (const [x, y] of [[(left + right) / 2, (top + bottom) / 2], [left + inset, top + inset], [right - inset, top + inset]]) {
        if (node.contains(document.elementFromPoint(x, y))) return { x, y, visible: true };
      }
    }
    return { visible: false };
  });
  assert.equal(hoverPoint.visible, true, 'the reply is visible before a real pointer hovers it');
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
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
