import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** No prebuilt cards: view_image must cause the host to present an actionable card. */
export async function checkBotImageLifecycle({ page, until, report, captureDirectory, receiptFile, workspaceId }) {
  const read = () => JSON.parse(readFileSync(receiptFile, 'utf8'));
  const cases = [];
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const scenario of ['ALLOW', 'TASK', 'DENY', 'CANCEL', 'STOP', 'TIMEOUT']) {
    await page.setViewportSize({ width: scenario === 'TASK' ? 760 : 1280, height: 860 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, scenario === 'TASK' ? 'light' : 'dark');
    const composer = page.locator('.bot-composer textarea');
    await composer.fill(`RC_IMAGE_${scenario}`); await composer.press('Enter');
    const started = await until(() => read().findLast(row => row.scenario === scenario && row.stage === 'started'), Boolean);
    const approvalId = `chat-permission:${started.toolCallId}`;
    const card = page.locator(`[data-card-id="card:approval:${approvalId}"]`);
    await card.waitFor(); await card.scrollIntoViewIfNeeded();
    assert.match(await card.innerText(), /交给当前模型[\s\S]*permission-check-[\s\S]*等待授权最多 5 分钟/);
    assert.equal(await card.getByRole('button').count(), 4);
    await until(() => page.locator('.bot-live-reply[data-phase="awaiting_permission"]').count(), value => value === 1);
    assert.match(await page.locator('.bot-live-reply .bot-context-running').innerText(), /等待你的授权/);
    assert.equal(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    if (scenario === 'ALLOW' || scenario === 'TASK') {
      await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `image-live-wait-${scenario === 'TASK' ? '760-light' : '1280-dark'}.png`) });
      await card.getByRole('button', { name: scenario === 'TASK' ? '本轮允许此图片' : '仅这一次', exact: true }).focus();
      await page.keyboard.press('Enter');
    } else if (scenario === 'DENY') await card.getByRole('button', { name: '拒绝', exact: true }).click();
    else if (scenario === 'CANCEL') await card.getByRole('button', { name: '取消本次读取', exact: true }).click();
    else if (scenario === 'STOP') await page.getByRole('button', { name: '停止生成', exact: true }).click();
    const finished = await until(() => read().findLast(row => row.scenario === scenario && row.stage === 'finished'), Boolean);
    const expected = { ALLOW: 'success', TASK: 'success', DENY: 'denied', CANCEL: 'cancelled', STOP: 'cancelled', TIMEOUT: 'timeout' }[scenario];
    assert.equal(finished.status, expected); assert.equal(finished.pixels, expected === 'success');
    assert.equal(finished.pending, 0); assert.equal(finished.evidence, true);
    const streamResult = read().findLast(row => row.scenario === scenario && row.stage === 'stream-result');
    assert.equal(streamResult?.evidence, true, 'Evidence must reach the production turn sink even on stop');
    if (scenario === 'STOP') assert.equal(streamResult.cancelled, true);
    if (scenario === 'TASK') {
      const inherited = await until(() => read().findLast(row => row.scenario === scenario && row.stage === 'inherited'), Boolean);
      assert.equal(inherited.grantId, finished.grantId); assert.equal(inherited.pending, 0);
    }
    const expectedCopy = { ALLOW: '已授权', TASK: '已授权', DENY: '已拒绝', CANCEL: '已取消', STOP: '已取消', TIMEOUT: '已超时' }[scenario];
    await until(() => card.innerText(), text => text.includes(expectedCopy));
    assert.equal(await card.getByRole('button').count(), 0);
    const late = await page.evaluate(({ workspaceId, approvalId }) => window.peerAgent.projectAgentDecideApproval({ workspaceId, approvalId, decision: 'approve', duration: 'task' }), { workspaceId, approvalId });
    assert.equal(late.ok, true);
    assert.equal(late.approval.state, { success: 'approved', denied: 'denied', cancelled: 'cancelled', timeout: 'expired' }[expected]);
    await card.scrollIntoViewIfNeeded();
    if (scenario !== 'TASK') await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `image-live-${scenario.toLowerCase()}-1280-dark.png`) });
    cases.push({ scenario, realProjection: true, nativeDecode: expected === 'success', pixels: finished.pixels,
      evidence: finished.evidence, ended: true, lateGrantRejected: expected !== 'success', cardAutomatic: true, fits: true });
    await until(() => page.getByRole('button', { name: '停止生成', exact: true }).count(), value => value === 0);
  }
  await page.setViewportSize(viewport); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  report.imagePermissionLifecycle = { cases, realCalls: true, keyboard: true, controlledCognition: true };
}
