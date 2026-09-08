import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Opt-in real CSS cascade check; uses an isolated browser, never the user's profile.
// PEER_PLAYWRIGHT_MODULE may point at an existing playwright-core ESM entry.
const modulePath = process.env.PEER_PLAYWRIGHT_MODULE;
test('browser visibility matrix and retained page identity', { skip: !modulePath }, async (t) => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const css = readFileSync(new URL('../styles/workbench.css', import.meta.url), 'utf8');
    await page.setContent(`<style>${css}</style><div class="workbench-view workbench-view--browser" data-active="true"><div class="browser-stage"><webview class="browser-webview" data-active="true"></webview></div></div>`);
    await page.evaluate(() => { window.retainedPage = document.querySelector('webview'); });
    // Current/background conversation × each panel × selected/unselected tab.
    for (const current of [true, false]) {
      for (const panel of ['browser', 'plan', 'files', 'documents']) {
        for (const selected of [true, false]) {
          await t.test(`${current ? 'current' : 'background'} / ${panel} / ${selected ? 'selected' : 'unselected'}`, async () => {
            const actual = await page.evaluate(({ current, panel, selected }) => {
              const host = document.querySelector('.workbench-view');
              host.classList.toggle('workbench-view--prepared-browser', !current);
              host.dataset.active = String(current && panel === 'browser');
              const guest = document.querySelector('webview');
              guest.dataset.active = String(selected);
              return {
                visibility: getComputedStyle(guest).visibility,
                pointerEvents: getComputedStyle(guest).pointerEvents,
                display: getComputedStyle(host).display,
                retained: guest === window.retainedPage,
              };
            }, { current, panel, selected });
            const visible = current && panel === 'browser' && selected;
            assert.equal(actual.visibility, visible ? 'visible' : 'hidden');
            assert.equal(actual.pointerEvents, visible ? 'auto' : 'none');
            assert.notEqual(actual.display, 'none', 'keep the guest laid out');
            assert.equal(actual.retained, true, 'do not replace the page');
          });
        }
      }
    }
    await page.evaluate(() => {
      const host = document.querySelector('.workbench-view');
      host.classList.remove('workbench-view--prepared-browser');
      host.dataset.active = 'true';
      window.retainedPage.dataset.active = 'true';
    });
    assert.equal(await page.locator('webview').evaluate(el => getComputedStyle(el).visibility), 'visible');
  } finally {
    await browser.close();
  }
});
