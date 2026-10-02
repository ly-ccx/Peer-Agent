import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export async function checkBotShellUpdater({ page, app, until, report, home, captureDirectory }) {
  const checks = report.updater = [];
  const badge = page.locator('.bot-column-footer .sidebar-version-badge');
  await badge.waitFor({ timeout: 5000 });
  const initial = await page.evaluate(() => window.peerAgent.updaterGetStatus());
  assert.equal(await badge.locator('.sidebar-version-text').textContent(), `v${initial.currentVersion}`);
  assert.equal(await badge.locator('select').count(), 0);
  const channel = badge.locator('.pa-dropdown-trigger');
  assert.equal(await channel.locator('svg').count(), 1);
  await channel.focus(); await channel.press('Enter');
  const menu = page.getByRole('listbox', { name: '更新通道', exact: true });
  await menu.waitFor();
  const rects = await page.evaluate(() => {
    const trigger = document.querySelector('.bot-column-footer .pa-dropdown-trigger').getBoundingClientRect();
    const menu = document.querySelector('.pa-dropdown-menu.sidebar-version-channel').getBoundingClientRect();
    return { trigger: { top: trigger.top }, menu: { top: menu.top, bottom: menu.bottom }, height: innerHeight };
  });
  assert.ok(rects.menu.top >= 0 && rects.menu.bottom <= rects.trigger.top + 1);
  await channel.press('Escape');
  assert.equal(await channel.evaluate(node => node === document.activeElement), true);
  for (const [preference, option, label] of [
    ['beta', 'Beta（尝鲜版）', 'Beta'],
    ['stable', '正式（稳定版）', '正式'],
    ['auto', '自动（跟随当前版本）', '自动'],
  ]) {
    await channel.click(); await page.getByRole('option', { name: option, exact: true }).click();
    await until(() => page.evaluate(() => window.peerAgent.updaterGetStatus()), state => state.preference === preference);
    assert.equal(JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8')).updateChannel, preference);
    await until(() => channel.textContent(), text => text === label);
  }
  checks.push('visible current version; SVG custom channel menu opens upwards, Escape restores focus; all three preferences persist through production IPC');

  await badge.locator('.sidebar-version-text-btn').click();
  const dialog = page.getByRole('dialog', { name: '发现新版本', exact: true });
  await dialog.waitFor();
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  checks.push('version button opens the existing update modal and Escape closes it');

  for (const [option, label] of [['Beta（尝鲜版）', 'Beta'], ['自动（跟随当前版本）', '自动']]) {
    await page.locator('.bot-me-button').click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '更新与关于', exact: true }).click();
    await page.getByRole('button', { name: '更新通道', exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
    await page.locator('.settings-nav').getByRole('button', { name: '设置', exact: true }).click();
    await until(() => channel.textContent(), text => text === label, 3000);
  }
  checks.push('changing the channel in Updates & about refreshes the already mounted footer from confirmed main status');

  const emit = event => app.evaluate(({ BrowserWindow }, event) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('updater:event', event);
  }, event);
  report.updaterPhaseScope = 'Synthetic updater events verify renderer states only; no release download or install is performed';
  const fit = async () => {
    const layout = await badge.evaluate(node => {
      const column = node.closest('.bot-column').getBoundingClientRect();
      const footer = node.closest('.bot-column-footer');
      const controls = [...node.querySelectorAll('button')].map(button => {
        const box = button.getBoundingClientRect();
        return { text: button.textContent, width: box.width, height: box.height, left: box.left, right: box.right,
          top: box.top, bottom: box.bottom, transform: getComputedStyle(button).transform };
      });
      return { controls, column: { left: column.left, right: column.right }, viewport: innerHeight,
        scrollWidth: footer.scrollWidth, clientWidth: footer.clientWidth };
    });
    (report.updaterLayouts ??= []).push(layout);
    assert.equal(layout.scrollWidth <= layout.clientWidth && layout.controls.every(box =>
      box.width > 0 && box.height >= 24 && box.left >= layout.column.left && box.right <= layout.column.right
      && box.top >= 0 && box.bottom <= layout.viewport), true, 'every footer control must remain visible inside the narrow column');
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
        await emit({ type: 'update-available', version: '0.1.0-rc.99' });
        await badge.locator('.sidebar-version-update-icon svg').waitFor(); await fit();
        await emit({ type: 'download-progress', percent: 42 });
        await until(() => badge.locator('.sidebar-version-progress-text').textContent(), text => text === '42%'); await fit();
        await emit({ type: 'update-downloaded', version: '0.1.0-rc.99' });
        await badge.locator('.sidebar-version-install-btn').waitFor(); await fit();
      }
    }
  }
  checks.push('available SVG indicator, 42% progress and install control fit 240–360px columns in both locales and themes');
  await page.evaluate(() => window.peerAgent.setLocale('zh-CN'));
  await page.reload(); await badge.waitFor();
  await page.locator('.bot-column-resizer').dblclick();
  assert.equal((await page.evaluate(() => window.peerAgent.updaterGetStatus())).preference, 'auto');
  if (captureDirectory) await page.screenshot({ path: path.join(captureDirectory, 'bot-updater-footer.png') });
  checks.push('reload restores production update state and persisted channel without duplicate badges');
}
