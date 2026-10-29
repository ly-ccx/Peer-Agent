import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkUpdaterMinimize } from './updater-minimize-checks.mjs';

export async function checkBotShellUpdater({ page, app, emitUpdaterEvent, until, report, home, captureDirectory }) {
  const checks = report.updater = [];
  const badge = page.locator('.bot-brand .bot-version-subtitle');
  const header = page.locator('.bot-column-top');
  await badge.waitFor({ timeout: 5000 });
  const settingsMark = page.locator('.bot-column-footer .bot-app-menu-icon');
  assert.equal(await page.locator('.bot-app-menu-button svg').count(), 1, 'the settings entry must use an SVG icon');
  assert.equal((await settingsMark.textContent()).trim(), '', 'the settings icon must not contain a character glyph');
  const footer = page.locator('.bot-column-footer');
  assert.equal(await page.locator('.bot-column-footer .sidebar-version-badge').count(), 0, 'version leaves the settings row');
  assert.equal(await page.locator('.bot-app-menu-details .sidebar-version-badge').count(), 0);
  const geometry = await page.evaluate(() => {
    const box = element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, height: rect.height }; };
    const footerNode = document.querySelector('.bot-column-footer');
    return { footer: box(footerNode), settings: box(footerNode.querySelector('.bot-app-menu-button')),
      name: box(document.querySelector('.bot-brand-name')), version: box(document.querySelector('.bot-version-subtitle')) };
  });
  report.updaterInitialGeometry = geometry;
  assert.ok(geometry.footer.height <= 64, 'settings footer stays compact without the version control');
  assert.equal(await badge.locator('.pa-dropdown-trigger').count(), 0, 'update channel belongs in settings only');
  assert.ok(geometry.version.y >= geometry.name.y + geometry.name.height - 2, 'version sits under the Peer name');
  assert.ok(Math.abs(geometry.version.x - geometry.name.x) <= 2, 'version aligns with the Peer name');
  report.updaterFooterHeight = geometry.footer.height;
  checks.push('version is a subtitle under Peer; settings footer no longer carries update metadata');
  const settingsTrigger = page.locator('.bot-app-menu-button');
  assert.equal((await settingsTrigger.textContent()).trim(), '设置');
  await settingsTrigger.focus(); await settingsTrigger.press('Enter');
  const menu = page.getByRole('menu', { name: '设置', exact: true });
  await menu.waitFor();
  assert.equal(await menu.getByRole('menuitem').count(), 4);
  assert.equal(await menu.locator('button svg').count(), 4);
  const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim());
  assert.equal(await focused(), '设置');
  await page.keyboard.press('ArrowDown'); assert.equal(await focused(), '历史对话');
  await page.keyboard.press('End'); assert.ok((await focused()).startsWith('能力'));
  await page.keyboard.press('ArrowDown'); assert.equal(await focused(), '设置');
  await page.keyboard.press('ArrowUp'); assert.ok((await focused()).startsWith('能力'));
  await page.keyboard.press('Home'); assert.equal(await focused(), '设置');
  if (captureDirectory) {
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.locator('.bot-app-menu').screenshot({ path: path.join(captureDirectory, 'bot-footer-settings-dark.png') });
    const menuBox = await menu.boundingBox();
    const footerBox = await footer.boundingBox();
    await page.screenshot({ path: path.join(captureDirectory, 'bot-footer-menu-dark.png'),
      clip: { x: footerBox.x, y: menuBox.y, width: footerBox.width, height: footerBox.y + footerBox.height - menuBox.y } });
  }
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
  report.footerEscapeFocus = await page.evaluate(() => ({ tag: document.activeElement?.tagName,
    className: document.activeElement?.className, text: document.activeElement?.textContent?.trim().slice(0, 100) }));
  assert.equal(await settingsTrigger.evaluate(node => node === document.activeElement), true);
  await settingsTrigger.press('Enter'); await menu.waitFor();
  await page.keyboard.press('Tab'); await menu.waitFor({ state: 'detached' });
  assert.equal(await settingsTrigger.evaluate(node => node === document.activeElement), true);
  await settingsTrigger.focus(); await settingsTrigger.press('Enter'); await menu.waitFor();
  await page.keyboard.press('Shift+Tab'); await menu.waitFor({ state: 'detached' });
  assert.equal(await settingsTrigger.evaluate(node => node === document.activeElement), true);
  checks.push('settings replaces the identity placeholder; all four SVG menu items support arrows, Home/End, and Escape or Tab focus return');
  const initial = await page.evaluate(() => window.peerAgent.updaterGetStatus());
  const candidate = /^(\d+\.\d+\.\d+)-(alpha|beta|rc)\.(\d+)$/.exec(initial.currentVersion);
  assert.equal(await badge.locator('.sidebar-version-text').textContent(), `v${candidate?.[1] ?? initial.currentVersion}`);
  if (candidate) assert.equal(await badge.locator('.sidebar-version-stage').textContent(), `${candidate[2].toUpperCase()} ${candidate[3]}`);
  assert.equal(await badge.locator('button').count(), 0, 'the version subtitle is not the update control');
  assert.equal(await badge.locator('select').count(), 0);
  checks.push('current version is the Peer subtitle; update channel is absent from the list column');

  for (const [preference, option] of [
    ['beta', 'Beta（尝鲜版）'], ['stable', '正式（稳定版）'], ['auto', '自动（跟随当前版本）'],
  ]) {
    await page.locator('.bot-app-menu-button').click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '更新与关于', exact: true }).click();
    const settingsChannel = page.getByRole('button', { name: '更新通道', exact: true });
    await settingsChannel.waitFor({ state: 'visible' });
    assert.equal(await settingsChannel.locator('svg').count(), 1);
    await settingsChannel.focus(); await settingsChannel.press('Enter');
    await page.getByRole('listbox', { name: '更新通道', exact: true }).waitFor();
    await settingsChannel.press('Escape');
    assert.equal(await settingsChannel.evaluate(node => node === document.activeElement), true);
    await settingsChannel.click();
    await page.getByRole('option', { name: option, exact: true }).click();
    await until(() => page.evaluate(() => window.peerAgent.updaterGetStatus()), state => state.preference === preference);
    assert.equal(JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8')).updateChannel, preference);
    await page.locator('.settings-nav').getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await badge.locator('.pa-dropdown-trigger').count(), 0);
  }
  checks.push('Updates & about retains its SVG channel selector, keyboard focus and all three persisted preferences through production IPC');

  await emitUpdaterEvent({ type: 'update-available', version: '0.1.0-rc.99' });
  const upgrade = page.locator('.bot-column-top .bot-upgrade');
  await upgrade.waitFor();
  const { upgradeBox, plusBox } = await page.evaluate(() => {
    const box = selector => {
      const { left, right, y, height } = document.querySelector(selector).getBoundingClientRect();
      return { left, right, y, height };
    };
    return { upgradeBox: box('.bot-column-top .bot-upgrade'), plusBox: box('.bot-new') };
  });
  assert.ok(upgradeBox.right <= plusBox.left + 1 && plusBox.left - upgradeBox.right <= 16, 'upgrade control sits immediately left of new');
  assert.ok(Math.abs((upgradeBox.y + upgradeBox.height / 2) - (plusBox.y + plusBox.height / 2)) <= 2, 'upgrade control aligns with new');
  await upgrade.click();
  const dialog = page.getByRole('dialog', { name: '发现新版本', exact: true });
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  checks.push('upgrade icon left of new opens the existing update modal and Escape closes it');

  report.updaterPhaseScope = 'Synthetic updater events verify renderer states only; no release download or install is performed';
  const fit = async () => {
    const layouts = await page.evaluate(() => {
      const box = (rect) => rect ? {
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
      } : null;
      const measure = () => {
        const column = document.querySelector('.bot-column').getBoundingClientRect();
        const footer = document.querySelector('.bot-column-footer');
        const top = document.querySelector('.bot-column-top');
        const upgradeEl = top.querySelector('.bot-upgrade');
        const upgrade = upgradeEl?.getBoundingClientRect();
        const value = upgradeEl?.querySelector('.bot-upgrade-value');
        const valueBox = value?.getBoundingClientRect();
        const footerBox = footer.getBoundingClientRect();
        return {
          column: { left: column.left, right: column.right },
          footerLeft: footerBox.left, footerRight: footerBox.right,
          name: box(document.querySelector('.bot-brand-name').getBoundingClientRect()),
          version: box(document.querySelector('.bot-version-subtitle').getBoundingClientRect()),
          upgrade: box(upgrade),
          plus: box(document.querySelector('.bot-new').getBoundingClientRect()),
          value: value?.textContent ?? '',
          valueCenter: valueBox ? valueBox.left + valueBox.width / 2 : null,
          upgradeCenter: upgrade ? upgrade.left + upgrade.width / 2 : null,
          viewport: innerHeight,
          scrollWidth: top.scrollWidth,
          clientWidth: top.clientWidth,
        };
      };
      const normal = measure();
      const version = document.querySelector('.bot-version-subtitle .sidebar-version-text');
      const original = version.textContent;
      try {
        // Also measure a long candidate label independently of the current package.
        // Restore the text before capture and do not alter updater status or actions.
        version.textContent = 'v0.1.0-rc.999';
        return [normal, { ...measure(), longVersionLabel: true }];
      } finally {
        version.textContent = original;
      }
    });
    for (const layout of layouts) {
      (report.updaterLayouts ??= []).push(layout);
      const boxes = [layout.name, layout.version, layout.upgrade, layout.plus];
      assert.equal(layout.scrollWidth <= layout.clientWidth + 1 && boxes.every(item =>
        item && item.width > 0 && item.left >= layout.column.left - 1 && item.right <= layout.column.right + 1
        && item.top >= 0 && item.bottom <= layout.viewport), true, 'brand, version and header controls stay inside the column');
      assert.ok(Math.abs(layout.footerLeft - layout.column.left) <= 1 && Math.abs(layout.footerRight - layout.column.right) <= 1,
        'footer divider must span the column without inset gaps');
      assert.ok(layout.upgrade.height >= 24 && layout.plus.height >= 24, 'upgrade and new stay large enough to hit');
      assert.ok(layout.version.top >= layout.name.bottom - 2 && Math.abs(layout.version.left - layout.name.left) <= 2,
        'version subtitle stays under the Peer name');
      assert.ok(layout.upgrade.right <= layout.plus.left + 1 && layout.plus.left - layout.upgrade.right <= 16
        && Math.abs((layout.upgrade.top + layout.upgrade.height / 2) - (layout.plus.top + layout.plus.height / 2)) <= 2,
        'upgrade control stays immediately left of new');
      assert.ok(layout.version.right <= layout.upgrade.left + 1, 'version subtitle does not overlap the upgrade control');
      if (layout.valueCenter != null) {
        assert.ok(Math.abs(layout.valueCenter - layout.upgradeCenter) <= 2, 'progress number stays centered in the ring');
      }
    }
  };
  for (const locale of ['zh-CN', 'en-US']) {
    await page.evaluate(locale => window.peerAgent.setLocale(locale), locale);
    await page.reload(); await badge.waitFor();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const width of [240, 292, 360]) {
        await page.locator('.bot-column-resizer').focus();
        if (width === 292) await page.locator('.bot-column-resizer').dblclick();
        else await page.locator('.bot-column-resizer').press(width === 240 ? 'Home' : 'End');
        await emitUpdaterEvent({ type: 'update-available', version: '0.1.0-rc.99' });
        await header.locator('.bot-upgrade svg').waitFor(); await fit();
        if (captureDirectory && locale === 'zh-CN' && theme === 'dark' && width === 240) {
          await header.screenshot({ path: path.join(captureDirectory, 'bot-header-available-dark-narrow.png') });
        }
        await emitUpdaterEvent({ type: 'download-progress', percent: 42 });
        await until(() => header.locator('.bot-upgrade-value').textContent(), text => text === '42'); await fit();
        if (captureDirectory && locale === 'zh-CN' && theme === 'dark' && width === 240) {
          await header.screenshot({ path: path.join(captureDirectory, 'bot-header-progress-dark-narrow.png') });
        }
        await emitUpdaterEvent({ type: 'update-downloaded', version: '0.1.0-rc.99' });
        await header.locator('.bot-upgrade.is-install').waitFor(); await fit();
        if (captureDirectory && locale === 'zh-CN' && theme === 'dark' && width === 240) {
          await header.screenshot({ path: path.join(captureDirectory, 'bot-header-install-dark-narrow.png') });
        }
      }
    }
  }
  checks.push('available icon, centered 42 progress and install control fit 240–360px columns in both locales and themes, including a temporarily measured long candidate label');
  await page.evaluate(() => window.peerAgent.setLocale('zh-CN'));
  await page.reload(); await badge.waitFor();
  await page.locator('.bot-column-resizer').dblclick();
  assert.equal((await page.evaluate(() => window.peerAgent.updaterGetStatus())).preference, 'auto');
  if (captureDirectory) {
    await page.screenshot({ path: path.join(captureDirectory, 'bot-updater-footer.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await footer.screenshot({ path: path.join(captureDirectory, 'bot-footer-idle-dark.png') });
  }
  checks.push('reload restores production update state and persisted channel without duplicate badges');
  await checkUpdaterMinimize({ page, app, emitUpdaterEvent, report, captureDirectory,
    injectFrameGap: process.argv.includes('--updater-frame-gap') });
}
