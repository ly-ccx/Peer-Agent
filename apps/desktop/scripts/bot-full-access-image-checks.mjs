import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export async function checkBotFullAccessImages({ page, until, report, captureDirectory, receiptFile, workspaceId }) {
  const read = () => JSON.parse(readFileSync(receiptFile, 'utf8'));
  const viewport = page.viewportSize(), theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const old = await page.evaluate(workspaceId => window.peerAgent.projectAgentListApprovals({ workspaceId }), workspaceId);
  const oldCount = (Array.isArray(old) ? old : old.approvals || []).length;
  await page.locator('.bot-composer textarea').fill('RC_IMAGE_FULL');
  await page.locator('.bot-composer textarea').press('Enter');
  const finished = await until(() => read().findLast(row => row.scenario === 'FULL' && row.stage === 'finished'), Boolean);
  assert.equal(finished.status, 'success'); assert.equal(finished.images, 4); assert.equal(finished.pending, 0);
  const calls = read().filter(row => row.scenario === 'FULL' && row.stage === 'full-read');
  assert.equal(calls.length, 4); assert.equal(new Set(calls.map(row => row.sha256)).size, 4);
  assert.ok(calls.every(row => row.pixels && row.evidence && row.grantId.startsWith('auto-')));
  const current = await page.evaluate(workspaceId => window.peerAgent.projectAgentListApprovals({ workspaceId }), workspaceId);
  assert.equal((Array.isArray(current) ? current : current.approvals || []).length, oldCount,
    'Full creates no additional per-image approval records');
  assert.equal(await page.locator('[data-card-id*="chat-permission:image-full-"]').count(), 0);
  await page.locator('.bot-convo').getByText('四张图片已经连续读取，我会接着核对结果。', { exact: true }).waitFor();
  await until(() => page.locator('.bot-live-reply[data-phase="awaiting_permission"]').count(), count => count === 0);
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 860 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `image-full-${width}-${appearance}.png`) });
  }
  if (viewport) await page.setViewportSize(viewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  report.imageFullAccess = { realCalls: true, images: 4, pixels: true, evidence: true, noPermissionCards: true, noApprovalRecords: true };
}
