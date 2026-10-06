import assert from 'node:assert/strict';
import path from 'node:path';

/** Production reply rendering and callbacks; no model, tool or Evidence claims. */
export async function checkBotShellReply({ page, until, report, captureDirectory }) {
  const checks = report.replyInteraction = [];
  const reply = page.locator('#bot-msg-rc-message-9999');
  await reply.scrollIntoViewIfNeeded();
  const quote = reply.locator('.bot-reply-bar');
  assert.ok((await quote.textContent()).includes('请帮我梳理项目现状'));
  assert.equal(await quote.locator('svg').count(), 0);
  assert.equal(await quote.locator('.bot-reply-bar-label').textContent(), '你');
  assert.ok((await quote.getAttribute('aria-label')).startsWith('查看原消息: 你'));
  assert.ok((await quote.getAttribute('title')).endsWith('原文结束标记'));
  assert.equal(await reply.getByRole('button', { name: /通知方式/ }).count(), 0);
  assert.equal(await reply.locator('.bot-reply-delivery').textContent(), '通知方式：即时提醒');
  checks.push('loaded quote names its actual author, preserves full text in its accessible name and tooltip, and removes navigation chrome; delivery stays readonly');

  // The quote is attached context above the body, with no standalone card.
  // Secondary actions stay quiet; restore theme and disclosure after samples.
  const originalTheme = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, palette: document.documentElement.dataset.palette }));
  const context = reply.locator('.bot-reply-context');
  assert.equal(await context.getAttribute('open'), null);
  assert.equal(await reply.locator('.bot-reply-delivery').isVisible(), false);
  await context.locator(':scope > summary').click();
  report.replyStyles = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.palette = 'frost'; }, theme);
    await reply.evaluate(async node => { await Promise.race([Promise.all(node.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))), new Promise(resolve => setTimeout(resolve, 500))]); });
    const sample = await reply.evaluate(node => {
      const read = selector => {
        const item = node.querySelector(selector), style = getComputedStyle(item);
        return { background: style.backgroundColor, color: style.color, border: style.borderTopWidth, borderStyle: style.borderTopStyle, shadow: style.boxShadow, height: item.getBoundingClientRect().height, width: item.getBoundingClientRect().width, font: style.fontSize, clamp: style.webkitLineClamp };
      };
      return { quote: read('.bot-reply-bar'), source: read('.bot-reply-bar-label'), excerpt: read('.bot-reply-bar-excerpt'), action: read('.bot-context-process'), delivery: read('.bot-reply-delivery') };
    });
    report.replyStyles.push({ theme, ...sample });
    assert.equal(sample.quote.border, '0px');
    assert.equal(sample.quote.background, 'rgba(0, 0, 0, 0)');
    assert.equal(sample.quote.shadow, 'none');
    assert.ok(sample.quote.height >= 44 && sample.quote.height <= 66);
    assert.ok(sample.quote.width <= 360);
    assert.equal(sample.source.font, '11px'); assert.equal(sample.excerpt.font, '13px');
    assert.equal(sample.excerpt.clamp, '2');
    assert.equal(sample.action.background, 'rgba(0, 0, 0, 0)');
    assert.equal(sample.action.shadow, 'none');
    assert.ok(sample.action.height >= 27);
    assert.equal(sample.delivery.border, '0px');
    await context.locator(':scope > summary').click();
    if (captureDirectory) await reply.locator('..').screenshot({ path: path.join(captureDirectory, `reply-${theme}.png`), animations: 'disabled' });
    await context.locator(':scope > summary').click();
  }
  await page.evaluate(original => {
    for (const key of ['theme', 'palette']) if (original[key] === undefined) delete document.documentElement.dataset[key]; else document.documentElement.dataset[key] = original[key];
  }, originalTheme);
  assert.notEqual(report.replyStyles[0].excerpt.color, report.replyStyles[1].excerpt.color);
  checks.push('dark/light quotes use compact 11px source and 13px two-line excerpts, with a 44px hit area and no background, border or shadow');

  const process = reply.getByRole('button', { name: '查看过程', exact: true });
  await quote.focus();
  assert.equal(await quote.evaluate(node => node === document.activeElement), true);
  await quote.press('Enter');
  await page.locator('#bot-msg-rc-message-9500.is-anchored').waitFor();
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await reply.scrollIntoViewIfNeeded();
  await quote.focus();
  await quote.press('Tab');
  assert.equal(await reply.locator('.bot-work-row > summary, .bot-reply-context > summary').first().evaluate(node => node === document.activeElement), true);
  // Source navigation can virtualize this reply out and remount its closed
  // disclosure. Reopen through the UI before testing the nested action.
  if (await context.getAttribute('open') === null) await context.locator(':scope > summary').click();
  await process.focus();
  report.replyFocus = await process.evaluate(node => ({ active: node === document.activeElement, visible: node.matches(':focus-visible'), outline: getComputedStyle(node).outlineStyle, width: getComputedStyle(node).outlineWidth, actualActive: document.activeElement?.outerHTML, documentFocused: document.hasFocus() }));
  assert.equal(report.replyFocus.active, true);
  assert.equal(report.replyFocus.outline, 'solid');
  assert.equal(report.replyFocus.width, '2px');
  await page.locator('.bot-profile').hover();
  await process.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  const normal = await process.evaluate(node => getComputedStyle(node).backgroundColor);
  await process.hover();
  await until(() => process.evaluate(node => getComputedStyle(node).backgroundColor), color => color !== normal);
  await process.press('Enter');
  await page.locator('.bot-process').waitFor();
  assert.equal(await page.locator('.bot-process').getAttribute('aria-label'), '过程');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  checks.push('process action has hover and visible keyboard focus; Enter opens the existing process drawer');

  await reply.locator('.bot-memory-chip button').click();
  await reply.locator('.bot-memory-chip li').waitFor();
  assert.ok((await reply.locator('.bot-memory-chip li').textContent()).includes('Synthetic memory 123'));
  assert.equal(await reply.locator('.bot-memory-chip button').getAttribute('aria-expanded'), 'true');
  await reply.locator('.bot-memory-chip button').click();
  assert.equal(await reply.locator('.bot-memory-chip li').count(), 0);
  checks.push('memory disclosure retrieves the canonical memory and collapses without a nested status pill');

  // Select an actual rendered range then exercise the product mouse-up handler.
  const selected = await reply.locator('.bot-reply-body').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return selection.toString().replace(/\s+/g, ' ').trim();
  });
  await reply.getByRole('button', { name: '引用', exact: true }).click();
  const composerQuote = page.locator('.bot-quote-chip');
  assert.equal(await composerQuote.locator('span').textContent(), selected);
  const composer = page.locator('.bot-composer textarea');
  await composer.fill('保留我的草稿');
  const originalViewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 760, height: 780 });
  await reply.scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  const quoteLayout = await composerQuote.evaluate(node => ({ width: node.clientWidth, overflow: node.scrollWidth, height: node.getBoundingClientRect().height }));
  assert.ok(quoteLayout.overflow <= quoteLayout.width); assert.ok(quoteLayout.height <= 65);
  if (captureDirectory) await page.screenshot({ path: path.join(captureDirectory, 'reply-narrow-quote.png') });
  const cancel = composerQuote.getByRole('button', { name: '取消引用', exact: true });
  await cancel.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await cancel.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle === 'solid'), true);
  await cancel.press('Enter'); await composerQuote.waitFor({ state: 'detached' });
  assert.equal(await composer.inputValue(), '保留我的草稿');
  await composer.fill('');
  // Submit a real explicit quote through the existing composer and durable IPC.
  await reply.locator('.bot-reply-body').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await reply.getByRole('button', { name: '引用', exact: true }).click();
  await composer.fill('针对这段原文补充说明'); await composer.press('Enter');
  await composerQuote.waitFor({ state: 'detached' });
  const explicit = page.locator('.bot-user').filter({ has: page.locator('.bot-user-text', { hasText: '针对这段原文补充说明' }) });
  const explicitQuote = explicit.locator('.bot-user-quote');
  await explicitQuote.waitFor();
  assert.equal(await explicitQuote.locator('.bot-reply-bar-label').textContent(), 'project-000');
  assert.equal(await explicitQuote.locator('.bot-reply-bar-excerpt').textContent(), selected);
  assert.equal(await explicitQuote.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  if (captureDirectory) await page.screenshot({ path: path.join(captureDirectory, 'reply-narrow-sent.png') });
  await explicitQuote.press('Enter');
  await page.locator('#bot-msg-rc-message-9999.is-anchored').waitFor();
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  if (originalViewport) await page.setViewportSize(originalViewport);
  checks.push('selected quote uses the same context treatment, fits a 760px viewport and cancels by keyboard without losing the draft');
  checks.push('explicit quote leaves the composer on send, names the real bot source inside the user bubble and navigates to that source by keyboard');
}
