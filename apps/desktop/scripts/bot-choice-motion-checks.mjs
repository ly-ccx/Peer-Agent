import assert from 'node:assert/strict';
import path from 'node:path';

/** Frame evidence comes from the actual button, receipt, DOM identity and scroll position. */
export async function checkBotChoiceMotion({ page, ask, canonical, report, captureDirectory }) {
  const viewport = page.viewportSize();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const cases = [];
  try {
    for (const [width, appearance, reduced] of [[1280, 'dark', false], [760, 'light', false], [760, 'light', true]]) {
      await page.setViewportSize({ width, height: 780 });
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
      const { card, replyId } = await ask();
      await card.scrollIntoViewIfNeeded();
      await page.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
      const button = card.getByRole('button', { name: '其它工具里的工作记录', exact: true });
      if (!reduced) await page.screenshot({ path: path.join(captureDirectory, `choice-send-${width}-${appearance}-before.png`), animations: 'disabled' });
      await button.evaluate(node => {
        const card = node.closest('.bot-question'), thread = node.closest('.bot-thread');
        const known = new Set([...thread.querySelectorAll('.bot-user')].map(item => item.dataset.inputId));
        window.rcChoiceFrames = null;
        node.addEventListener('click', () => {
          const frames = [], started = performance.now(); let firstInput = null, continuous = true;
          const sample = () => {
            const input = [...thread.querySelectorAll('.bot-user')].find(item => !known.has(item.dataset.inputId)
              && item.querySelector('.bot-user-text')?.textContent === node.textContent);
            if (input && !firstInput) firstInput = input;
            if (firstInput && firstInput !== input) continuous = false;
            const bubble = input?.querySelector('.bot-user-content'), style = bubble && getComputedStyle(bubble);
            frames.push({ time: performance.now() - started, height: card.isConnected ? card.getBoundingClientRect().height : 0,
              inputId: input?.dataset.inputId, opacity: style ? Number(style.opacity) : null,
              inputAnimation: Boolean(bubble?.getAnimations().some(animation => animation.playState === 'running')),
              cardAnimation: card.isConnected && card.getAnimations().some(animation => animation.playState === 'running'),
              scrollTop: thread.scrollTop });
            if (performance.now() - started < 650) requestAnimationFrame(sample);
            else window.rcChoiceFrames = { frames, continuous };
          };
          sample();
        }, { once: true });
      });
      await button.click();
      const result = await page.waitForFunction(() => window.rcChoiceFrames).then(handle => handle.jsonValue());
      const frames = result.frames;
      cases.push({ width, theme: appearance, reduced, continuous: result.continuous, oneReceipt: false, frames });
      report.choiceSendMotion = { cases, focusRestored: false };
      assert.ok(result.continuous, 'provisional input must not remount at durable receipt');
      assert.ok(frames.some(frame => frame.inputId));
      assert.equal(frames.at(-1).height, 0);
      const inputs = canonical().filter(row => row.kind === 'user_input' && row.answerTo === `card:question:reply:${replyId}`);
      assert.equal(inputs.length, 1);
      assert.equal(inputs[0].content, '其它工具里的工作记录');
      const opacity = frames.filter(frame => frame.opacity !== null).map(frame => frame.opacity);
      if (reduced) {
        assert.equal(frames.some(frame => frame.cardAnimation || frame.inputAnimation), false);
      } else {
        assert.ok(frames.some(frame => frame.cardAnimation));
        assert.ok(frames.some(frame => frame.height > 1 && frame.height < frames[0].height - 1));
        assert.ok(frames.some(frame => frame.inputAnimation));
        assert.ok(Math.min(...opacity) < 0.95 && opacity.at(-1) === 1);
        const deltas = frames.slice(1).map((frame, index) => Math.abs(frame.scrollTop - frames[index].scrollTop));
        assert.ok(Math.max(...deltas) < 80, `send must not jump by a large frame: ${Math.max(...deltas)}`);
        await page.screenshot({ path: path.join(captureDirectory, `choice-send-${width}-${appearance}-after.png`), animations: 'disabled' });
      }
      assert.equal(await page.locator('.bot-composer textarea').evaluate(node => node === document.activeElement), true);
      cases.at(-1).oneReceipt = true;
    }
    report.choiceSendMotion = { cases, focusRestored: true };
  } finally {
    await page.setViewportSize(viewport);
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
}
