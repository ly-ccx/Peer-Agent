import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Uses the isolated fixture's actual input queue and the production question projection. */
export async function checkBotChatDetails({ page, until, report, captureDirectory, conversationFile }) {
  const checks = report.chatDetails = [];
  const canonical = () => readFileSync(conversationFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const composer = page.locator('.bot-composer textarea');
  const ask = async () => {
    await composer.fill('RC_DETAIL_QUESTION'); await composer.press('Enter');
    const card = page.locator('.bot-reply .bot-question');
    await card.waitFor();
    assert.equal(await page.locator('.bot-system .bot-question').count(), 0);
    const replyId = await card.evaluate(node => node.closest('.bot-reply').id.slice('bot-msg-'.length));
    assert.equal(await card.getAttribute('data-card-id'), `card:question:reply:${replyId}`);
    return { card, replyId };
  };
  const first = await ask();
  await page.locator(`[id="bot-msg-${first.replyId}"] .bot-reply-context > summary`).click();
  await page.locator(`[id="bot-msg-${first.replyId}"]`).getByRole('button', { name: '查看过程', exact: true }).click();
  const process = page.locator('.bot-process'); await process.waitFor();
  const visible = await process.innerText();
  assert.match(visible, /查询工作会话/); assert.match(visible, /发送回复/);
  assert.doesNotMatch(visible, /post_reply|replyTo|RC scripted reply/);
  assert.equal(await process.locator('details[open]').count(), 0);
  const technical = process.locator('details').last();
  await technical.locator('summary').focus(); await technical.locator('summary').press('Enter');
  assert.equal(await technical.getAttribute('open'), '');
  assert.match(await technical.innerText(), /post_reply/);
  await technical.locator('summary').press('Enter');
  // A dock's body has its final width while the opening transition is still running.
  await until(() => process.evaluate(node => {
    const dock = node.closest('.bot-drawer-dock');
    if (!dock) return true;
    return dock.getBoundingClientRect().width >= parseFloat(getComputedStyle(dock).getPropertyValue('--pa-drawer-width'));
  }), Boolean);
  const states = await process.locator('.bot-process-status').allTextContents();
  assert.deepEqual(states, ['已结束', '已发送']);
  assert.equal(await process.locator('.bot-process-status').last().evaluate(node => node.getBoundingClientRect().right <= innerWidth), true);
  await page.screenshot({ path: path.join(captureDirectory, 'chat-process-summary.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  checks.push('exact current-turn process uses localized operations; raw JSON is collapsed and keyboard accessible');
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 760, height: 780 });
  for (const value of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, value);
    assert.equal(await page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    const rect = await first.card.evaluate(node => ({ card: getComputedStyle(node).borderLeftWidth, shadow: getComputedStyle(node).boxShadow,
      user: getComputedStyle(document.querySelector('.bot-user')).backgroundColor }));
    assert.equal(rect.card, '0px'); assert.equal(rect.shadow, 'none'); assert.equal(rect.user, 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: path.join(captureDirectory, `chat-question-${value}.png`) });
  }
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.setViewportSize(viewport);
  await composer.fill('我自己填写：这个应用的历史聊天'); await composer.press('Enter');
  await first.card.waitFor({ state: 'detached' });
  const typed = await until(() => canonical().find(row => row.kind === 'user_input' && row.content === '我自己填写：这个应用的历史聊天'), Boolean);
  assert.equal(typed.answerTo, `card:question:reply:${first.replyId}`);
  await page.locator('.bot-thread').getByText('RC scripted reply: 我自己填写：这个应用的历史聊天', { exact: true }).waitFor();
  checks.push('freeform reply durably binds to its question and removes only those choices');
  const second = await ask();
  await composer.fill('RC_DETAIL_FAIL_ANSWER'); await composer.press('Enter');
  const failed = page.locator('.bot-user').filter({ hasText: 'RC_DETAIL_FAIL_ANSWER' });
  await failed.getByRole('button', { name: '重发', exact: true }).waitFor();
  assert.equal(await second.card.count(), 1);
  await failed.getByRole('button', { name: '重发', exact: true }).click();
  await second.card.waitFor({ state: 'detached' });
  const retried = await until(() => canonical().find(row => row.kind === 'user_input' && row.content === 'RC_DETAIL_FAIL_ANSWER'), Boolean);
  assert.equal(retried.answerTo, `card:question:reply:${second.replyId}`);
  assert.equal(canonical().filter(row => row.kind === 'user_input' && row.content === 'RC_DETAIL_FAIL_ANSWER').length, 1);
  await page.locator('.bot-thread').getByText('RC scripted reply: RC_DETAIL_FAIL_ANSWER', { exact: true }).waitFor();
  checks.push('failed freeform send retains choices; retry retains exact answer association and creates one canonical input');
  const third = await ask();
  await third.card.getByRole('button', { name: '其它工具里的工作记录', exact: true }).click();
  await third.card.waitFor({ state: 'detached' });
  const chosen = await until(() => canonical().find(row => row.kind === 'user_input' && row.answerTo === `card:question:reply:${third.replyId}`), Boolean);
  assert.equal(chosen.content, '其它工具里的工作记录');
  await page.locator('.bot-thread').getByText('RC scripted reply: 其它工具里的工作记录', { exact: true }).waitFor();
  await page.locator('.bot-search').fill('project-001'); await page.locator('.bot-row').first().click();
  await page.locator('.bot-search').fill('project-000'); await page.locator('.bot-row').first().click();
  await page.locator('.bot-thread').getByText('RC scripted reply: 其它工具里的工作记录', { exact: true }).waitFor();
  assert.equal(await page.locator('.bot-question').count(), 0);
  checks.push('option click follows the same durable answer path; switching back does not restore answered choices');
}
