import assert from 'node:assert/strict';

/** Reach an unmounted row through the real scroller; never disable virtualization. */
export async function scrollToBotMessage(page, message) {
  if (!await message.count()) {
    const thread = page.locator('.bot-thread');
    // Numeric IDs belong to this ordered 10,000-message fixture, not production identity.
    const match = /#bot-msg-rc-message-(\d+)/.exec(message.toString());
    const target = match ? Number(match[1]) : null;
    if (target === null) await thread.evaluate(node => { node.scrollTop = 0; });
    for (let step = 0; step < 240; step++) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (await message.count()) break;
      const state = await thread.evaluate(node => ({ busy: node.getAttribute('aria-busy') === 'true',
        ids: [...node.querySelectorAll('[id^="bot-msg-rc-message-"]')].map(row => Number(row.id.match(/(\d+)$/)?.[1])).filter(Number.isFinite) }));
      if (state.busy) { await page.locator('.bot-thread[aria-busy="false"]').waitFor(); continue; }
      const direction = target === null ? 1 : !state.ids.length || target < Math.min(...state.ids) ? -1 : 1;
      const moved = await thread.evaluate((node, direction) => {
        const before = node.scrollTop;
        node.scrollTop += direction * Math.max(80, node.clientHeight * 0.65);
        return node.scrollTop !== before;
      }, direction);
      if (!moved) {
        const older = page.locator('.bot-thread-older');
        if (direction < 0 && await older.count() && await older.isEnabled()) { await older.click(); continue; }
        break;
      }
    }
  }
  await message.scrollIntoViewIfNeeded();
}

/** Enter the actual reply drawer by keyboard, never an inline disclosure. */
export async function openReplyDetails(page, message) {
  await scrollToBotMessage(page, message);
  const history = message.locator('.bot-recovery-history');
  if (await history.count()) {
    if (!await history.evaluate(node => node.open)) {
      await history.locator(':scope > summary').focus(); await history.locator(':scope > summary').press('Enter');
    }
    const action = history.getByRole('button', { name: '回复详情', exact: true });
    await action.focus(); await action.press('Enter');
    await page.locator('.bot-reply-details').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.bot-reply-details').evaluate(node => Boolean(node.closest('.bot-drawer-body'))), true);
    return;
  }
  const button = message.locator('.bot-reply-context > button').first();
  assert.equal(await message.locator('.bot-reply-context details, .bot-reply-context > summary').count(), 0);
  await page.locator('.bot-composer textarea').focus();
  await page.mouse.move(1, 1);
  const running = await message.locator('.bot-reply-context').getAttribute('data-running') === 'true';
  await page.waitForFunction(({ node, running }) => getComputedStyle(node).opacity === (running ? '1' : '0'), { node: await button.elementHandle(), running });
  assert.equal(await button.evaluate(node => getComputedStyle(node).opacity), running ? '1' : '0', 'live activity remains visible; completed details wait for hover or focus');
  // A pushed drawer's body can disappear before its width transition finishes.
  // Let the actual finite layout animations finish before choosing a pointer position.
  await page.waitForFunction(() => {
    const shell = document.querySelector('.bot-shell');
    return shell && !shell.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'
      && Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.effect?.target?.checkVisibility());
  });
  await scrollToBotMessage(page, message);
  const placement = await button.evaluate(node => {
    const action = node.getBoundingClientRect(), footer = node.parentElement.getBoundingClientRect();
    const bubbles = [...node.closest('.bot-reply, .bot-system').querySelectorAll(
      ':scope > .bot-reply-body, :scope > .bot-continuous-paragraphs > .bot-reply-body, :scope > .bot-narration:not(.bot-continuous-paragraphs) .markdown-content > *, '
      + ':scope > .bot-cards > .bot-stopped-reply > .bot-reply-body, '
      + ':scope > .bot-cards > .bot-unavailable-reply > .bot-reply-body')];
    const bubble = bubbles.findLast(element => element.getBoundingClientRect().width > 0);
    const style = bubble ? getComputedStyle(bubble) : null;
    const textLeft = bubble ? bubble.getBoundingClientRect().left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) : null;
    const icon = node.querySelector('svg').getBoundingClientRect();
    return { left: Math.abs(icon.left - footer.left), bubbleLeft: textLeft === null ? null : Math.abs(icon.left - textLeft), height: action.height };
  });
  assert.ok(placement.left <= 2 && placement.height >= 32, 'details icon aligns left with its footer and keeps a usable hit target');
  if (placement.bubbleLeft !== null) assert.ok(placement.bubbleLeft <= 2, 'details starts on the current bubble text column');
  // Move the pointer over the visible reply. Locator.hover() would first center
  // the whole element with scrollIntoView, scrolling the document at narrow widths.
  const visibleHoverPoint = () => message.evaluate(node => {
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
  // Virtual row measurements may still move a reply after its CSS animations
  // finish. Recompute real pointer coordinates until Chromium confirms :hover;
  // do not retry the scenario or force the details button visible.
  const deadline = Date.now() + 15000;
  let revealed = false;
  while (!revealed && Date.now() < deadline) {
    const point = await visibleHoverPoint();
    assert.equal(point.visible, true, 'the reply is visible before a real pointer hovers it');
    await page.mouse.move(1, 1);
    await page.mouse.move(point.x, point.y, { steps: 2 });
    // Keep the actual pointer still while its opacity transition finishes.
    // Moving out every 50ms repeatedly restarted the 120ms transition on Linux.
    await page.waitForFunction(node => node.getAnimations().every(animation => animation.playState !== 'running'
      || !Number.isFinite(animation.effect?.getComputedTiming().endTime)), await button.elementHandle(), { timeout: 15000 });
    revealed = await button.evaluate(node => getComputedStyle(node).opacity === '1'
      && node.closest('.bot-reply, .bot-system').matches(':hover'));
    if (!revealed) await page.waitForTimeout(50);
  }
  assert.equal(revealed, true, 'a real pointer over the current reply reveals its details');
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
  const replyId = await page.locator('.bot-reply-details').getAttribute('data-reply-id');
  const mountedTrigger = await page.evaluate(id => {
    const reply = document.getElementById(`bot-msg-${id}`)?.closest('.bot-reply, .bot-system');
    return Boolean(reply?.querySelector('.bot-reply-context > button, .bot-recovery-history-body > button'));
  }, replyId);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.bot-drawer-body').waitFor({ state: 'hidden' });
  // Cancelling work in the scrolled tail can unmount the original reply. The
  // existing drawer contract then returns focus to the thread with preventScroll.
  assert.equal(await page.evaluate(mounted => {
    const focused = document.activeElement;
    return focused?.matches('.bot-reply-context > button, .bot-recovery-history-body > button')
      || !mounted && focused?.matches('.bot-thread');
  }, mountedTrigger), true, 'close restores the current details button, or the thread when its original reply was virtualized away');
}
