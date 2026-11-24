import assert from 'node:assert/strict';
import path from 'node:path';

/** Assert the actual rendered bubble edge, rather than the full-width article. */
export async function checkReplyPresence({ page, reply, report, until, state, quiet = false, captureDirectory, shot }) {
  const samples = report.replyPresence ??= { cases: [] };
  const footer = reply.locator('.bot-reply-context');
  if (quiet) {
    // Public prose keeps a concise single-line activity cue; parameters, results and elapsed-time copy stay in details.
    const labels = await footer.locator('.bot-context-running').allTextContents();
    assert.equal(labels.length, 1, 'public prose retains exactly one live activity label');
    assert.match(labels[0], /^(?:正在回复|等待模型响应|正在整理思路|正在整理回复|正在整理结果|正在查找相关内容|正在阅读.*|正在查看.*|正在执行.*|正在调整.*|正在核对.*|正在安排.*|正在更新.*|正在一点一点推进|准备阅读.*|正在准备下一步)$/);
    assert.equal(await footer.locator('.bot-reply-typing-dots.is-active > circle').count(), 3, 'running replies use three active SVG dots');
    assert.equal(await footer.locator(':scope > button').count(), 1, 'ordinary replying has one details action and no refresh action');
    assert.doesNotMatch(await footer.textContent(), /消息已收到|正在同步回复|等待处理进展/);
  }
  const bounds = await until(() => reply.evaluate(node => {
    const bubbles = [...node.querySelectorAll(':scope > .bot-reply-body, :scope > .bot-continuous-paragraphs > .bot-reply-body, :scope > .bot-narration:not(.bot-continuous-paragraphs) .markdown-content > *, '
      + ':scope > .bot-cards > .bot-stopped-reply > .bot-reply-body, '
      + ':scope > .bot-cards > .bot-unavailable-reply > .bot-reply-body')];
    const bubble = bubbles.findLast(element => element.getBoundingClientRect().width > 0);
    if (!bubble) return null;
    const body = bubble.getBoundingClientRect(), style = getComputedStyle(bubble), footerNode = node.querySelector('.bot-reply-context');
    const buttonNode = footerNode.querySelector('button');
    if (!buttonNode) return null;
    const footer = footerNode.getBoundingClientRect(), button = buttonNode.getBoundingClientRect(), column = node.getBoundingClientRect();
    const anchor = (buttonNode.querySelector('svg') ?? buttonNode.querySelector('span') ?? buttonNode).getBoundingClientRect();
    const textLeft = body.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
    const textRight = body.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
    const quote = [...footerNode.querySelectorAll(':scope > button')].find(item => item !== buttonNode && item.textContent.trim() === '引用');
    const quoteRight = quote ? quote.getBoundingClientRect().right : null;
    return { bodyRight: body.right, bodyLeft: body.left, textLeft, textRight, footerLeft: footer.left, actionLeft: button.left,
      columnRight: column.right, fits: button.left >= column.left && button.right <= column.right && (quoteRight === null || quoteRight <= column.right + 1),
      aligned: Math.abs(textLeft - footer.left) <= 1 && Math.abs(textLeft - anchor.left) <= 1 && (quoteRight === null || Math.abs(quoteRight - textRight) <= 2),
      unifiedActivity: !footerNode.querySelector('.bot-context-running') || footerNode.querySelector('button .bot-context-running') !== null,
      stableHeight: footer.height >= 28 && button.height >= 28, singleAction: footerNode.querySelectorAll(':scope > button:not(:disabled)').length >= 1 };
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
