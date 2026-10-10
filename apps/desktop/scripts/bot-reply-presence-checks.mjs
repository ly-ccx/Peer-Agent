import assert from 'node:assert/strict';
import path from 'node:path';

/** Assert the actual rendered bubble edge, rather than the full-width article. */
export async function checkReplyPresence({ page, reply, report, until, state, label, captureDirectory, shot }) {
  const samples = report.replyPresence ??= { cases: [], labels: [] };
  const footer = reply.locator('.bot-reply-context');
  if (label) {
    await until(() => footer.locator('.bot-context-running').textContent(), text => text === label);
    assert.equal(await footer.locator('.bot-context-running').evaluate(node => getComputedStyle(node).animationName), 'none');
    samples.labels.push({ state, label, noShimmer: true });
  }
  const bounds = await until(() => reply.evaluate(node => {
    const bubbles = [...node.querySelectorAll(':scope > .bot-reply-body, :scope > .bot-narration .markdown-content > *')];
    const bubble = bubbles.findLast(element => element.getBoundingClientRect().width > 0);
    if (!bubble) return null;
    const body = bubble.getBoundingClientRect(), footer = node.querySelector('.bot-reply-context').getBoundingClientRect();
    const button = node.querySelector('.bot-reply-context > button').getBoundingClientRect(), column = node.getBoundingClientRect();
    return { bodyRight: body.right, bodyLeft: body.left, footerRight: footer.right, actionRight: button.right,
      columnRight: column.right, fits: button.left >= column.left && button.right <= column.right,
      aligned: Math.abs(body.right - footer.right) <= 1 && Math.abs(body.right - button.right) <= 1 };
  }), value => value?.aligned);
  assert.ok(bounds.fits, `${state}: footer remains inside the conversation`);
  samples.cases.push({ state, ...bounds, width: page.viewportSize()?.width,
    theme: await page.evaluate(() => document.documentElement.dataset.theme) });
  if (shot) {
    await reply.hover();
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, shot) });
  }
}
