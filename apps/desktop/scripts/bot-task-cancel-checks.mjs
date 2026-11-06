import { openWorkPanel } from './bot-work-panel-checks.mjs';
import { openFullTask, BOT_DETAIL_CLOSE, BOT_DETAIL_SURFACE } from './bot-detail-surface-selectors.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { openReplyDetails, closeReplyDetails, scrollToBotMessage } from './bot-reply-details-checks.mjs';

/** Controlled cancellation receipts at the existing application-service seam; production IPC/UI. */
export async function checkBotTaskCancellation({ page, until, report, captureDirectory, commandFile }) {
  const originalViewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  const first = { ...initial.sessions[0], status: 'waiting_user', statusLabel: '等待你的选择', report: { summary: '等待你的选择' } };
  const other = { ...first, sessionId: 'rc-unrelated-work', title: '另一件正在进行的工作', status: 'running', statusLabel: '正在执行',
    origin: { ...first.origin, anchorMessageId: 'rc-other-input' }, report: { summary: '正在执行另一件工作' } };
  const update = (patch, refreshFacts = true) => {
    const current = JSON.parse(readFileSync(commandFile, 'utf8'));
    writeFileSync(commandFile + '.next', JSON.stringify({ ...current, ...patch, seq: current.seq + Number(refreshFacts) }));
    renameSync(commandFile + '.next', commandFile);
  };
  const release = async (sequence, final = false) => {
    await until(() => JSON.parse(readFileSync(commandFile, 'utf8')).cancelCalls?.length ?? 0, count => count >= sequence);
    const current = JSON.parse(readFileSync(commandFile, 'utf8'));
    const key = final ? 'cancelFinalize' : 'cancelRelease';
    // Stage acknowledgements do not reseed task facts or rewind stopping to waiting.
    update({ [key]: [...(current[key] ?? []), sequence] }, false);
  };
  update({ sessions: [first, other], cancelMode: 'fail', cancelCalls: [], cancelHandshake: true, cancelRelease: [], cancelFinalize: [] });
  const panelTasks = page.locator('.bot-work-panel .bot-work-panel-session.is-task');
  await until(() => panelTasks.locator('strong').allTextContents(), titles => titles.includes(first.title) && titles.includes(other.title));
  await openWorkPanel(page);
  await panelTasks.filter({ has: page.getByText(first.title, { exact: true }) }).click();
  const waiting = page.locator(BOT_DETAIL_SURFACE).locator('.bot-task-detail');
  await waiting.waitFor();
  await openFullTask(page);
  assert.equal(await waiting.getByRole('button', { name: `取消任务 ${first.title}`, exact: true }).count(), 1);
  const cancelFromTask = waiting.locator('.bot-task-cancel button');
  await cancelFromTask.focus(); await page.keyboard.press('Enter');
  await until(() => cancelFromTask.isDisabled(), Boolean);
  await page.locator(BOT_DETAIL_CLOSE).click();
  const reply = page.locator('#bot-msg-rc-message-9999');
  await scrollToBotMessage(page, reply);
  await openReplyDetails(page, reply);
  const historical = page.locator('.bot-reply-details .bot-work-row');
  if (await historical.getAttribute('open') === null) await historical.locator(':scope > summary').click();
  const cancel = historical.locator('.bot-task-cancel button');
  await until(() => cancel.isDisabled(), Boolean);
  await release(1);
  const failure = historical.getByRole('alert');
  await until(() => failure.innerText(), text => text.includes('取消未完成'));
  assert.equal(await historical.getAttribute('data-status'), 'waiting_user');
  assert.equal(await cancel.isEnabled(), true);
  // The alert can arrive mid-reveal. DOM visibility alone does not detect CSS clipping.
  await until(() => historical.evaluate(row => {
    const supportsMotion = CSS.supports('interpolate-size: allow-keywords') && CSS.supports('selector(details::details-content)');
    return !supportsMotion || getComputedStyle(row, '::details-content').overflowY === 'visible';
  }), Boolean, 3000);
  await until(() => failure.evaluate(node => {
    const row = node.closest('details');
    const detail = node.closest('.bot-work-detail');
    if (row.getBoundingClientRect().bottom < detail.getBoundingClientRect().bottom) return false;
    const text = document.createRange();
    text.selectNodeContents(node);
    const lines = [...text.getClientRects()];
    return lines.length > 0 && lines.every(line => {
      const x = (line.left + line.right) / 2;
      return [line.top + 1, line.bottom - 1].every(y => node.contains(document.elementFromPoint(x, y)));
    });
  }), Boolean, 3000);
  await page.screenshot({ path: path.join(captureDirectory, 'task-cancel-failed-dark.png'), animations: 'disabled' });
  update({ cancelMode: 'success' });
  await cancel.click();
  await until(() => cancel.isDisabled(), Boolean);
  assert.equal(await cancel.isDisabled(), true, 'both copies share pending state');
  await cancel.evaluate(button => { button.click(); button.click(); });
  await release(2);
  await until(() => historical.getAttribute('data-status'), value => value === 'cancelled');
  assert.match(await historical.innerText(), /已取消/);
  assert.doesNotMatch(await historical.innerText(), /等待你的选择|等待跟进|主对话中跟进/);
  assert.equal(await panelTasks.count(), 1);
  assert.match((await panelTasks.allTextContents()).join(' '), /另一件正在进行的工作/);
  assert.equal(await historical.locator('.bot-task-cancel button').count(), 0);
  const receipts = JSON.parse(readFileSync(commandFile, 'utf8')).cancelCalls;
  assert.equal(receipts.length, 2, 'failed attempt and one successful retry, no duplicate cancellation');
  assert.ok(receipts.every(call => call.sessionId === first.sessionId && call.workspaceId === initial.workspaceId));
  await page.screenshot({ path: path.join(captureDirectory, 'task-cancelled-dark.png'), animations: 'disabled' });
  await closeReplyDetails(page);
  // A successful stop receipt may precede the final host fact/React commit.
  // Keep the production button mounted in stopping state across several frames.
  update({ sessions: [first, other], cancelMode: 'deferred-status' });
  await until(() => panelTasks.count(), count => count === 2);
  await openWorkPanel(page);
  await panelTasks.filter({ has: page.getByText(first.title, { exact: true }) }).click();
  const detail = page.locator(BOT_DETAIL_SURFACE).locator('.bot-task-detail');
  await detail.waitFor();
  await openFullTask(page);
  await page.setViewportSize({ width: 760, height: 860 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const detailCancel = detail.locator('.bot-task-cancel button');
  await detailCancel.scrollIntoViewIfNeeded();
  assert.equal(await detailCancel.count(), 1);
  const fits = await detailCancel.evaluate(node => { const a=node.getBoundingClientRect(),b=node.closest('.bot-task-detail').getBoundingClientRect(); return a.left>=b.left&&a.right<=b.right; });
  assert.equal(fits, true);
  await page.screenshot({ path: path.join(captureDirectory, 'task-cancel-detail-760-light.png'), animations: 'disabled' });
  await detailCancel.focus(); await page.keyboard.press('Enter');
  await until(() => detailCancel.isDisabled(), Boolean);
  await release(3);
  await until(() => detail.getAttribute('data-status'), value => value === 'stopping');
  assert.equal(await detailCancel.count(), 1, 'the stop receipt does not remove the action before the final host fact');
  await release(3, true);
  await until(() => detail.getAttribute('data-status'), value => value === 'cancelled');
  assert.equal(await detail.locator('.bot-task-cancel button').count(), 0);
  await until(() => detail.locator('.bot-task-back').evaluate(node => node === document.activeElement), Boolean);
  update({ sessions: [first, other], cancelMode: 'deferred-status' });
  await until(() => detail.getAttribute('data-status'), value => value === 'waiting_user');
  await detailCancel.focus(); await page.keyboard.press('Enter');
  const close = page.locator(BOT_DETAIL_CLOSE);
  await close.focus();
  await release(4);
  await release(4, true);
  await until(() => detail.getAttribute('data-status'), value => value === 'cancelled');
  assert.equal(await close.evaluate(node => node === document.activeElement), true,
    'finishing cancellation must preserve focus deliberately moved during the request');
  await close.click();
  await page.setViewportSize(originalViewport);
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, originalTheme);
  update({ ...initial, cancelMode: undefined, cancelCalls: undefined, cancelHandshake: undefined, cancelRelease: undefined, cancelFinalize: undefined });
  await until(() => panelTasks.count(), count => count === 1);
  report.taskCancellation = { panelTaskAction: true, keyboard: true, detailAction: true, sharedPending: true,
    failureRetry: true, failureVisible: true, latestReceipt: true, noDuplicate: true, unrelatedPreserved: true, narrowFits: true,
    deferredStopReceipt: true, focusReturned: true, focusPreserved: true };
}
