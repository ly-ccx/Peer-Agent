import assert from 'node:assert/strict';
import path from 'node:path';

/** Assert the actual rendered bubble edge, rather than the full-width article. */
export async function checkReplyPresence({ page, reply, report, until, state, label, captureDirectory, shot }) {
  const samples = report.replyPresence ??= { cases: [], labels: [] };
  const footer = reply.locator('.bot-reply-context');
  if (label) {
    await until(() => footer.locator('.bot-context-running').textContent(), text => text === label);
    assert.equal(await footer.locator('.bot-context-running').evaluate(node => getComputedStyle(node).animationName), 'motion-shimmer');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await footer.locator('.bot-context-running').evaluate(node => getComputedStyle(node).animationName), 'none');
    assert.notEqual(await footer.locator('.bot-context-running').evaluate(node => getComputedStyle(node).webkitTextFillColor), 'rgba(0, 0, 0, 0)');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    samples.labels.push({ state, label, shimmer: true, reducedMotionReadable: true });
  }
  const bounds = await until(() => reply.evaluate(node => {
    const bubbles = [...node.querySelectorAll(':scope > .bot-reply-body, :scope > .bot-narration .markdown-content > *, '
      + ':scope > .bot-cards > .bot-stopped-reply > .bot-reply-body, '
      + ':scope > .bot-cards > .bot-unavailable-reply > .bot-reply-body')];
    const bubble = bubbles.findLast(element => element.getBoundingClientRect().width > 0);
    if (!bubble) return null;
    const body = bubble.getBoundingClientRect(), style = getComputedStyle(bubble), footerNode = node.querySelector('.bot-reply-context');
    const footer = footerNode.getBoundingClientRect(), icon = footerNode.querySelector('button svg').getBoundingClientRect();
    const button = footerNode.querySelector('button').getBoundingClientRect(), column = node.getBoundingClientRect();
    const textLeft = body.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
    return { bodyRight: body.right, bodyLeft: body.left, textLeft, footerLeft: footer.left, actionLeft: button.left,
      columnRight: column.right, fits: button.left >= column.left && button.right <= column.right,
      aligned: Math.abs(textLeft - footer.left) <= 1 && Math.abs(textLeft - icon.left) <= 1,
      unifiedActivity: !footerNode.querySelector('.bot-context-running') || footerNode.querySelector('button .bot-context-running') !== null,
      stableHeight: footer.height >= 32 && button.height >= 32, singleAction: footerNode.querySelectorAll('button').length === 1 };
  }), value => value?.aligned);
  assert.ok(bounds.fits, `${state}: footer remains inside the conversation`);
  assert.ok(bounds.unifiedActivity && bounds.stableHeight && bounds.singleAction, 'one stable, accessible activity/details action');
  samples.cases.push({ state, ...bounds, width: page.viewportSize()?.width,
    theme: await page.evaluate(() => document.documentElement.dataset.theme) });
  if (shot) {
    await reply.hover();
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, shot) });
  }
}
