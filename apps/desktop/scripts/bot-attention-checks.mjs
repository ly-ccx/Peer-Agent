import assert from 'node:assert/strict';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';

/** Production directory, IPC, input queue and real renderer on the standard 10k-message home. */
export async function checkBotAttention({ page, app, until, report, captureDirectory, home, bots }) {
  await page.locator('.bot-search').fill('');
  const store = createConversationStore({ storeDir: path.join(home, 'conversations') });
  const first = bots[0], other = bots[1];
  const signal = async () => app.evaluate(({ BrowserWindow }, ids) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('project-agent:changed', { workspaceIds: ids });
      window.webContents.send('project-agent:conversation-changed', { workspaceIds: ids });
    }
  }, [first.workspaceId, other.workspaceId]);
  const appendQuestion = (bot, id, content) => store.appendMessage(bot.conversationId, {
    id, kind: 'agent_reply', role: 'assistant', content,
    question: { options: ['保留当前方案', '调整后继续'] },
  });
  const read = workspaceId => page.evaluate(workspaceId => window.peerAgent.projectAgentListAttention(workspaceId ? { workspaceId } : {}), workspaceId);
  const count = async workspaceId => (await read(workspaceId)).items.length;
  appendQuestion(first, 'attention-old-1', '旧问题：是否再次核验报告？');
  appendQuestion(first, 'attention-old-2', '重复问题：是否再次核验报告？');
  appendQuestion(first, 'attention-current', '选择这次交付的处理方式；前面的旧问题已经收尾。');
  appendQuestion(other, 'attention-other', '另一台机器人的独立决定，不能被第一个机器人的回答关闭。');
  await signal();
  await until(async () => (await read(first.workspaceId)).items.filter(item => item.kind === 'question').length, n => n === 1);
  const firstTotal = await count(first.workspaceId);
  const firstRow = page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-000' }) });
  await until(() => firstRow.locator('.bot-badge').textContent(), text => Number.parseInt(text, 10) === firstTotal);
  await firstRow.locator('.bot-badge').focus(); await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: '需要你处理', exact: true }); await panel.waitFor();
  assert.equal(await panel.locator('.bot-attention-item').count(), firstTotal);
  assert.match(await panel.innerText(), /这次交付的处理方式/);
  assert.doesNotMatch(await panel.innerText(), /旧问题：|重复问题：/);
  await page.setViewportSize({ width: 1280, height: 860 }); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: path.join(captureDirectory, 'attention-1280-dark.png'), animations: 'disabled' });
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
  assert.equal(await firstRow.locator('.bot-badge').evaluate(node => document.activeElement === node), true);
  await app.evaluate(() => { globalThis.rcAttentionFailOnce = true; });
  const globalButton = page.locator('.bot-need-filter'); await globalButton.click(); await panel.waitFor();
  await panel.getByRole('alert').waitFor();
  await panel.getByRole('button', { name: '重新读取', exact: true }).click();
  await until(() => panel.locator('.bot-attention-group').count(), n => n === 2);
  assert.equal(await panel.locator('.bot-attention-group').count(), 2);
  await panel.locator('[data-attention-id="card:question:reply:attention-current"]').getByRole('button', { name: '查看原文并处理', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  const source = page.locator('#bot-msg-attention-current');
  await source.waitFor(); await source.locator('.bot-question button').first().waitFor({ state: 'visible' });
  assert.match(await source.innerText(), /这次交付的处理方式/);
  const notify = async () => app.evaluate(({ BrowserWindow }, target) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('quick-chat:open-conversation', target);
  }, { source: 'project-agent-notification', workspaceId: other.workspaceId,
    conversationId: other.conversationId, messageId: 'attention-other' });
  await notify();
  await page.locator('#bot-msg-attention-other.is-anchored').waitFor({ state: 'visible' });
  await firstRow.locator('.bot-badge').click(); await panel.waitFor();
  await panel.locator('[data-attention-id="card:question:reply:attention-current"]').getByRole('button', { name: '查看原文并处理', exact: true }).click();
  await page.locator('#bot-msg-attention-current.is-anchored').waitFor({ state: 'visible' });
  await notify();
  await page.locator('#bot-msg-attention-other.is-anchored').waitFor({ state: 'visible' });
  await page.locator('.bot-need-filter').click(); await panel.waitFor();

  const firstItem = panel.locator('[data-attention-id="card:question:reply:attention-current"]');
  await app.evaluate(() => { globalThis.rcAttentionFailInput = true; });
  await firstItem.getByRole('button', { name: '保留当前方案', exact: true }).click();
  await firstItem.getByRole('alert').waitFor(); assert.equal(await count(first.workspaceId), firstTotal);
  await firstItem.getByRole('button', { name: '保留当前方案', exact: true }).click();
  await until(async () => (await read(first.workspaceId)).items.some(item => item.messageId === 'attention-current'), exists => !exists);
  assert.equal(await count(other.workspaceId), 1);
  const history = store.getPersistedConversationHistory(first.conversationId).messages;
  assert.equal(history.filter(m => m.kind === 'user_input' && m.answerTo === 'card:question:reply:attention-current').length, 1);
  const late = await page.evaluate(workspaceId => window.peerAgent.projectAgentSubmitInput({ workspaceId, inputId: 'attention-late',
    text: '过期旧选项', answerTo: 'card:question:reply:attention-old-1' }), first.workspaceId);
  assert.equal(late.code, 'QUESTION_CLOSED');
  // Other scenarios deliberately retain unrelated permission facts. Keep those facts; scope the next steps to the second bot.
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
  const otherRow = page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: 'project-001' }) });
  await otherRow.locator('.bot-badge').click(); await panel.waitFor();

  // A new question arriving while the sheet is open replaces its predecessor in place.
  appendQuestion(other, 'attention-newer', '新的决定取代旧决定；这次只保留这一条。'); await signal();
  await until(() => panel.locator('[data-attention-id="card:question:reply:attention-newer"]').count(), n => n === 1);
  assert.equal(await panel.locator('[data-attention-id="card:question:reply:attention-other"]').count(), 0);
  await page.setViewportSize({ width: 760, height: 860 }); await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  assert.equal(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  await page.screenshot({ path: path.join(captureDirectory, 'attention-760-light.png'), animations: 'disabled' });
  await panel.getByRole('button', { name: '调整后继续', exact: true }).click();
  await until(() => count(other.workspaceId), n => n === 0);
  await panel.getByText('暂时没有需要你处理的事项', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(captureDirectory, 'attention-empty-light.png'), animations: 'disabled' });
  const answeredId = store.getPersistedConversationHistory(other.conversationId).messages.findLast(m => m.kind === 'user_input' && m.answerTo === 'card:question:reply:attention-newer')?.id;
  await until(() => store.getPersistedConversationHistory(other.conversationId).messages.some(m => m.kind === 'agent_reply'
    && (m.replyTo || m.meta?.replyTo || []).includes(answeredId)), Boolean);
  store.appendMessage(other.conversationId, { id: 'attention-deadline', kind: 'agent_reply', role: 'assistant',
    content: '这项限时决定即将失效；过期后不能再提交旧选项。', question: { options: ['限时选择'], expiresAt: new Date(Date.now() + 1800).toISOString() } });
  await signal();
  await panel.locator('[data-attention-id="card:question:reply:attention-deadline"]').waitFor();
  await until(() => panel.locator('.bot-attention-item').count(), n => n === 0);
  await panel.getByText('暂时没有需要你处理的事项', { exact: true }).waitFor();
  const expired = await page.evaluate(workspaceId => window.peerAgent.projectAgentSubmitInput({ workspaceId, inputId: 'expired-answer',
    text: '限时选择', answerTo: 'card:question:reply:attention-deadline' }), other.workspaceId);
  assert.equal(expired.code, 'QUESTION_CLOSED');
  await page.screenshot({ path: path.join(captureDirectory, 'attention-expired-light.png'), animations: 'disabled' });

  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
  report.attention = { passed: true, realDirectory: true, realQueue: true, duplicateRetired: true, staleClickRejected: true,
    keyboard: true, notificationFocus: true, failureRecovery: true, crossBotIsolation: true, liveReplacement: true, countEqualsDetail: true, sourceLocated: true, expiresAutomatically: true, largeHistoryMessages: 10000 };
}
