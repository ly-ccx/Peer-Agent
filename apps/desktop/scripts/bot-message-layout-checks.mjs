import { BOT_DETAIL_SURFACE, BOT_DETAIL_CLOSE } from './bot-detail-surface-selectors.mjs';
import { openReplyDetails, closeReplyDetails, scrollToBotMessage } from './bot-reply-details-checks.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BUDGET_RECOVERY_CASES } from './work-budget-fixture.mjs';

/** Failures stay visible; long provider diagnostics are readable on request. */
export async function checkBotMessageLayout({ page, until, report, captureDirectory, expectedText }) {
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const message = page.locator('#bot-msg-rc-message-9998');
  const card = message.locator('.bot-card');
  const details = page.locator(BOT_DETAIL_SURFACE).locator('.bot-reply-details');
  const rawError = details.locator('.bot-context-error pre');
  const budgetMessage = page.locator('#bot-msg-rc-message-9997');
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    await scrollToBotMessage(page, budgetMessage);
    assert.equal(await budgetMessage.locator('.bot-card > p').first().textContent(), '这项工作已达到配置的预算限制，已有进展已保留。调整限制后可继续。');
    assert.equal(await budgetMessage.getByRole('button', { name: '继续尝试', exact: true }).count(), 0);
    assert.match(await budgetMessage.innerText(), /模型请求：已用 256 次，上限 256 次。.*来源：执行预算设置。/s);
    assert.equal(await budgetMessage.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.doesNotMatch(await budgetMessage.innerText(), /work_budget_limited/);
    await openReplyDetails(page, budgetMessage);
    assert.match(await rawError.textContent(), /^代理暂时不可用：work_budget_limited/);
    await closeReplyDetails(page);
    await scrollToBotMessage(page, budgetMessage);
    await page.screenshot({ path: path.join(captureDirectory, `budget-exhausted-${appearance}.png`), animations: 'disabled' });
  }
  report.budgetFailure = { reasonVisible: true, diagnosticInDrawer: true, retrySuppressed: true, limitVisible: true, narrowFits: true };
  const recoveryCases = [
    ...BUDGET_RECOVERY_CASES,
    ['missing-checkpoint', 9978, '已有进展缺少完整的恢复记录，需要先核对，无法直接重复执行。', false],
    ['scheduled', 9985, '连接暂时中断，我会接着刚才的进度继续。', false],
    ['exhausted', 9986, '连接还没有恢复，已有进展已保留。你可以继续尝试，也可以先发新消息。', true],
    ['authentication', 9987, '连接的身份验证未通过。请重新登录或检查连接配置，再继续尝试。', true],
    ['unknown', 9988, '有操作的结果尚未确认，需要先核对，已有进展已保留。', false],
    ['resolved', 9989, '主 Bot 回复已恢复，新的回复已送达。', false],
    ['child-running', 9964, '模型未返回可用内容，已有进展已保留。你可以继续尝试。', true],
    ['historical', 9965, '此前一次主 Bot 回复未完成，已保留在历史记录中。', false],
    ['paused', 9966, '这项工作的主 Bot 回复已暂停。', false],
    ['cancelled', 9967, '这项工作的主 Bot 回复已取消。', false],
    ['no-progress', 9979, '连续检查没有取得新进展，已停止重复执行。已有结果已保留。', true],
  ];
  const recoverySamples = [];
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    for (const [state, id, expected, retryVisible] of recoveryCases) {
      const recoveryMessage = page.locator(`#bot-msg-rc-message-${id}`);
      await scrollToBotMessage(page, recoveryMessage);
      if (state === 'resolved' && !await recoveryMessage.locator('.bot-recovery-history').evaluate(node => node.open)) {
        await recoveryMessage.locator('.bot-recovery-history > summary').click();
      }
      const text = state === 'resolved' ? recoveryMessage.locator('.bot-recovery-history .bot-reply-body') : recoveryMessage.locator('.bot-card > p');
      assert.equal(await text.first().textContent(), expected);
      if (state === 'child-running') assert.match(await recoveryMessage.innerText(), /另有 1 项子任务仍在推进/);
      if (state === 'budget-unknown') assert.match(await recoveryMessage.innerText(), /费用上限为 10 美元，当前用量无法准确确认；不会把未知用量当作零。.*来源：执行预算设置。/s);
      assert.equal(await recoveryMessage.getByRole('button', { name: '继续尝试', exact: true }).count(), Number(retryVisible));
      assert.equal(await recoveryMessage.locator('[role="status"]').count(), Number(state === 'scheduled' || state === 'budget-migrating'));
      assert.doesNotMatch(await recoveryMessage.innerText(), /ConnectTimeoutError|net::|HTTP 401|execution_outcome_unknown|rc-recovery-/);
      assert.equal(await recoveryMessage.evaluate(node => node.scrollWidth <= node.clientWidth), true);
      if (state === 'scheduled') {
        assert.equal(await recoveryMessage.locator('.bot-narration p').first().textContent(), '我已经看过项目结构，正在核对实现位置。');
        const gap = await recoveryMessage.evaluate(node => node.querySelector('.bot-card .bot-reply-body').getBoundingClientRect().top
          - node.querySelector('.bot-narration .bot-reply-body').getBoundingClientRect().bottom);
        assert.ok(gap >= 7.5 && gap <= 8.5, `separate narration/recovery bubbles require 8px gap, got ${gap}`);
      }
      await openReplyDetails(page, recoveryMessage);
      assert.match(await rawError.textContent(), /代理暂时不可用：/);
      await closeReplyDetails(page);
      // Drawer close restores the reading anchor. Scroll the status card itself,
      // since the message can be partially visible while its final card is below
      // the viewport after virtualization measures retained narration.
      await recoveryMessage.evaluate(async node => {
        const animations = node.closest('.bot-shell').getAnimations({ subtree: true }).filter(animation => animation.playState === 'running'
          && Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.effect?.target?.checkVisibility());
        await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await recoveryMessage.locator(state === 'resolved' ? '.bot-recovery-history' : '.bot-card').scrollIntoViewIfNeeded();
      await until(() => recoveryMessage.evaluate(node => {
        const view = node.closest('.bot-thread').getBoundingClientRect();
        const card = node.querySelector('.bot-recovery-history, .bot-card').getBoundingClientRect();
        return card.top >= view.top - 1 && card.bottom <= view.bottom + 1;
      }), Boolean);
      const bounds = await recoveryMessage.evaluate(node => {
        const shell = node.closest('.bot-shell').getBoundingClientRect(), body = node.querySelector('.bot-reply-body').getBoundingClientRect();
        const layout = node.closest('.bot-resource-layout'), primary = node.closest('.bot-resource-primary');
        return { shellLeft: shell.left, shellRight: shell.right, bodyLeft: body.left, bodyRight: body.right, viewport: innerWidth,
          documentScrollLeft: document.documentElement.scrollLeft, bodyScrollLeft: document.body.scrollLeft,
          layoutScrollLeft: layout?.scrollLeft, layoutScrollWidth: layout?.scrollWidth, layoutWidth: layout?.clientWidth,
          primaryScrollLeft: primary?.scrollLeft };
      });
      assert.ok(bounds.shellLeft >= -1 && bounds.shellRight <= bounds.viewport + 1 && bounds.bodyLeft >= 0 && bounds.bodyRight <= bounds.viewport,
        `recovery image must use settled page bounds: ${JSON.stringify({ state, width, appearance, ...bounds })}`);
      await page.screenshot({ path: path.join(captureDirectory, `recovery-${state}-${appearance}.png`), animations: 'disabled' });
      assert.equal(await text.first().evaluate(node => {
        const rect = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
      }), true, 'captured recovery text remains visible after drawer and virtual-list layout settle');
      recoverySamples.push({ state, width, appearance, exactCopy: true, retryVisible, diagnosticsInDrawer: true, fits: true });
    }
  }
  report.replyRecovery = { cases: recoverySamples, publicProgressRetained: true, bubbleSpacing: true, reservationTruth: true,
    resolvedReservationRetired: true, unknownHasNoReplay: true, checkpointHasNoReplay: true,
    scope: 'Production renderer from explicit isolated host projection fixtures; request and scheduler recovery are verified separately without live providers' };
  const cases = [];
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 780 });
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
      for (const docked of width === 1280 ? [false, true] : [false]) {
        if (docked) {
          await page.getByRole('button', { name: '机器人设置', exact: true }).click();
          await page.locator(BOT_DETAIL_SURFACE).waitFor();
          await until(() => page.locator('.bot-convo').evaluate(node => node.getBoundingClientRect().width < 700), Boolean);
        }
        await scrollToBotMessage(page, card);
        if (await page.locator(BOT_DETAIL_CLOSE).isVisible()) {
          await page.locator(BOT_DETAIL_CLOSE).click();
          await page.locator(BOT_DETAIL_SURFACE).waitFor({ state: 'hidden' });
        }
        await rawError.waitFor({ state: 'hidden' });
        assert.equal(await card.locator(':scope > p').textContent(), '服务未接受这次请求。需要先检查模型或连接配置，已有进展已保留。', 'failure is stated plainly outside technical details');
        assert.equal(await rawError.isVisible(), false, 'raw provider JSON is not in the default conversation');
        await openReplyDetails(page, message);
        await rawError.waitFor({ state: 'visible' });
        assert.equal(await rawError.textContent(), expectedText, 'full error must remain available, without truncation');
        const bounds = await details.evaluate(node => {
          const paragraph = node.querySelector('.bot-context-error pre');
          const rect = paragraph.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(paragraph);
          const fragments = [...range.getClientRects()].filter(box => box.width > 0);
          return {
            textFits: fragments.every(box => box.left >= rect.left - 1 && box.right <= rect.right + 1),
            lines: fragments.length,
            cardFits: node.scrollWidth <= node.clientWidth,
            conversationFits: !document.querySelector('.bot-convo').checkVisibility({ visibilityProperty: true }) || document.querySelector('.bot-convo').scrollWidth <= document.querySelector('.bot-convo').clientWidth,
            detailFits: node.getBoundingClientRect().left >= 0 && node.getBoundingClientRect().right <= innerWidth,
          };
        });
        assert.ok(bounds.textFits && bounds.cardFits && bounds.conversationFits && bounds.detailFits,
          `long error must fit its text area, card and conversation: ${JSON.stringify({ width, appearance, docked, ...bounds })}`);
        assert.ok(bounds.lines > 1, 'long error should wrap into readable lines');
        cases.push({ viewportWidth: width, appearance, docked, diagnosticsCollapsed: true, detailsKeyboard: true, ...bounds });
        if (width === 760 && appearance === 'dark') await closeReplyDetails(page);
        await page.waitForTimeout(180);
        await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `long-error-${docked ? 'docked' : width}-${appearance}.png`) });
        if (await page.locator(BOT_DETAIL_CLOSE).isVisible()) await closeReplyDetails(page);
      }
    }
  }
  await page.setViewportSize(viewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await scrollToBotMessage(page, page.locator('#bot-msg-rc-message-9999'));
  assert.equal(await message.locator('.bot-reply-context > button').count(), 1);
  report.messageLayout = { completeText: true, fitBounds: true, diagnosticsCollapsed: true, detailsKeyboard: true, cases,
    scope: 'Production system-card rendering from isolated canonical conversation data, including long JSON, URL and unbroken ID; no provider network' };
}
