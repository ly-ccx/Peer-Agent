import assert from 'node:assert/strict';
import path from 'node:path';

/** Assert the actual rendered bubble edge, rather than the full-width article. */
export async function checkReplyPresence({ page, reply, report, until, state, quiet = false, captureDirectory, shot }) {
  const samples = report.replyPresence ??= { cases: [] };
  const footer = reply.locator('.bot-reply-context');
  if (quiet) {
    // Public prose keeps one stable replying cue; process and elapsed-time copy stay in details.
    const labels = await footer.locator('.bot-context-running').allTextContents();
    assert.deepEqual(labels, ['正在回复'], 'public prose retains exactly one stable replying label');
    assert.equal(await footer.locator('.bot-reply-typing-dots.is-active > circle').count(), 3, 'running replies use three active SVG dots');
    assert.equal(await footer.locator(':scope > button').count(), 1, 'ordinary replying has one details action and no refresh action');
    assert.doesNotMatch(await footer.textContent(), /正在整理回复|准备阅读|正在阅读|正在准备下一步|消息已收到|正在同步回复|等待处理进展/);
  }
  const bounds = await until(() => reply.evaluate(node => {
    const bubbles = [...node.querySelectorAll(':scope > .bot-reply-body, :scope > .bot-continuous-paragraphs > .bot-reply-body, :scope > .bot-narration:not(.bot-continuous-paragraphs) .markdown-content > *, '
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
      stableHeight: footer.height >= 32 && button.height >= 32, singleAction: footerNode.querySelectorAll(':scope > button:not(:disabled)').length >= 1 };
  }), value => value?.aligned);
  assert.ok(bounds.fits, `${state}: footer remains inside the conversation`);
  assert.ok(bounds.unifiedActivity && bounds.stableHeight && bounds.singleAction, 'one stable, accessible activity/details action');
  samples.cases.push({ state, quiet, ...bounds, width: page.viewportSize()?.width,
    theme: await page.evaluate(() => document.documentElement.dataset.theme) });
  if (shot) {
    await reply.hover();
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, shot) });
  }
}
