import assert from 'node:assert/strict';
import path from 'node:path';

/** The disposable main entry replaces only the network download response, never downloads a release. */
export async function checkUpdaterMinimize({ page, app, emitUpdaterEvent, report, captureDirectory }) {
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await app.evaluate(({ ipcMain }) => {
    globalThis.rcUpdateDownloadCalls = 0;
    ipcMain.removeHandler('updater:download');
    ipcMain.handle('updater:download', async () => {
      const call = ++globalThis.rcUpdateDownloadCalls;
      await new Promise(resolve => setTimeout(resolve, call === 4 ? 20 : 700));
      return { currentVersion: '0.1.0-rc.9', channel: 'beta', preference: 'auto', enabled: true,
        phase: call === 4 ? 'downloaded' : 'downloading', availableVersion: '0.1.0-rc.99', percent: call === 4 ? 100 : 42 };
    });
  });
  const cases = [];
  try {
    for (const [width, appearance, reduced] of [[1280, 'dark', false], [760, 'light', false], [760, 'light', true]]) {
      await page.setViewportSize({ width, height: 780 });
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
      await emitUpdaterEvent({ type: 'update-available', version: '0.1.0-rc.99' });
      const trigger = page.locator('.bot-column-footer .sidebar-version-text-btn');
      await trigger.click();
      const dialog = page.locator('.updater-modal');
      await dialog.waitFor();
      await page.waitForTimeout(250);
      if (!reduced) await page.screenshot({ path: path.join(captureDirectory, `updater-minimize-${width}-${appearance}-before.png`) });
      const button = dialog.getByRole('button', { name: '更新', exact: true });
      await button.evaluate(node => {
        const panel = node.closest('.updater-modal');
        window.rcUpdateFrames = null;
        node.addEventListener('click', () => {
          const frames = [], started = performance.now();
          const sample = () => {
            const box = panel.isConnected ? panel.getBoundingClientRect() : null;
            const bar = document.querySelector('.bot-column-footer .sidebar-version-progress');
            const target = bar?.getBoundingClientRect();
            frames.push({ time: performance.now() - started, connected: panel.isConnected,
              panel: box && { left: box.left, top: box.top, width: box.width, height: box.height },
              target: target && { left: target.left, top: target.top, width: target.width, height: target.height },
              progress: bar?.getAttribute('aria-valuenow'), animation: panel.isConnected && panel.getAnimations().some(animation => animation.playState === 'running') });
            if (performance.now() - started < 850) requestAnimationFrame(sample);
            else window.rcUpdateFrames = frames;
          };
          sample();
        }, { once: true });
      });
      await button.click();
      const frames = await page.waitForFunction(() => window.rcUpdateFrames).then(handle => handle.jsonValue());
      const active = frames.filter(frame => frame.connected && frame.target);
      const original = frames[0].panel;
      cases.push({ width, appearance, reduced, frames });
      report.updaterMinimize = { cases };
      assert.equal(frames.at(-1).connected, false, 'dialog must close after its exit completes');
      if (!reduced) {
        assert.ok(active.some(frame => frame.time > 30 && frame.panel.width < original.width * 0.9
          && frame.panel.width > frame.target.width + 10), 'dialog must stay mounted while shrinking toward the footer');
        assert.ok(active.some(frame => frame.panel.left + frame.panel.width / 2 < original.left + original.width / 2 - 15
          && frame.panel.top + frame.panel.height / 2 > original.top + original.height / 2 + 15), 'exit must head to the actual bottom-left target');
        assert.ok(active.some(frame => Math.abs(frame.panel.left - frame.target.left) < 20
          && Math.abs(frame.panel.top - frame.target.top) < 20), 'modal must arrive at the measured progress destination');
        assert.ok(active.some(frame => frame.animation));
      } else assert.equal(frames.slice(1).some(frame => frame.animation), false);
      const progress = page.locator('.bot-column-footer [role="progressbar"]');
      assert.equal(await progress.getAttribute('aria-valuenow'), '42');
      const track = await progress.locator('.sidebar-version-progress-track').boundingBox();
      assert.ok(track.width >= 36 && track.height > 0 && track.height <= 4, 'footer must show a horizontal progress bar');
      const ratio = await progress.locator('.sidebar-version-progress-fill').evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).a);
      assert.ok(Math.abs(ratio - 0.42) < 0.01, 'visual fill must match host progress');
      assert.equal(await trigger.evaluate(node => document.activeElement === node), true);
      if (!reduced) await page.screenshot({ path: path.join(captureDirectory, `updater-minimize-${width}-${appearance}-after.png`) });
      cases.at(-1).passed = true;
    }
    // A completion may arrive before the outgoing modal finishes; keep its captured content stable.
    await emitUpdaterEvent({ type: 'update-available', version: '0.1.0-rc.99' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.bot-column-footer .sidebar-version-text-btn').click();
    await page.locator('.updater-modal').getByRole('button', { name: '更新', exact: true }).click();
    await emitUpdaterEvent({ type: 'update-downloaded', version: '0.1.0-rc.99' });
    assert.equal(await page.locator('.updater-modal.is-minimizing .updater-modal-changelog').count(), 1);
    await page.locator('.updater-modal').waitFor({ state: 'detached' });
    await page.locator('.sidebar-version-install-btn').waitFor();
    assert.equal(await app.evaluate(() => globalThis.rcUpdateDownloadCalls), 4, 'each update click dispatches once');
    report.updaterMinimize.fastCompletion = true;
    await emitUpdaterEvent({ type: 'error', message: 'RC synthetic download interrupted' });
    assert.equal(await page.locator('.bot-column-footer [role="progressbar"]').count(), 0);
    await page.locator('.bot-column-footer .sidebar-version-text-btn').click();
    await page.getByText('更新出错：RC synthetic download interrupted', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.updater-modal').waitFor({ state: 'detached' });
    report.updaterMinimize.errorRecoverable = true;
  } finally {
    await page.setViewportSize(viewport);
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
}
