import assert from 'node:assert/strict';
import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';

/** Actual UI, preload, IPC and save adapter; the native destination is controlled in this isolated fixture. */
export async function checkBotShellDiagnostics({ page, report, exportFile, fixture }) {
  const before = await page.evaluate(() => window.peerAgent.projectAgentDiagnostics({ action: 'read' }));
  assert.equal(before.ok, true); assert.equal(before.report.bots.length, fixture.bots.length);
  const invalid = await page.evaluate(() => window.peerAgent.projectAgentDiagnostics({ action: 'export', filePath: '/untrusted/destination' }));
  assert.deepEqual(invalid, { ok: false, code: 'INVALID_INPUT' }); assert.equal(existsSync(exportFile), false);
  await page.locator('.bot-app-menu-button').click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.locator('.settings-nav').getByRole('button', { name: '开发者', exact: true }).click();
  await page.getByRole('button', { name: '刷新诊断', exact: true }).click();
  await page.locator('.project-diagnostics__summary').waitFor();
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '诊断已导出' }).waitFor();
  const saved = JSON.parse(readFileSync(exportFile, 'utf8')), body = JSON.stringify(saved);
  assert.equal(saved.schemaVersion, 1); assert.equal(saved.bots.length, fixture.bots.length);
  assert.equal(saved.errors.length, 0); assert.ok(saved.bots.every(bot => bot.errors.length === 0));
  assert.ok(saved.bots.some(bot => bot.turns.some(turn => turn.outcome === 'done' && turn.durationMs >= 0)));
  assert.ok(saved.bots.every(bot => bot.inbox.events.length <= 200 && bot.turns.length <= 20 && bot.workspace === '.'));
  for (const text of ['/Users/', '/private/', 'RC_UI_RECEIPT', 'RC scripted reply', fixture.bots[0].workspaceId, fixture.bots[0].path]) {
    assert.equal(body.includes(text), false, `private field escaped: ${text}`);
  }
  assert.equal(body.includes('unique-needle'), false);
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0) copyFileSync(exportFile, path.join(path.dirname(process.argv[outputIndex + 1]), 'bot-shell-diagnostics.json'));
  report.diagnostics = { bots: saved.bots.length, bytes: Buffer.byteLength(body), errors: 0,
    scope: 'Real source Electron UI/preload/IPC/atomic export; native save destination controlled in isolated fixture; OS dialog interaction is an owner check',
    checks: ['read actual stores', 'reject renderer destination', 'refresh real Developer panel', 'save redacted JSON', 'bounded events/turns', 'actual turn timing', 'no absolute paths, IDs or message text'] };
}
