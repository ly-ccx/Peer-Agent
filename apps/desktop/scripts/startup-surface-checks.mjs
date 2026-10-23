import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

/** Real MainApp startup and appearance IPC. Only the disposable fixture's
 * bootstrap handler is delayed; no renderer tree or layout is substituted. */
export async function checkStartupSurface({ page, until, report, captureDirectory, commandFile }) {
  await page.locator('.brand-startup-loader').waitFor();
  const settings = await page.evaluate(() => window.peerAgent.getSettings());
  const cases = [];
  for (const width of [1280, 760]) for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width, height: 860 });
    await page.evaluate(async ({ settings, theme }) => {
      await window.peerAgent.updateSettings({ appearance: { ...settings.appearance, mode: theme } });
    }, { settings, theme });
    // Main-window theme controls update their own React state; the native
    // broadcast targets companion windows. Cold reload reads persisted settings
    // through the production preload snapshot, as a real startup does.
    await page.reload();
    await page.locator('.brand-startup-loader').waitFor();
    await until(() => page.evaluate(() => document.documentElement.dataset.theme), value => value === theme);
    const actual = await page.locator('.startup-surface').evaluate(surface => {
      const loader = surface.querySelector('.brand-startup-loader'), shell = surface.parentElement;
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const r = rect(surface), l = rect(loader), s = getComputedStyle(surface);
      return { surface: r, loader: l, viewport: { width: innerWidth, height: innerHeight },
        padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft],
        border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
        oldThreadAbsent: !surface.closest('.thread') && !surface.querySelector('.thread'),
        shellMotion: getComputedStyle(shell).animationName,
        fits: surface.scrollWidth <= surface.clientWidth && surface.scrollHeight <= surface.clientHeight };
    });
    assert.deepEqual(actual.surface, { x: 0, y: 0, ...actual.viewport });
    assert.deepEqual(actual.loader, actual.surface, 'the startup wash reaches every window edge');
    assert.deepEqual(actual.padding, ['0px', '0px', '0px', '0px']);
    assert.deepEqual(actual.border, ['0px', '0px', '0px', '0px']);
    assert.ok(actual.oldThreadAbsent && actual.fits); assert.equal(actual.shellMotion, 'none');
    cases.push({ width, theme, ...actual });
    await page.screenshot({ path: path.join(captureDirectory, `startup-${width}-${theme}.png`), animations: 'disabled' });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.brand-startup-loader__brand').evaluate(node => getComputedStyle(node).opacity), '1');
  writeFileSync(commandFile, JSON.stringify({ release: true }));
  await page.locator('.bot-shell').waitFor();
  assert.equal(await page.locator('.startup-surface').count(), 0);
  assert.equal(await page.locator('.app-shell.is-starting').count(), 0);
  // Reload only this isolated fixture, exercising the real bootstrap error path.
  writeFileSync(commandFile, JSON.stringify({ release: true, error: true }));
  await page.reload();
  await page.locator('.startup-surface .running-note').waitFor();
  assert.match(await page.locator('.startup-surface .running-note').textContent(), /RC_STARTUP_UNAVAILABLE/);
  assert.equal(await page.locator('.brand-startup-loader').count(), 0);
  await page.screenshot({ path: path.join(captureDirectory, 'startup-error-760-light.png'), animations: 'disabled' });
  report.startupSurface = { passed: true, realBootstrap: true, realMainApp: true, cases,
    reducedMotion: true, entersBotShell: true, failureExplained: true, installedAppTouched: false };
}
