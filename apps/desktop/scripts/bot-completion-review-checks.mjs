import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { projectCards } from '../../../packages/runtime-node/src/project-agent/card-projection.mjs';

/** Synthetic host facts exercise the production card, pager and IPC dispatch. */
export async function checkBotCompletionReview({ page, until, report, captureDirectory, commandFile }) {
  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  let seq = initial.seq;
  const send = (conversationMessages, extra = {}) => {
    writeFileSync(commandFile + '.next', JSON.stringify({ ...initial, seq: ++seq, conversationMessages, ...extra }));
    renameSync(commandFile + '.next', commandFile);
  };
  const asMessage = card => ({ id: card.cardId, role: 'assistant', kind: 'system_card', cards: [card] });
  const obsolete = projectCards(initial.workspaceId, { confirmations: [{ sessionId: 'completion-fixture', summary: '核对项目' }] })[0];
  send([asMessage(obsolete)]);
  const old = page.locator('[data-card-id="card:confirm_result:completion-fixture"]');
  await old.waitFor(); await old.getByRole('button', { name: '确认结果', exact: true }).click();
  await until(() => old.innerText(), text => text.includes('任务状态已变化'));
  assert.equal((await old.innerText()).includes('session_not_completed'), false);
  send([]); await old.waitFor({ state: 'detached' });
  const review = { sessionId: 'completion-fixture', reviewToken: 'completion-fixture-token', title: '只读核查项目',
    criteria: [{ id: 'c1', description: '报告包含目录、规则、脚本和最近提交的具体发现' }],
    report: '## 核查结果\n\n- apps：应用入口。\n- packages：共享运行时。\n- scripts：开发与回归脚本。\n\n## 读取依据\n\nAGENTS.md 与 package.json。报告末尾完整标记 REPORT_COMPLETE_END。' };
  const card = projectCards(initial.workspaceId, { completionReviews: [review] })[0];
  send([asMessage(card)]);
  const current = page.locator(`[data-card-id="${card.cardId}"]`);
  await current.waitFor(); await current.scrollIntoViewIfNeeded();
  assert.match(await current.innerText(), /报告已生成[\s\S]*报告包含目录/);
  assert.equal(await current.getByRole('button', { name: '确认结果', exact: true }).count(), 0);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'completion-review-card.png') });
  await current.getByRole('button', { name: '查看报告', exact: true }).focus(); await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: '查看报告', exact: true });
  await drawer.waitFor(); assert.match(await drawer.innerText(), /REPORT_COMPLETE_END/);
  await drawer.evaluate(async node => {
    await Promise.all([...node.getAnimations(), ...node.parentElement.getAnimations()].map(animation => animation.finished));
  });
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'completion-review-report.png') });
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await drawer.waitFor({ state: 'detached' });
  const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const initialViewport = page.viewportSize();
  await page.setViewportSize({ width: 760, height: 860 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await current.scrollIntoViewIfNeeded();
  const fits = await current.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1;
  }); assert.equal(fits, true);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'completion-review-760-light.png') });
  send([asMessage(card)], { failCompletionResume: true });
  await current.getByRole('button', { name: '确认已达成', exact: true }).click();
  await until(() => current.innerText(), text => text.includes('操作失败'));
  const saved = JSON.parse(readFileSync(commandFile, 'utf8'));
  assert.deepEqual(saved.confirmationPayload, { workspaceId: initial.workspaceId, sessionId: review.sessionId, stage: 'manual_completion', reviewToken: review.reviewToken });
  const retryCard = projectCards(initial.workspaceId, { completionReviews: [{ ...review, confirmed: true }] })[0];
  send([asMessage(retryCard)]);
  await current.getByRole('button', { name: '重试检查', exact: true }).waitFor();
  assert.match(await current.innerText(), /已保存你的核对结果/);
  await current.getByRole('button', { name: '重试检查', exact: true }).click();
  await until(() => current.getByRole('button', { name: '重试检查', exact: true }).count(), n => n === 0);
  await page.setViewportSize(initialViewport); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, initialTheme);
  send([]); await current.waitFor({ state: 'detached' });
  report.completionReview = { staleActionExplained: true, disappearedCardRetired: true, separateCompletionStage: true, fullReportInDrawer: true, keyboard: true, narrowFits: fits, retryAfterSavedReview: true };
}
