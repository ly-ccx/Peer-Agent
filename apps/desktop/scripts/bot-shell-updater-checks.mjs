import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export async function checkBotShellUpdater({ page, emitUpdaterEvent, until, report, home, captureDirectory }) {
  const checks = report.updater = [];
  const badge = page.locator('.bot-column-footer .sidebar-version-badge');
  await badge.waitFor({ timeout: 5000 });
  const accountMark = page.locator('.bot-column-footer .bot-me-mark');
  assert.equal(await accountMark.locator('svg').count(), 1, 'the account mark must use an SVG icon');
  assert.equal((await accountMark.textContent()).trim(), '', 'the account mark must not repeat the account name as a character icon');
  const footer = page.locator('.bot-column-footer');
  assert.equal(await page.locator('.bot-me-details .sidebar-version-badge').count(), 1);
  const initialFooter = await footer.boundingBox();
  assert.ok(initialFooter.height <= 64, 'idle account and update controls should form a compact footer');
  assert.equal(await badge.locator('.pa-dropdown-trigger').count(), 0, 'update channel belongs in settings only');
  const accountBox = await page.locator('.bot-me-button').boundingBox();
  const versionBox = await badge.boundingBox();
  assert.ok(Math.abs(accountBox.y + accountBox.height / 2 - versionBox.y - versionBox.height / 2) <= 1,
    'account and version must share one row while idle');
  report.updaterFooterHeight = initialFooter.height;
  checks.push('SVG account mark, account menu and update metadata form one compact group without a duplicate character icon');
  await accountMark.click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('menuitem', { name: '设置', exact: true }).waitFor({ state: 'detached' });
  const initial = await page.evaluate(() => window.peerAgent.updaterGetStatus());
  assert.equal(await badge.locator('.sidebar-version-text').textContent(), `v${initial.currentVersion}`);
  assert.equal(await badge.locator('select').count(), 0);
  checks.push('current version aligns with the account in one row; update channel is absent from the footer');

  await badge.locator('.sidebar-version-text-btn').click();
  const dialog = page.getByRole('dialog', { name: '发现新版本', exact: true });
  await dialog.waitFor();
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  checks.push('version button opens the existing update modal and Escape closes it');

  for (const [preference, option] of [
    ['beta', 'Beta（尝鲜版）'], ['stable', '正式（稳定版）'], ['auto', '自动（跟随当前版本）'],
  ]) {
    await page.locator('.bot-me-button').click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '更新与关于', exact: true }).click();
    const settingsChannel = page.getByRole('button', { name: '更新通道', exact: true });
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

  report.updaterPhaseScope = 'Synthetic updater events verify renderer states only; no release download or install is performed';
  const fit = async () => {
    const layouts = await badge.evaluate(node => {
      const measure = () => {
        const column = node.closest('.bot-column').getBoundingClientRect();
        const footer = node.closest('.bot-column-footer');
        const controls = [...footer.querySelectorAll('button')].map(button => {
          const box = button.getBoundingClientRect();
          return { text: button.textContent, width: box.width, height: box.height, left: box.left, right: box.right,
            top: box.top, bottom: box.bottom, transform: getComputedStyle(button).transform };
        });
        const account = footer.querySelector('.bot-me-button').getBoundingClientRect();
        const version = node.getBoundingClientRect();
        return { controls, accountRight: account.right, versionLeft: version.left, versionRight: version.right,
          footerRight: footer.getBoundingClientRect().right, column: { left: column.left, right: column.right }, viewport: innerHeight,
          scrollWidth: footer.scrollWidth, clientWidth: footer.clientWidth };
      };
      const normal = measure();
      const version = node.querySelector('.sidebar-version-text');
      const original = version.textContent;
      try {
        // Source Electron's version is short; also measure a long candidate label.
        // Restore the text before capture and do not alter updater status or actions.
        version.textContent = 'v0.1.0-rc.999';
        return [normal, { ...measure(), longVersionLabel: true }];
      } finally {
        version.textContent = original;
      }
    });
    for (const layout of layouts) {
      (report.updaterLayouts ??= []).push(layout);
      assert.equal(layout.scrollWidth <= layout.clientWidth && layout.controls.every(box =>
        box.width > 0 && box.height >= 24 && box.left >= layout.column.left && box.right <= layout.column.right
        && box.top >= 0 && box.bottom <= layout.viewport), true, 'every footer control must remain visible inside the narrow column');
      assert.ok(layout.versionLeft >= layout.accountRight && layout.versionRight <= layout.footerRight
        && layout.footerRight - layout.versionRight <= 5, 'version group must stay on the right without overlapping the account');
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
        await badge.locator('.sidebar-version-update-icon svg').waitFor(); await fit();
        if (captureDirectory && locale === 'zh-CN' && theme === 'dark' && width === 240) {
          await footer.screenshot({ path: path.join(captureDirectory, 'bot-footer-available-dark-narrow.png') });
        }
        await emitUpdaterEvent({ type: 'download-progress', percent: 42 });
        await until(() => badge.locator('.sidebar-version-progress-text').textContent(), text => text === '42%'); await fit();
        if (captureDirectory && locale === 'zh-CN' && theme === 'dark' && width === 240) {
          await footer.screenshot({ path: path.join(captureDirectory, 'bot-footer-progress-dark-narrow.png') });
        }
        await emitUpdaterEvent({ type: 'update-downloaded', version: '0.1.0-rc.99' });
        await badge.locator('.sidebar-version-install-btn').waitFor(); await fit();
        if (captureDirectory && locale === 'zh-CN' && theme === 'dark' && width === 240) {
          await footer.screenshot({ path: path.join(captureDirectory, 'bot-footer-install-dark-narrow.png') });
        }
      }
    }
  }
  checks.push('available SVG indicator, 42% progress and install control fit 240–360px columns in both locales and themes, including a temporarily measured long candidate label');
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
}
