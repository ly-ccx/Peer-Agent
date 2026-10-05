import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

/** Disposable main-side session facts, delivered through the production read and notification IPC. */
export async function checkBotWorkSurfaces({ page, until, report, captureDirectory, commandFile }) {
  const checks = report.workSurfaces = [];
  const reply = page.locator('#bot-msg-rc-message-9999');
  await reply.scrollIntoViewIfNeeded();
  const context = reply.locator('.bot-reply-context');
  if (await context.getAttribute('open') !== null) await context.locator(':scope > summary').click();
  assert.equal(await context.locator('button').first().isVisible(), false);
  assert.equal(await reply.locator('.bot-reply-marks > button').count(), 0);
  assert.match(await context.locator(':scope > summary').textContent(), /结果依据 · 20 条记录/);
  const work = reply.locator('.bot-work-row');
  await work.waitFor();
  assert.match(await work.locator(':scope > summary').textContent(), /核查历史任务完成情况.*正在运行中/);
  assert.equal(await work.locator('.is-running').evaluate(node => getComputedStyle(node).animationName), 'motion-shimmer');
  await work.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  assert.match(await work.innerText(), /逐条核对历史记录/);
  await reply.locator('.bot-reply-body').click();
  assert.doesNotMatch(await reply.locator('.bot-reply-bar').innerText(), /rc-message-/);
  await reply.screenshot({ path: path.join(captureDirectory, 'work-running.png') });
  checks.push('named running work scans visibly and expands by keyboard to its actual progress');

  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  let seq = initial.seq;
  const change = (sessions, unavailable = false) => {
    writeFileSync(commandFile + '.next', JSON.stringify({ ...initial, seq: ++seq, sessions, unavailable }));
    renameSync(commandFile + '.next', commandFile);
  };
  change([{ ...initial.sessions[0], status: 'waiting_user', report: { summary: '需要确认是否只使用可读取的历史记录。' } }]);
  await until(() => work.getAttribute('data-status'), value => value === 'waiting_user');
  assert.match(await work.innerText(), /需要你处理/);
  assert.equal(await work.locator('.is-running').count(), 0);
  assert.equal(await work.getByRole('button', { name: '查看并处理', exact: true }).isVisible(), true);
  await reply.screenshot({ path: path.join(captureDirectory, 'work-waiting.png') });
  change([{ ...initial.sessions[0], status: 'accepted' }]);
  await until(() => work.getAttribute('data-status'), value => value === 'accepted');
  assert.match(await work.locator(':scope > summary').textContent(), /已签收/);
  assert.equal(await page.locator('.bot-background-work').count(), 0);
  change([]);
  await until(() => work.getAttribute('data-status'), value => value === 'unavailable');
  assert.match(await work.innerText(), /状态暂不可用/);
  checks.push('main-side notifications update running to waiting, accepted and unavailable; old reply snapshots never revive running');
  change(initial.sessions);
  await until(() => work.getAttribute('data-status'), value => value === 'running');
  change(initial.sessions, true);
  await until(() => work.getAttribute('data-status'), value => value === 'unavailable');
  assert.equal(await work.locator('.is-running').count(), 0);
  assert.equal(await page.locator('.bot-background-work').count(), 0);
  change(initial.sessions);
  await until(() => work.getAttribute('data-status'), value => value === 'running');
  await work.locator(':scope > summary').click();

  await context.locator(':scope > summary').click();
  assert.equal(await context.locator('.bot-evidence-list li').count(), 20);
  await context.getByRole('button', { name: '证据 1', exact: true }).click();
  await page.locator('.bot-inspect').waitFor();
  assert.equal(await page.locator('.bot-drawer-body [role=tablist]').count(), 0);
  assert.equal(await page.locator('.bot-drawer-pane').count(), 0);
  assert.equal(await page.locator('.bot-inspect details[open]').count(), 0);
  await page.getByRole('button', { name: '返回 Bot 档案', exact: true }).click();
  await page.locator('.bot-overview-identity').waitFor();
  assert.equal(await page.locator('.bot-process').count(), 0);
  assert.match(await page.locator('.bot-overview-identity').innerText(), /负责这个项目的工作协调/);
  await page.locator('.bot-drawer-body').screenshot({ path: path.join(captureDirectory, 'bot-overview.png') });
  checks.push('evidence has its own detail view; returning shows bot identity and responsibility, with no execution log');

  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.locator('.bot-memory-list').waitFor();
  assert.equal(await page.locator('.bot-process, .bot-inspect').count(), 0);
  assert.equal(await page.locator('.bot-memory-controls').getAttribute('open'), null);
  assert.equal(await page.locator('.bot-memory-tab').evaluate(node => node.querySelector('.bot-memory-section').compareDocumentPosition(node.querySelector('.bot-memory-controls')) & Node.DOCUMENT_POSITION_FOLLOWING), 4);
  const provenance = page.locator('.bot-memory-provenance').first();
  assert.equal(await provenance.getAttribute('open'), null);
  await provenance.locator('summary').click();
  assert.equal(await provenance.getAttribute('open'), '');
  await provenance.locator('summary').click();
  await page.locator('.bot-drawer-body').screenshot({ path: path.join(captureDirectory, 'bot-memory.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  checks.push('memory starts with saved content, keeps settings and provenance on demand and contains no process view');

  await context.getByRole('button', { name: '查看过程', exact: true }).click();
  await page.locator('.bot-process').waitFor();
  assert.equal(await page.locator('.bot-memory-tab, .bot-overview-tab').count(), 0);
  await page.getByRole('button', { name: '返回 Bot 档案', exact: true }).click();
  await page.locator('.bot-memory-tab').waitFor();
  assert.equal(await page.getByRole('tab', { name: '记忆', exact: true }).evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('.bot-process').count(), 0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  checks.push('process is isolated from profile tabs and returns to the previous memory tab');

  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.setViewportSize({ width: 760, height: 780 });
  await reply.scrollIntoViewIfNeeded();
  for (const value of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, value);
    assert.equal(await reply.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await reply.screenshot({ path: path.join(captureDirectory, `work-narrow-${value}.png`) });
  }
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.setViewportSize(viewport);
  await context.locator(':scope > summary').click();
  checks.push('classified reply and delegated work fit a 760px viewport in both themes');
}
