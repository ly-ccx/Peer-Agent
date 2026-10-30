import { BOT_DETAIL_SURFACE, BOT_DETAIL_CLOSE } from './bot-detail-surface-selectors.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';

/** Production appearance settings and shell; only the disposable app home is changed. */
export async function checkBotWindowMaterial({ page, until, report, captureDirectory }) {
  const previous = await page.evaluate(() => window.peerAgent.getSettings());
  const viewport = page.viewportSize();
  const previousTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const nativeGlass = await page.evaluate(() => document.documentElement.dataset.vibrancy === 'true');
  const cases = [];
  const settingsCases = [];
  const openAppearance = async () => {
    await page.locator('.bot-app-menu-button').click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '外观', exact: true }).click();
    await page.locator('.appearance-panel').waitFor();
  };
  const closeAppearance = async () => {
    await page.locator('.settings-nav-header > button').click();
    await page.locator('.app-settings-page').waitFor({ state: 'detached' });
  };
  const inspectSettings = async (theme, material, reduced = false) => {
    const actual = await page.locator('.app-settings-page').evaluate(shell => {
      const nav = shell.querySelector('.settings-nav'), content = shell.querySelector('.settings-content');
      const n = nav.getBoundingClientRect(), c = content.getBoundingClientRect(), s = shell.getBoundingClientRect();
      const probe = document.createElement('span'); probe.style.background = 'var(--window-chrome-fill)';
      shell.append(probe); const expected = getComputedStyle(probe).backgroundColor; probe.remove();
      return { viewportAligned: s.left === 0 && s.top === 0 && s.right === innerWidth && s.bottom === innerHeight && scrollX === 0,
        navVisible: n.left >= 0 && n.right <= innerWidth,
        background: getComputedStyle(shell).backgroundColor, expected,
        sidebar: getComputedStyle(nav).backgroundColor, divider: getComputedStyle(nav).borderRightWidth,
        radius: parseFloat(getComputedStyle(content).borderRadius), gap: c.left - n.right,
        top: c.top - s.top, right: s.right - c.right, bottom: s.bottom - c.bottom,
        fits: shell.scrollWidth <= shell.clientWidth && content.scrollWidth <= content.clientWidth };
    });
    assert.ok(actual.fits && actual.viewportAligned && actual.navVisible,
      `settings and navigation remain inside the actual viewport: ${JSON.stringify(actual)}`);
    if (nativeGlass) {
      assert.equal(actual.background, actual.expected, 'settings and chat use the same window material decision');
      assert.equal(actual.sidebar, 'rgba(0, 0, 0, 0)', 'settings navigation does not tint the window a second time');
      assert.equal(actual.divider, '0px', 'settings navigation has no old vertical seam');
      assert.ok(actual.gap >= 9 && actual.top >= 9 && actual.right >= 9 && actual.bottom >= 9 && actual.radius > 0,
        'settings content is a separate floating panel in every material');
    }
    settingsCases.push({ width: page.viewportSize().width, theme, material, reduced, nativeGlass, ...actual });
    const suffix = reduced ? 'reduced-760-light' : `${material}-${page.viewportSize().width}-${theme}`;
    await page.locator('.settings-content').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `settings-floating-${suffix}.png`) });
  };
  const choose = async (theme, material, inspect = false) => {
    await openAppearance();
    await page.getByRole('radio', { name: theme === 'dark' ? '深色' : '浅色', exact: true }).click();
    if (nativeGlass) await page.getByRole('group', { name: '窗口材质', exact: true }).getByRole('button', { name: material === 'glass' ? '毛玻璃' : '实色', exact: true }).click();
    await until(() => page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.windowMaterial]),
      state => state[0] === theme && (!nativeGlass || state[1] === material));
    if (inspect) await inspectSettings(theme, material);
    await closeAppearance();
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
    await closeAppearance();
    for (const [width, theme] of [[1280, 'dark'], [760, 'light']]) {
      await page.setViewportSize({ width, height: 860 });
      for (const material of ['glass', 'solid']) {
        await choose(theme, material, true);
        const actual = await page.locator('.bot-shell').evaluate((shell, material) => {
          const probe = document.createElement('span');
          const transparencyReduced = matchMedia('(prefers-reduced-transparency: reduce)').matches;
          probe.style.background = `var(${material === 'glass' && !transparencyReduced ? '--glass-chrome' : '--chrome-raised'})`;
          shell.append(probe); const expected = getComputedStyle(probe).backgroundColor; probe.remove();
          const canvas = shell.closest('.bot-resource-layout') ?? shell;
          const column = shell.querySelector('.bot-column'), main = shell.querySelector('.bot-main');
          const c = column.getBoundingClientRect(), m = main.getBoundingClientRect(), s = shell.getBoundingClientRect();
          return { background: getComputedStyle(canvas).backgroundColor, expected, transparencyReduced,
            resourceHost: canvas !== shell, innerBackground: getComputedStyle(shell).backgroundColor,
            sidebar: getComputedStyle(column).backgroundColor, divider: getComputedStyle(column).borderRightWidth, radius: parseFloat(getComputedStyle(main).borderRadius),
            gap: m.left - c.right, top: m.top - s.top, shellWidth: shell.clientWidth, scrollWidth: shell.scrollWidth,
            fits: shell.scrollWidth <= shell.clientWidth };
        }, material);
        assert.ok(actual.fits, JSON.stringify({ width, theme, material, ...actual }));
        if (nativeGlass) {
          assert.equal(actual.background, actual.expected, 'one theme-derived tint covers sidebar and all panel gutters');
          if (actual.resourceHost) assert.equal(actual.innerBackground, 'rgba(0, 0, 0, 0)', 'the inner conversation shell does not apply the resource canvas tint twice');
          assert.equal(actual.divider, '0px', 'floating panels replace the old sidebar seam');
          assert.equal(actual.sidebar, 'rgba(0, 0, 0, 0)', 'sidebar cannot tint the same backdrop a second time');
          assert.ok(actual.gap >= 9 && actual.top >= 9 && actual.radius > 0, 'content remains floating in either material');
        }
        cases.push({ width, theme, material, nativeGlass, ...actual });
        await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `window-material-${material}-${width}-${theme}.png`) });
        if (width === 1280 && theme === 'dark' && material === 'glass') {
          await page.getByRole('button', { name: '机器人设置', exact: true }).click();
          const dock = page.locator(BOT_DETAIL_SURFACE); await dock.waitFor();
          await until(() => dock.evaluate(node => node.getBoundingClientRect().width), value => value > 300);
          const settledDock = () => dock.evaluate(node => {
            const main = document.querySelector('.bot-main').getBoundingClientRect();
            return node.getBoundingClientRect().left - main.right >= 9 && parseFloat(getComputedStyle(node).borderRadius) > 0;
          });
          if (nativeGlass) {
            await until(settledDock, Boolean);
            assert.equal(await settledDock(), true, 'details and main content remain separate floating panels');
          }
          await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'window-material-drawer-1280-dark.png') });
          await page.locator(BOT_DETAIL_CLOSE).click();
          await page.locator(BOT_DETAIL_SURFACE).waitFor({ state: 'hidden' });
        }
      }
    }
    const cdp = await page.context().newCDPSession(page);
    try {
      await choose('light', 'glass');
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      if (nativeGlass) assert.equal(await page.locator('.bot-shell').evaluate(shell => {
        const probe = document.createElement('span'); probe.style.background = 'var(--chrome-raised)'; shell.append(probe);
        const expected = getComputedStyle(probe).backgroundColor; probe.remove();
        const canvas = shell.closest('.bot-resource-layout') ?? shell;
        return getComputedStyle(canvas).backgroundColor === expected
          && (canvas === shell || getComputedStyle(shell).backgroundColor === 'rgba(0, 0, 0, 0)')
          && getComputedStyle(shell.querySelector('.bot-column')).backgroundColor === 'rgba(0, 0, 0, 0)';
      }), true, 'reduced transparency uses one solid base without changing floating layout');
      await openAppearance();
      await inspectSettings('light', 'glass', true);
      await closeAppearance();
      await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'window-material-reduced-760-light.png') });
    } finally { await cdp.send('Emulation.setEmulatedMedia', { features: [] }); await cdp.detach(); }
    report.windowMaterial = { passed: true, cases, settingsCases, settingsKeyboard: nativeGlass, settingsPersisted: nativeGlass,
      reducedTransparency: true, nativeGlass, scope: 'Production appearance IPC and renderer over an isolated home; native desktop blur compositing needs visual review' };
  } finally {
    if (!await page.locator('.app-settings-page').count()) await openAppearance();
    const originalMode = previous.appearance?.mode ?? 'system';
    await page.getByRole('radio', { name: ({ dark: '深色', light: '浅色', system: '跟随系统' })[originalMode], exact: true }).click();
    if (nativeGlass) await page.getByRole('group', { name: '窗口材质', exact: true }).getByRole('button', {
      name: previous.appearance?.windowMaterial === 'solid' ? '实色' : '毛玻璃', exact: true,
    }).click();
    await closeAppearance();
    await page.evaluate(({ previous, previousTheme }) => {
      document.documentElement.dataset.theme = previousTheme;
      return window.peerAgent.updateSettings({ appearance: previous.appearance ?? {} });
    }, { previous, previousTheme });
    if (viewport) await page.setViewportSize(viewport);
  }
}
