import assert from 'node:assert/strict';
import path from 'node:path';

/** Production message components with isolated conversation content. */
export async function checkConversationTypography({ page, until, report, captureDirectory, send }) {
  const command = "sed -n '1,400p' /workspace/project/artifacts/unscoped/9eb75699/content 2>/dev/null || find /workspace/project/artifacts -maxdepth 3 -name content · local.shell.exec · L2_local_write";
  const receipts = ['approved', 'denied', 'expired'].map((state, index) => ({
    id: `typography-receipt-${index}`, role: 'assistant', kind: 'system_card',
    cards: [{ cardId: `typography-approval-${index}`, kind: 'approval', content: command,
      resolvedState: 'resolved', resolution: { state }, refs: { capabilityId: 'local.shell.exec' }, actions: [] }],
  }));
  send([
    { id: 'typography-user', role: 'user', kind: 'user_input', content: '帮我梳理项目结构，告诉我应该先改哪里。' },
    { id: 'typography-reply', role: 'assistant', kind: 'agent_reply', content:
      '我已经看过项目结构，建议先把会话区的阅读体验整理好。\n\n### 先让重点更清楚\n\n**主体文字更有分量，操作过程保持紧凑。** 这样读长回复时，能更快找到结论，也能随时查看具体依据。\n\n- 会话正文使用中等字重，关键结论进一步强调。\n- 工具命令保留在详情中，需要处理的授权直接显示。\n\n下一步从 `BotConversation` 的文字层级开始调整。', cards: [] },
    ...receipts,
    { id: 'typography-open', role: 'assistant', kind: 'system_card', cards: [{
      cardId: 'typography-open-approval', kind: 'approval', content: '写入项目说明文件 README.md · local.file.write · L2_local_write',
      resolvedState: 'open', actions: [{ id: 'allow' }, { id: 'reject' }],
    }] },
  ]);
  const reply = page.locator('#bot-msg-typography-reply');
  await reply.waitFor();
  const receipt = page.locator('[data-card-id="typography-approval-0"]');
  const pending = page.locator('[data-card-id="typography-open-approval"]');
  await pending.waitFor();
  assert.equal(await pending.getByRole('button').count(), 2);
  assert.equal(await pending.locator('details').count(), 0);
  assert.equal(await receipt.locator('details').evaluate(node => node.open), false);
  assert.equal(await receipt.locator('.bot-approval-receipt-content').isVisible(), false);
  const summary = receipt.locator('summary');
  await summary.focus(); await page.keyboard.press('Enter');
  assert.equal(await receipt.locator('details').evaluate(node => node.open), true);
  assert.equal(await receipt.locator('pre').innerText(), command);
  await page.keyboard.press('Enter');
  assert.equal(await receipt.locator('details').evaluate(node => node.open), false);
  assert.equal(await page.locator('.bot-approval-receipt-state').allTextContents().then(values => values.join(',')), '已授权,已拒绝,已失效');
  const viewport = page.viewportSize();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const cases = [];
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 1120 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    await reply.scrollIntoViewIfNeeded();
    await until(() => reply.locator('.bot-reply-body').evaluate(node => getComputedStyle(node).fontSize), value => value === '15px');
    const typography = await reply.evaluate(node => {
      const body = getComputedStyle(node.querySelector('.bot-reply-body'));
      const strong = getComputedStyle(node.querySelector('strong'));
      const code = getComputedStyle(node.querySelector('code'));
      return { body: body.fontSize, weight: body.fontWeight, emphasis: strong.fontWeight, code: code.fontSize,
        codeWeight: code.fontWeight, fits: node.scrollWidth <= node.clientWidth + 1 };
    });
    assert.equal(typography.weight, '500'); assert.equal(typography.emphasis, '600');
    assert.equal(typography.codeWeight, '400'); assert.equal(typography.fits, true);
    const recordSpacing = await page.locator('.bot-approval-receipt').evaluateAll(nodes => {
      const boxes = nodes.map(node => node.getBoundingClientRect());
      return boxes.slice(1).map((box, index) => box.top - boxes[index].bottom);
    });
    assert.equal(recordSpacing.length, 2);
    assert.ok(recordSpacing.every(gap => gap >= 0 && gap <= 6), `Adjacent authorization records are too far apart: ${recordSpacing}`);
    await summary.evaluate(node => node.blur());
    await page.locator('#bot-msg-typography-user').evaluate(node => {
      const thread = node.closest('.bot-thread');
      thread.scrollTop += node.getBoundingClientRect().top - thread.getBoundingClientRect().top - 20;
    });
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `conversation-typography-${width}-${appearance}.png`) });
    await page.locator('.bot-convo').screenshot({ animations: 'disabled', path: path.join(captureDirectory, `conversation-typography-detail-${width}-${appearance}.png`) });
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `approval-spacing-${width}-${appearance}.png`), clip: await page.locator('.bot-approval-receipt').evaluateAll(nodes => {
      const first = nodes[0].getBoundingClientRect(), last = nodes.at(-1).getBoundingClientRect();
      return { x: first.left, y: first.top, width: first.width, height: last.bottom - first.top };
    }) });
    await pending.scrollIntoViewIfNeeded();
    assert.equal(await receipt.evaluate(node => node.getBoundingClientRect().height < 72 && node.scrollWidth <= node.clientWidth + 1), true);
    await summary.focus(); await page.keyboard.press('Enter');
    assert.equal(await receipt.locator('pre').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `approval-history-${width}-${appearance}.png`) });
    await page.keyboard.press('Enter');
    cases.push({ width, appearance, ...typography, recordSpacing, compactReceipt: true, fullCommandPreserved: true, pendingVisible: true });
  }
  await page.setViewportSize(viewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  report.conversationTypography = { cases, keyboardDisclosure: true, truthfulApprovalStates: true };
}
