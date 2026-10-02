import assert from 'node:assert/strict';
import path from 'node:path';

/** Production reply rendering and callbacks; no model, tool or Evidence claims. */
export async function checkBotShellReply({ page, until, report, captureDirectory }) {
  const checks = report.replyInteraction = [];
  const reply = page.locator('#bot-msg-rc-message-9999');
  await reply.scrollIntoViewIfNeeded();
  const quote = reply.locator('.bot-reply-bar');
  assert.ok((await quote.textContent()).includes('请帮我梳理项目现状'));
  assert.equal(await quote.locator('svg').count(), 2);
  assert.equal(await reply.getByRole('button', { name: /通知方式/ }).count(), 0);
  assert.equal(await reply.locator('.bot-reply-delivery').textContent(), '通知方式：即时提醒');
  checks.push('quote is a context button with SVG; delivery policy is explicitly readonly');

  // Inspect actual theme output: undefined legacy tokens previously made these
  // borders disappear. Restore the original attributes after every sample.
  const originalTheme = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, palette: document.documentElement.dataset.palette }));
  report.replyStyles = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.palette = 'frost'; }, theme);
    await reply.evaluate(async node => { await Promise.all(node.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
    const sample = await reply.evaluate(node => {
      const read = selector => {
        const item = node.querySelector(selector), style = getComputedStyle(item);
        return { background: style.backgroundColor, color: style.color, border: style.borderTopWidth, borderStyle: style.borderTopStyle, shadow: style.boxShadow, height: item.getBoundingClientRect().height };
      };
      return { quote: read('.bot-reply-bar'), action: read('.bot-reply-marks button'), delivery: read('.bot-reply-delivery') };
    });
    report.replyStyles.push({ theme, ...sample });
    for (const item of [sample.quote, sample.action]) {
      assert.equal(item.border, '1px'); assert.equal(item.borderStyle, 'solid');
      assert.notEqual(item.background, 'rgba(0, 0, 0, 0)');
      assert.equal(item.shadow, 'none');
    }
    assert.ok(sample.action.height >= 32);
    assert.equal(sample.delivery.border, '0px');
    if (captureDirectory) await reply.screenshot({ path: path.join(captureDirectory, `reply-${theme}.png`) });
  }
  await page.evaluate(original => {
    for (const key of ['theme', 'palette']) if (original[key] === undefined) delete document.documentElement.dataset[key]; else document.documentElement.dataset[key] = original[key];
  }, originalTheme);
  assert.notEqual(report.replyStyles[0].quote.background, report.replyStyles[1].quote.background);
  checks.push('real dark/light context and action surfaces retain borders, readable hierarchy and no outer glow');

  const process = reply.getByRole('button', { name: '查看过程', exact: true });
  await quote.focus();
  assert.equal(await quote.evaluate(node => node === document.activeElement), true);
  await quote.press('Tab');
  report.replyFocus = await process.evaluate(node => ({ active: node === document.activeElement, visible: node.matches(':focus-visible'), outline: getComputedStyle(node).outlineStyle, width: getComputedStyle(node).outlineWidth, actualActive: document.activeElement?.outerHTML, documentFocused: document.hasFocus() }));
  assert.equal(report.replyFocus.active, true);
  assert.equal(report.replyFocus.outline, 'solid');
  assert.equal(report.replyFocus.width, '2px');
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
  await cancel.focus(); await cancel.press('Tab'); await cancel.press('Shift+Tab');
  assert.equal(await cancel.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle === 'solid'), true);
  await cancel.press('Enter'); await composerQuote.waitFor({ state: 'detached' });
  assert.equal(await composer.inputValue(), '保留我的草稿');
  await composer.fill('');
  if (originalViewport) await page.setViewportSize(originalViewport);
  checks.push('selected quote uses the same context treatment, fits a 760px viewport and cancels by keyboard without losing the draft');
}
