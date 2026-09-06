import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

test('production panel: theme matrix and modal/non-modal keyboard boundaries', {
  skip: process.env.PEER_BACKGROUND_UI_SMOKE !== '1', timeout: 90000,
}, async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'peer-background-visual-home-'));
  const artifacts = mkdtempSync(path.join(tmpdir(), 'peer-background-visual-evidence-'));
  const env = { ...process.env, PEER_AGENT_HOME: home, PEER_BACKGROUND_SMOKE_HOME: home, PEER_BACKGROUND_VISUAL_FIXTURE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  t.after(async () => { try { await app?.close(); } finally { rmSync(home, { recursive: true, force: true }); } });
  app = await electron.launch({ args: [fileURLToPath(new URL('../../scripts/background-tasks-electron-fixture.mjs', import.meta.url))], env, timeout: 10000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  const panel = page.locator('.background-runtime-panel');
  const entry = page.locator('#entry');
  const measurements = [];
  const capture = async (name) => {
    await panel.waitFor();
    await page.waitForTimeout(250);
    const m = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, radius: s.borderRadius,
        overflow: el.scrollWidth - el.clientWidth, modal: el.getAttribute('aria-modal'), background: s.backgroundColor };
    });
    assert.equal(m.radius, '16px');
    assert.equal(m.modal, null);
    assert.ok(m.x >= 11 && m.y >= 11 && m.right <= (await page.evaluate(() => innerWidth)) - 11, JSON.stringify(m));
    assert.ok(m.overflow <= 1, JSON.stringify(m));
    measurements.push({ name, ...m });
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  };
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
    await entry.click();
    await capture(`${theme}-list`);
    await page.locator('.background-run-row').click();
    assert.equal(await panel.locator('details[open]').count(), 0);
    await capture(`${theme}-details`);
    await panel.getByRole('button', { name: '‹ 后台运行', exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.runId), 'visual-only', 'return restores row focus');
    await page.keyboard.press('Enter');
    await panel.locator('.background-run-detail').waitFor();
    await panel.getByRole('button', { name: '停止…', exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '取消');
    await capture(`${theme}-confirm`);
    await page.keyboard.press('Escape');
    assert.equal(await panel.locator('.background-run-confirm').count(), 0);
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'entry');
  }
  await page.locator('#many-runs').click();
  await entry.click();
  const deepRow = panel.locator('[data-run-id="run-25"]');
  await deepRow.scrollIntoViewIfNeeded();
  const previousScroll = await panel.evaluate((el) => el.scrollTop);
  assert.ok(previousScroll > 0, 'fixture exercises a nonzero list offset');
  await deepRow.click();
  await panel.getByRole('button', { name: '停止…', exact: true }).click();
  await panel.getByRole('button', { name: '‹ 后台运行', exact: true }).click();
  assert.equal(await panel.locator('.background-run-confirm').count(), 0, 'return dismisses only local confirmation');
  assert.equal(await panel.evaluate((el) => el.scrollTop), previousScroll);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.runId), 'run-25');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  await page.locator('#many-runs').click();
  await entry.click();
  await panel.getByRole('button', { name: '关闭', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('background-run-row')), true);
  let leftPanel = false;
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press('Tab');
    leftPanel = await panel.evaluate((el) => !el.contains(document.activeElement));
    if (leftPanel) break;
  }
  assert.equal(leftPanel, true, 'non-modal Tab must not trap focus');
  await page.locator('#outside').click();
  await panel.waitFor({ state: 'hidden' });
  assert.match(await page.locator('#outside').innerText(), /1/);
  await page.locator('#modal-trigger').click();
  assert.equal(await page.getByRole('dialog').getAttribute('aria-modal'), 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('#modal-trigger').click();
  await page.locator('.pa-overlay-backdrop').click({ position: { x: 5, y: 5 } });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 360, height: 600 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#modal-trigger').click();
  const legacyDialog = page.getByRole('dialog');
  await legacyDialog.getByRole('button', { name: '模态内容' }).focus();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '模态内容');
  const legacy = await legacyDialog.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: innerWidth,
      durations: getComputedStyle(el).animationDuration.split(',').map(parseFloat) };
  });
  assert.ok(legacy.left >= 0 && legacy.right <= legacy.width, JSON.stringify(legacy));
  assert.ok(legacy.durations.every((duration) => duration <= 0.01), JSON.stringify(legacy));
  await page.keyboard.press('Escape');
  await legacyDialog.waitFor({ state: 'hidden' });
  await entry.click();
  await capture('narrow-reduced-motion');
  const reduced = await panel.evaluate((el) => ({
    requested: matchMedia('(prefers-reduced-motion: reduce)').matches,
    durations: getComputedStyle(el).animationDuration.split(',').map((value) => parseFloat(value)),
  }));
  assert.equal(reduced.requested, true);
  assert.ok(reduced.durations.every((duration) => duration <= 0.01), JSON.stringify(reduced));
  await page.evaluate(() => document.documentElement.style.fontSize = '200%');
  await capture('narrow-200-percent');
  await page.locator('#long-text').click();
  await entry.click();
  await capture('narrow-long-list');
  await page.locator('.background-run-row').click();
  await panel.locator('summary').getByText('日志', { exact: true }).click();
  await capture('narrow-long-details');
  await panel.getByRole('button', { name: '停止…', exact: true }).click();
  await capture('narrow-long-confirm');
  const cancel = panel.getByRole('button', { name: '取消', exact: true });
  await cancel.scrollIntoViewIfNeeded();
  assert.equal(await cancel.isVisible(), true);
  const media = await page.context().newCDPSession(page);
  await media.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-transparency', value: 'reduce' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ] });
  const transparency = await panel.evaluate((el) => ({
    requested: matchMedia('(prefers-reduced-transparency: reduce)').matches,
    filter: getComputedStyle(el, '::before').backdropFilter,
    surface: getComputedStyle(el, '::before').backgroundColor,
  }));
  assert.equal(transparency.requested, true);
  assert.equal(transparency.filter, 'none');
  assert.notEqual(transparency.surface, 'rgba(0, 0, 0, 0)');
  measurements.push({ name: 'reduced-transparency', ...transparency });
  await capture('narrow-reduced-transparency');
  await media.detach();
  writeFileSync(path.join(artifacts, 'measurements.json'), JSON.stringify(measurements, null, 2));
  t.diagnostic(`Screenshots and measured styles: ${artifacts}`);
});
