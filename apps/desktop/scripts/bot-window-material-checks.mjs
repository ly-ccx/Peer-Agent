import assert from 'node:assert/strict';
import path from 'node:path';

/** Production appearance settings and shell; only the disposable app home is changed. */
export async function checkBotWindowMaterial({ page, until, report, captureDirectory }) {
  const previous = await page.evaluate(() => window.peerAgent.getSettings());
  const viewport = page.viewportSize();
  const nativeGlass = await page.evaluate(() => document.documentElement.dataset.vibrancy === 'true');
  const cases = [];
  const openAppearance = async () => {
    await page.locator('.bot-app-menu-button').click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '外观', exact: true }).click();
    await page.locator('.appearance-panel').waitFor();
  };
  try {
    await page.setViewportSize({ width: 1280, height: 860 });
    await openAppearance();
    if (nativeGlass) {
      const controls = page.getByRole('group', { name: '窗口材质', exact: true });
      for (const [label, value] of [['实色', 'solid'], ['毛玻璃', 'glass']]) {
        const button = controls.getByRole('button', { name: label, exact: true });
        await button.focus(); await button.press('Space');
        await until(() => button.getAttribute('aria-pressed'), value => value === 'true');
        await until(() => page.evaluate(() => window.peerAgent.getSettings()), settings => settings.appearance?.windowMaterial === value);
      }
    }
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'window-material-settings-1280.png') });
    await page.locator('.settings-nav-header > button').click();
    await page.locator('.app-settings-page').waitFor({ state: 'detached' });
    for (const [width, theme] of [[1280, 'dark'], [760, 'light']]) {
      await page.setViewportSize({ width, height: 860 });
      for (const material of ['glass', 'solid']) {
        await page.evaluate(({ previous, theme, material }) => window.peerAgent.updateSettings({ appearance: {
          ...previous.appearance, mode: theme, windowMaterial: material,
        } }), { previous, theme, material });
        await until(() => page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.windowMaterial]),
          state => state[0] === theme && state[1] === material);
        const actual = await page.locator('.bot-shell').evaluate((shell, material) => {
          const probe = document.createElement('span');
          probe.style.background = `var(${material === 'glass' ? '--glass-chrome' : '--chrome-raised'})`;
          shell.append(probe); const expected = getComputedStyle(probe).backgroundColor; probe.remove();
          const column = shell.querySelector('.bot-column'), main = shell.querySelector('.bot-main');
          const c = column.getBoundingClientRect(), m = main.getBoundingClientRect(), s = shell.getBoundingClientRect();
          return { background: getComputedStyle(shell).backgroundColor, expected,
            sidebar: getComputedStyle(column).backgroundColor, radius: parseFloat(getComputedStyle(main).borderRadius),
            gap: m.left - c.right, top: m.top - s.top, fits: shell.scrollWidth <= shell.clientWidth };
        }, material);
        assert.ok(actual.fits);
        if (nativeGlass) {
          assert.equal(actual.background, actual.expected, 'one theme-derived tint covers sidebar and all panel gutters');
          assert.equal(actual.sidebar, 'rgba(0, 0, 0, 0)', 'sidebar cannot tint the same backdrop a second time');
          assert.ok(actual.gap >= 9 && actual.top >= 9 && actual.radius > 0, 'content remains floating in either material');
        }
        cases.push({ width, theme, material, nativeGlass, ...actual });
        await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `window-material-${material}-${width}-${theme}.png`) });
      }
    }
    const cdp = await page.context().newCDPSession(page);
    try {
      await page.evaluate(previous => window.peerAgent.updateSettings({ appearance: { ...previous.appearance, mode: 'light', windowMaterial: 'glass' } }), previous);
      await until(() => page.evaluate(() => document.documentElement.dataset.windowMaterial), value => value === 'glass');
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      if (nativeGlass) assert.equal(await page.locator('.bot-shell').evaluate(shell => {
        const probe = document.createElement('span'); probe.style.background = 'var(--chrome-raised)'; shell.append(probe);
        const expected = getComputedStyle(probe).backgroundColor; probe.remove();
        return getComputedStyle(shell).backgroundColor === expected && getComputedStyle(shell.querySelector('.bot-column')).backgroundColor === 'rgba(0, 0, 0, 0)';
      }), true, 'reduced transparency uses one solid base without changing floating layout');
      await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'window-material-reduced-760-light.png') });
    } finally { await cdp.send('Emulation.setEmulatedMedia', { features: [] }); await cdp.detach(); }
    report.windowMaterial = { passed: true, cases, settingsKeyboard: nativeGlass, settingsPersisted: nativeGlass,
      reducedTransparency: true, nativeGlass, scope: 'Production appearance IPC and renderer over an isolated home; native desktop blur compositing needs visual review' };
  } finally {
    await page.evaluate(previous => window.peerAgent.updateSettings({ appearance: previous.appearance ?? {} }), previous);
    if (viewport) await page.setViewportSize(viewport);
  }
}
