import { openReplyDetails, closeReplyDetails } from './bot-reply-details-checks.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';

/** Production reply rendering and callbacks; no model, tool or Evidence claims. */
export async function checkBotShellReply({ page, until, report, captureDirectory }) {
  const checks = report.replyInteraction = [];
  const reply = page.locator('#bot-msg-rc-message-9999');
  await reply.scrollIntoViewIfNeeded();
  const quote = reply.locator('.bot-reply-bar');
  assert.equal(await quote.evaluate(node => Boolean(node.closest('.bot-reply-body'))), true,
    'reply reference must belong to the reply bubble, rather than a detached short-text card');
  assert.ok((await quote.textContent()).includes('请帮我梳理项目现状'));
  assert.equal(await quote.locator('svg').count(), 0);
  assert.equal(await quote.locator('.bot-reply-bar-label').textContent(), '你');
  assert.ok((await quote.getAttribute('aria-label')).startsWith('查看原消息: 你'));
  assert.ok((await quote.getAttribute('title')).endsWith('原文结束标记'));
  assert.equal(await reply.getByRole('button', { name: /通知方式/ }).count(), 0);
  assert.equal(await reply.locator('.bot-reply-delivery').count(), 0);
  await openReplyDetails(page, reply);
  assert.equal(await page.locator('.bot-reply-details .bot-reply-delivery').textContent(), '通知方式：即时提醒');
  await closeReplyDetails(page);
  checks.push('loaded quote names its actual author, preserves full text in its accessible name and tooltip, and removes navigation chrome; delivery stays readonly');

  // Source and excerpt share a line inside the bubble; the new body remains separate.
  // Secondary actions stay quiet; restore theme and disclosure after samples.
  const originalTheme = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, palette: document.documentElement.dataset.palette }));
  const context = reply.locator('.bot-reply-context');
  assert.equal(await context.getAttribute('open'), null);
  assert.equal(await reply.locator('.bot-reply-delivery').isVisible(), false);
  await openReplyDetails(page, reply);
  report.replyStyles = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.palette = 'frost'; }, theme);
    await reply.evaluate(async node => { await Promise.race([Promise.all(node.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))), new Promise(resolve => setTimeout(resolve, 500))]); });
    const sample = await reply.evaluate(node => {
      const read = selector => {
        const item = node.querySelector(selector) ?? document.querySelector(`.bot-reply-details ${selector}`), style = getComputedStyle(item);
        return { background: style.backgroundColor, color: style.color, border: style.borderTopWidth, borderStyle: style.borderTopStyle, edge: style.borderInlineStartWidth, shadow: style.boxShadow, height: item.getBoundingClientRect().height, width: item.getBoundingClientRect().width, font: style.fontSize, clamp: style.webkitLineClamp };
      };
      return { quote: read('.bot-reply-bar'), source: read('.bot-reply-bar-label'), excerpt: read('.bot-reply-bar-excerpt'), action: read('.bot-reply-context > button'), delivery: read('.bot-reply-delivery') };
    });
    report.replyStyles.push({ theme, ...sample });
    assert.equal(sample.quote.border, '0px');
    assert.equal(sample.quote.background, 'rgba(0, 0, 0, 0)');
    assert.equal(sample.quote.edge, '0px');
    assert.equal(sample.quote.shadow, 'none');
    assert.ok(sample.quote.height >= 28 && sample.quote.height <= 44);
    const geometry = await quote.evaluate(node => {
      const quote = node.getBoundingClientRect(), bubble = node.closest('.bot-reply-body').getBoundingClientRect();
      const source = node.querySelector('.bot-reply-bar-label').getBoundingClientRect();
      const excerpt = node.querySelector('.bot-reply-bar-excerpt').getBoundingClientRect();
      const text = node.closest('.bot-reply-body').querySelector('.bot-reply-text').getBoundingClientRect();
      return { inside: quote.left >= bubble.left && quote.right <= bubble.right && quote.top >= bubble.top,
        horizontal: excerpt.left > source.right && Math.abs(source.top + source.height / 2 - excerpt.top - excerpt.height / 2) < 1,
        aboveBody: quote.bottom < text.top, aligned: Math.abs(quote.left - text.left) < 1 };
    });
    assert.ok(Object.values(geometry).every(Boolean), JSON.stringify(geometry));
    assert.equal(sample.source.font, '11px'); assert.equal(sample.excerpt.font, '12px');
    assert.equal(sample.excerpt.clamp, '2');
    assert.equal(sample.action.background, 'rgba(0, 0, 0, 0)');
    assert.equal(sample.action.shadow, 'none');
    assert.ok(sample.action.height >= 27);
    assert.equal(sample.delivery.border, '0px');
    await closeReplyDetails(page);
    if (captureDirectory) await reply.locator('..').screenshot({ path: path.join(captureDirectory, `reply-${theme}.png`), animations: 'disabled' });
    await openReplyDetails(page, reply);
  }
  await page.evaluate(original => {
    for (const key of ['theme', 'palette']) if (original[key] === undefined) delete document.documentElement.dataset[key]; else document.documentElement.dataset[key] = original[key];
  }, originalTheme);
  assert.notEqual(report.replyStyles[0].excerpt.color, report.replyStyles[1].excerpt.color);
  checks.push('dark/light references share a horizontal row inside the reply bubble, aligned with its text, with no separate card or leading vertical edge');

  await closeReplyDetails(page);
  await checkShortReplyQuote({ page, report, captureDirectory });

  const process = reply.getByRole('button', { name: '查看详情', exact: true });
  await quote.focus();
  assert.equal(await quote.evaluate(node => node === document.activeElement), true);
  await quote.press('Enter');
  await page.locator('#bot-msg-rc-message-9500.is-anchored').waitFor();
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await reply.scrollIntoViewIfNeeded();
  await quote.focus();
  await quote.press('Tab');
  assert.equal(await reply.locator('.bot-reply-context > button').first().evaluate(node => node === document.activeElement), true);
  // Source navigation can virtualize this reply out and remount its closed
  // disclosure. Reopen through the UI before testing the nested action.
  assert.equal(await context.locator('details, summary').count(), 0);
  await process.focus();
  report.replyFocus = await process.evaluate(node => ({ active: node === document.activeElement, visible: node.matches(':focus-visible'), outline: getComputedStyle(node).outlineStyle, width: getComputedStyle(node).outlineWidth, actualActive: document.activeElement?.outerHTML, documentFocused: document.hasFocus() }));
  assert.equal(report.replyFocus.active, true);
  assert.equal(report.replyFocus.outline, 'solid');
  assert.equal(report.replyFocus.width, '1px');
  await page.locator('.bot-profile').hover();
  await process.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  const normal = await process.evaluate(node => getComputedStyle(node).color);
  await process.hover();
  await until(() => process.evaluate(node => getComputedStyle(node).color), color => color !== normal);
  await process.press('Enter');
  await page.locator('.bot-reply-details').waitFor();
  assert.equal(await page.locator('.bot-reply-details .bot-turn-process').count(), 0, 'ordinary fixture has no fabricated execution record');
  assert.equal(await page.locator('.bot-drawer-head > p').innerText(), '回复详情');
  await closeReplyDetails(page);
  checks.push('process action has hover and visible keyboard focus; Enter opens the existing process drawer');

  await openReplyDetails(page, reply);
  await page.locator('.bot-reply-details .bot-memory-chip button').click();
  await page.locator('.bot-reply-details .bot-memory-chip li').waitFor();
  assert.ok((await page.locator('.bot-reply-details .bot-memory-chip li').textContent()).includes('Synthetic memory 123'));
  assert.equal(await page.locator('.bot-reply-details .bot-memory-chip button').getAttribute('aria-expanded'), 'true');
  await page.locator('.bot-reply-details .bot-memory-chip button').click();
  assert.equal(await page.locator('.bot-reply-details .bot-memory-chip li').count(), 0);
  await closeReplyDetails(page);
  checks.push('memory disclosure retrieves the canonical memory and collapses without a nested status pill');

  // Select an actual rendered range then exercise the product mouse-up handler.
  const selected = await reply.locator('.bot-reply-text').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return selection.toString().replace(/\s+/g, ' ').trim();
  });
  await page.getByRole('button', { name: '引用', exact: true }).click();
  const composerQuote = page.locator('.bot-quote-chip');
  assert.equal(selected.includes('原文结束标记'), false, 'selecting the new reply must not capture its quoted source');
  assert.equal(await composerQuote.locator('.bot-reply-bar-excerpt').textContent(), selected);
  assert.equal(await composerQuote.locator('.bot-reply-bar-label').textContent(), 'project-000');
  assert.equal(await composerQuote.evaluate(node => getComputedStyle(node).borderInlineStartWidth), '0px');
  const composer = page.locator('.bot-composer textarea');
  await composer.fill('保留我的草稿');
  const originalViewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 760, height: 780 });
  await reply.scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  const quoteLayout = await composerQuote.evaluate(node => ({ width: node.clientWidth, overflow: node.scrollWidth, height: node.getBoundingClientRect().height }));
  assert.ok(quoteLayout.overflow <= quoteLayout.width); assert.ok(quoteLayout.height <= 74);
  if (captureDirectory) await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'reply-narrow-quote.png') });
  const cancel = composerQuote.getByRole('button', { name: '取消引用', exact: true });
  await cancel.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await cancel.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle === 'solid'), true);
  await cancel.press('Enter'); await composerQuote.waitFor({ state: 'detached' });
  assert.equal(await composer.inputValue(), '保留我的草稿');
  await composer.fill('');
  // Submit a real explicit quote through the existing composer and durable IPC.
  await reply.locator('.bot-reply-text').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '引用', exact: true }).click();
  await composer.fill('针对这段原文补充说明'); await composer.press('Enter');
  await composerQuote.waitFor({ state: 'detached' });
  const explicit = page.locator('.bot-user').filter({ has: page.locator('.bot-user-text', { hasText: '针对这段原文补充说明' }) });
  const explicitQuote = explicit.locator('.bot-user-quote');
  await explicitQuote.waitFor();
  assert.equal(await explicitQuote.locator('.bot-reply-bar-label').textContent(), 'project-000');
  assert.equal(await explicitQuote.locator('.bot-reply-bar-excerpt').textContent(), selected);
  assert.notEqual(await explicitQuote.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await explicitQuote.evaluate(node => getComputedStyle(node).borderInlineStartWidth), '0px');
  assert.equal(await page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  if (captureDirectory) await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'reply-narrow-sent.png') });
  await page.setViewportSize({ width: 1280, height: 780 });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.palette = 'frost'; }, theme);
    await explicit.scrollIntoViewIfNeeded();
    await explicit.evaluate(async node => { await Promise.race([Promise.all(node.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))), new Promise(resolve => setTimeout(resolve, 500))]); });
    assert.equal(await explicit.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    if (captureDirectory) await page.screenshot({ path: path.join(captureDirectory, `quote-sent-1280-${theme}.png`), animations: 'disabled' });
  }
  await page.evaluate(original => {
    for (const key of ['theme', 'palette']) if (original[key] === undefined) delete document.documentElement.dataset[key]; else document.documentElement.dataset[key] = original[key];
  }, originalTheme);
  await explicitQuote.press('Enter');
  await page.locator('#bot-msg-rc-message-9999.is-anchored').waitFor();
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  if (originalViewport) await page.setViewportSize(originalViewport);
  checks.push('selected quote shows its actual source, fits a 760px viewport and cancels by keyboard without losing the draft');
  checks.push('explicit quote leaves the composer on send, names the real bot source inside the user bubble and navigates to that source by keyboard');
}

async function checkShortReplyQuote({ page, report, captureDirectory }) {
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const reply = page.locator('#bot-msg-rc-message-9996');
  const quote = reply.locator('.bot-reply-bar');
  report.shortReplyQuote = [];
  for (const width of [1280, 760]) for (const appearance of ['dark', 'light']) {
    await page.setViewportSize({ width, height: 860 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    await reply.locator('..').scrollIntoViewIfNeeded();
    assert.equal(await quote.locator('.bot-reply-bar-excerpt').innerText(), '熟悉仓库');
    const shape = await quote.evaluate(node => {
      const row = node.getBoundingClientRect(), body = node.closest('.bot-reply-body')?.getBoundingClientRect();
      const source = node.querySelector('.bot-reply-bar-label').getBoundingClientRect();
      const excerpt = node.querySelector('.bot-reply-bar-excerpt').getBoundingClientRect();
      return { inside: Boolean(body && row.left >= body.left && row.right <= body.right && row.top >= body.top),
        horizontal: excerpt.left > source.right && Math.abs(source.top - excerpt.top) < 3,
        compact: row.height <= 32, fits: node.scrollWidth <= node.clientWidth };
    });
    assert.ok(Object.values(shape).every(Boolean), JSON.stringify(shape));
    if (captureDirectory) await page.screenshot({ path: path.join(captureDirectory, `quote-reply-${width}-${appearance}.png`), animations: 'disabled' });
    report.shortReplyQuote.push({ width, appearance, ...shape });
  }
  await page.setViewportSize(viewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.locator('#bot-msg-rc-message-9999').scrollIntoViewIfNeeded();
}
