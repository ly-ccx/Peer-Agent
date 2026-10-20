import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createConversationStore } from '@peer-agent/conversation-store';
import { openReplyDetails, closeReplyDetails } from './bot-reply-details-checks.mjs';

/** One canonical reply referencing three tasks must remain one input acknowledgement. */
export async function checkBotUserReceipt({ page, until, report, captureDirectory, home, bot, commandFile }) {
  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  const titles = ['入口样式收尾', '中断原因核查收尾', '设置按钮记录核对'];
  const sessions = titles.map((title, index) => ({ ...initial.sessions[0], sessionId: `receipt-task-${index}`,
    title, status: index === 2 ? 'completed' : 'cancelled', statusLabel: index === 2 ? '已完成' : '已取消',
    report: { summary: `${title}的记录已保留。` } }));
  const store = createConversationStore({ storeDir: path.join(home, 'conversations') });
  store.appendMessage(bot.conversationId, { id: 'receipt-input', inputId: 'receipt-input', kind: 'user_input', role: 'user',
    content: '一并收尾：这两项也不再追验收，能关就关' });
  store.appendMessage(bot.conversationId, { id: 'receipt-reply', kind: 'agent_reply', role: 'assistant',
    replyTo: ['receipt-input'], sources: sessions.map(session => session.sessionId),
    content: '收尾结果已经整理。三个关联任务的处理记录保留在回复详情中。' });
  const change = state => { writeFileSync(commandFile + '.next', JSON.stringify(state)); renameSync(commandFile + '.next', commandFile); };
  change({ ...initial, seq: initial.seq + 1, sessions });
  await page.locator('.bot-search').fill('project-000');
  await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-000' }) }).click();
  await until(() => page.evaluate(workspaceId => window.peerAgent.projectAgentListSessions({ workspaceId }), bot.workspaceId),
    result => result.sessions?.some(session => session.sessionId === sessions[0].sessionId));
  const user = page.locator('#bot-msg-receipt-input');
  const reply = page.locator('#bot-msg-receipt-reply');
  const cases = [];
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 860 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, appearance);
    await reply.waitFor(); await reply.scrollIntoViewIfNeeded();
    await until(() => user.locator('.bot-user-marks').innerText(), text => text === '已回复');
    assert.equal(await user.locator('.bot-user-marks > span').count(), 1);
    assert.equal(await user.locator('.bot-user-marks > button').count(), 0);
    assert.equal(await user.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.mouse.move(1, 1); await page.locator('.bot-composer textarea').focus();
    await page.screenshot({ path: path.join(captureDirectory, `user-receipt-${width}-${appearance}.png`), animations: 'disabled' });
    await openReplyDetails(page, reply);
    const work = page.locator('.bot-reply-details .bot-work-row');
    assert.equal(await work.count(), 3);
    for (const title of titles) assert.ok((await work.allTextContents()).some(text => text.includes(title)));
    await work.first().locator(':scope > summary').focus(); await page.keyboard.press('Enter');
    const action = work.first().getByRole('button', { name: '查看任务详情', exact: true });
    await action.focus(); await action.press('Enter');
    const detail = page.locator('.bot-task-detail'); await detail.waitFor();
    assert.match(await detail.innerText(), /入口样式收尾/);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.bot-drawer-body').waitFor({ state: 'hidden' });
    await openReplyDetails(page, reply); await closeReplyDetails(page);
    cases.push({ width, appearance, singleReceipt: true, sourcesRetained: true, keyboard: true, fits: true });
  }
  const savedReply = store.getPersistedConversationHistory(bot.conversationId).messages.find(message => message.id === 'receipt-reply');
  assert.deepEqual(savedReply.sources, sessions.map(session => session.sessionId));
  change({ ...initial, seq: initial.seq + 2 });
  report.userReceipt = { singleReceipt: true, noTaskDuplicates: true, sourcesRetained: true, keyboard: true, cases };
}
