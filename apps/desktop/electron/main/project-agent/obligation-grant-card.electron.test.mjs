import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

test('the authorization card is in the bot chat and survives a closed or materials work panel', { timeout: 90_000 }, async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-card-'));
  mkdirSync(home, { recursive: true });
  const shots = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-card-shots-'));
  const env = { ...process.env, PEER_AGENT_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  t.after(async () => { try { await app?.close(); } finally { rmSync(home, { recursive: true, force: true }); } });
  app = await electron.launch({
    args: [fileURLToPath(new URL('../../../scripts/obligation-grant-card-electron.mjs', import.meta.url))],
    env, timeout: 30_000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const chat = page.locator('.bot-convo .obligation-grant-card');
  await chat.first().waitFor();
  assert.equal(await chat.count(), 2);
  const four = chat.filter({ hasText: '旧记录甲' });
  for (const title of ['旧记录甲', '旧记录乙', '死亡记录甲', '死亡记录乙']) {
    assert.equal(await four.getByText(title, { exact: true }).count(), 1);
  }
  assert.match(await four.innerText(), /确认只停止跟进/);
  assert.match(await four.innerText(), /不会写入停止回执/);
  assert.equal(await page.locator('.bot-work-panel-toggle').getAttribute('data-needs-user'), 'true');
  await page.screenshot({ path: path.join(shots, 'chat-card.png') });
  const artifact = '/opt/cursor/artifacts';
  try { mkdirSync(artifact, { recursive: true }); await page.screenshot({ path: path.join(artifact, 'obligation-grant-card.png') }); } catch { /* evidence copy is optional */ }

  await page.getByRole('button', { name: '收起工作现场' }).first().click();
  await four.getByRole('button', { name: '确认', exact: true }).waitFor();
  assert.equal(await page.locator('.bot-work-panel').getAttribute('aria-hidden'), 'true');
  await page.getByRole('button', { name: '展开工作现场' }).click();
  await page.getByRole('button', { name: '查看全部资料' }).click();
  await page.locator('.bot-work-panel .obligation-grant-card').first().waitFor();
  assert.equal(await page.locator('.bot-work-panel-scroll').filter({ hasText: '返回工作现场' }).getAttribute('hidden'), null);

  await chat.filter({ hasText: '单独拒绝' }).getByRole('button', { name: '拒绝', exact: true }).click();
  await four.getByRole('button', { name: '确认', exact: true }).click();
  await page.locator('.bot-convo .obligation-grant-card').waitFor({ state: 'detached' });
  const after = await app.evaluate(() => globalThis.peerObligationCard.snapshot());
  assert.deepEqual(after.indexed, ['dead-a', 'dead-b', 'legacy-a', 'legacy-b']);
  assert.equal(after.grants.find(grant => grant.count === 1)?.status, 'revoked');
  assert.equal(after.grants.find(grant => grant.count === 4)?.status, 'confirmed');
  const log = readFileSync(path.join(home, 'logs', 'obligation.log'), 'utf8');
  assert.match(log, /"event":"list"/);
  assert.match(log, /"event":"decide"/);
  assert.equal(log.includes('旧记录甲'), false);

  await app.evaluate(() => { globalThis.peerObligationCard.failList(true); globalThis.peerObligationCard.notify(); });
  await page.locator('.bot-convo [role=alert]').waitFor();
  assert.match(await page.locator('.bot-convo [role=alert]').innerText(), /授权状态暂时读不到/);
  await page.locator('.bot-convo').getByRole('button', { name: '重试', exact: true }).click();
  await page.locator('.bot-convo [role=alert]').waitFor();
  await page.screenshot({ path: path.join(shots, 'grant-error.png') });
  try { await page.screenshot({ path: path.join(artifact, 'obligation-grant-error.png') }); } catch { /* optional */ }
  await app.evaluate(() => globalThis.peerObligationCard.failList(false));
  await page.locator('.bot-convo').getByRole('button', { name: '重试', exact: true }).click();
  await page.locator('.bot-convo [role=alert]').waitFor({ state: 'detached' });
  console.log(`Obligation card screenshots: ${shots}`);
});
