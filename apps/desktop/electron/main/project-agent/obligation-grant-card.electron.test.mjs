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
  assert.equal(await chat.count(), 4);
  assert.equal(await page.locator('.bot-convo').getByText('无归属旧授权', { exact: true }).count(), 1);
  assert.equal(await page.locator('.bot-convo').getByText('旧任务 · 07ed2604', { exact: true }).count(), 1);
  assert.equal(await page.locator('.bot-convo').getByText('07ed2604-1111-4111-8111-111111111111', { exact: true }).count(), 0);
  assert.equal(await page.locator('.bot-convo').getByText('其他机器人', { exact: true }).count(), 0);
  const four = chat.filter({ hasText: '旧记录甲' });
  for (const title of ['旧记录甲', '旧记录乙', '死亡记录甲', '死亡记录乙']) {
    assert.equal(await four.getByText(title, { exact: true }).count(), 1);
  }
  assert.match(await four.innerText(), /确认只停止跟进/);
  assert.match(await four.innerText(), /不会写入停止回执/);
  assert.equal(await page.locator('.bot-work-panel-toggle').getAttribute('data-needs-user'), 'true');
  await page.screenshot({ path: path.join(shots, 'chat-card.png') });
  const artifact = '/opt/cursor/artifacts';
  try {
    mkdirSync(artifact, { recursive: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(artifact, 'obligation-grant-card-light.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: path.join(artifact, 'obligation-grant-card-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  } catch { /* evidence copy is optional */ }

  await page.getByRole('button', { name: '收起工作现场' }).first().click();
  await four.getByRole('button', { name: '确认', exact: true }).waitFor();
  assert.equal(await page.locator('.bot-work-panel').getAttribute('aria-hidden'), 'true');
  await page.getByRole('button', { name: '展开工作现场' }).click();
  await page.getByRole('button', { name: '查看全部资料' }).click();
  await page.locator('.bot-work-panel .obligation-grant-entry').first().click();
  await page.waitForFunction(() => document.activeElement?.classList.contains('obligation-grant-card'));
  assert.equal(await page.locator('.bot-work-panel .obligation-grant-card').count(), 0);
  assert.equal(await page.locator('.bot-work-panel-scroll').filter({ hasText: '返回工作现场' }).getAttribute('hidden'), null);

  await chat.filter({ hasText: '单独拒绝' }).getByRole('button', { name: '拒绝', exact: true }).click();
  await four.getByRole('button', { name: '确认', exact: true }).click();
  await page.locator('.bot-convo').getByText('旧记录甲', { exact: true }).waitFor({ state: 'detached' });
  await page.locator('.bot-convo').getByText('单独拒绝', { exact: true }).waitFor({ state: 'detached' });
  const after = await app.evaluate(() => globalThis.peerObligationCard.snapshot());
  assert.deepEqual(after.indexed, ['dead-a', 'dead-b', 'legacy-a', 'legacy-b']);
  assert.equal(after.grants.some(grant => grant.status === 'revoked'), true);
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

async function launch(home, mode) {
  const env = { ...process.env, PEER_AGENT_HOME: home, PEER_OBLIGATION_CARD_MODE: mode };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    args: [fileURLToPath(new URL('../../../scripts/obligation-grant-card-electron.mjs', import.meta.url))],
    env, timeout: 30_000,
  });
}

test('a restarted process still shows the persisted grant, and a broken index is an error', { timeout: 90_000 }, async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-restart-'));
  mkdirSync(home, { recursive: true });
  let app = await launch(home, 'seed');
  t.after(async () => { try { await app?.close(); } finally { rmSync(home, { recursive: true, force: true }); } });
  let page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.locator('.bot-convo .obligation-grant-card').first().waitFor();
  await app.close();
  app = await launch(home, 'restart');
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.locator('.bot-convo').getByText('旧记录甲', { exact: true }).waitFor();
  assert.equal(await page.getByText('其他机器人', { exact: true }).count(), 0);
  await app.close();
  app = await launch(home, 'broken');
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.locator('.bot-convo [role=alert]').waitFor();
  assert.match(await page.locator('.bot-convo [role=alert]').innerText(), /obligation_store_unreadable/);
  assert.equal(await page.locator('.bot-convo .obligation-grant-card').count(), 0);
});

test('a legacy grant without a title stays visible when the writer is blocked', { timeout: 90_000 }, async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-blocked-'));
  mkdirSync(home, { recursive: true });
  let app = await launch(home, 'seed');
  t.after(async () => { try { await app?.close(); } finally { rmSync(home, { recursive: true, force: true }); } });
  let page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.locator('.bot-convo').getByText('旧任务 · 07ed2604', { exact: true }).waitFor();
  await app.close();
  app = await launch(home, 'blocked');
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const card = page.locator('.bot-convo .obligation-grant-card', { hasText: '旧任务 · 07ed2604' });
  await card.waitFor();
  assert.match(await card.innerText(), /coordination_legacy_changed/);
  assert.equal(await card.getByRole('button', { name: '确认', exact: true }).isDisabled(), true);
  assert.equal(await card.getByRole('button', { name: '拒绝', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.bot-convo').getByText('07ed2604-1111-4111-8111-111111111111', { exact: true }).count(), 0);
  const decided = await app.evaluate(() => globalThis.peerObligationCard.decide());
  assert.equal(decided.ok, false);
  assert.equal(decided.code, 'coordination_legacy_changed');
  assert.notEqual(decided.code, 'grant_not_found');
  const after = await app.evaluate(() => globalThis.peerObligationCard.snapshot());
  assert.equal(after.grants.find(grant => grant.count === 1 && grant.status === 'pending') != null, true);
  const log = readFileSync(path.join(home, 'logs', 'obligation.log'), 'utf8');
  assert.match(log, /"event":"recovery".*"code":"coordination_legacy_changed".*"check":"writer_fence_unrecognized".*"seal":"present".*"change":"metadata".*"file":"writer_fence"/);
});
