import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Operates only on the isolated production Electron window supplied by smoke. */
export async function verifyCardMatrix(page, root, conversations) {
  const results = [];
  const rail = page.locator('.task-monitor-rail');
  const toggle = page.locator('.chat-task-monitor-toggle');
  const workbench = page.locator('.workbench-panel--open');
  const setMonitor = async (open) => {
    if ((await toggle.getAttribute('aria-expanded') === 'true') !== open) await toggle.click();
    await rail.waitFor({ state: open ? 'visible' : 'detached' });
  };
  const setWorkbench = async (open) => {
    if ((await workbench.count() > 0) !== open) await page.keyboard.press('Meta+Backslash');
    await page.waitForFunction((expected) => !!document.querySelector('.workbench-panel--open') === expected, open);
  };
  try {
    for (const locale of ['en', 'zh']) {
      await page.evaluate((value) => window.peerAgent.setLocale(value), locale);
      await page.reload();
      await toggle.waitFor();
      for (const conversation of conversations) {
        await setWorkbench(false);
        const row = page.locator(`[data-conversation-id="${conversation.id}"]`);
        await row.waitFor({ state: 'attached' });
        const group = row.locator('xpath=ancestor::div[contains(@class,"sidebar-workspace-node")][1]').locator('.sidebar-workspace-row').first();
        if (await group.getAttribute('aria-expanded') === 'false') await group.click();
        await row.click();
        for (const width of [1440, 1000]) {
          await page.setViewportSize({ width, height: 1000 });
          for (const monitor of [false, true]) {
            for (const panel of [false, true]) {
              const name = `${locale}/${conversation.kind}/${width}/card-${monitor}/workbench-${panel}`;
              await setWorkbench(panel);
              await setMonitor(monitor);
              // Let CSS transitions settle before measuring all child boundaries.
              await page.waitForTimeout(300);
              if (monitor) {
                const summary = rail.locator('.task-monitor-environment-summary');
                if (await summary.getAttribute('aria-expanded') !== 'true') await summary.click();
                const settings = rail.getByRole('button', { name: locale === 'zh' ? '环境设置' : 'Environment settings', exact: true });
                if (conversation.kind !== 'non-git') {
                  await settings.waitFor();
                  if (await settings.getAttribute('aria-expanded') !== 'true') await settings.click();
                  assert.ok(await rail.locator('.pa-dropdown-trigger').count() > 0, name);
                } else assert.equal(await settings.count(), 0, name);
              }
              const geometry = await page.evaluate(() => {
                const box = (element) => {
                  if (!element) return null;
                  const r = element.getBoundingClientRect();
                  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
                };
                const card = document.querySelector('.task-monitor-card');
                return { viewport: innerWidth, card: box(card), rail: box(document.querySelector('.task-monitor-rail')),
                  thread: box(document.querySelector('.chat-surface .chat-thread')),
                  navigation: box(document.querySelector('.chat-surface > .message-rail')),
                  workbench: box(document.querySelector('.workbench-panel--open')),
                  controls: [...(card?.querySelectorAll('.pa-dropdown-trigger, .pa-dropdown-caret, .task-monitor-row-value') ?? [])].map(box),
                  sections: [...(card?.querySelectorAll('section[aria-label]') ?? [])].map((el) => el.getAttribute('aria-label')) };
              });
              assert.ok(geometry.thread && geometry.thread.width >= 300, `${name}: conversation retains at least 300px`);
              if (monitor) {
                assert.ok(geometry.thread.right <= geometry.card.left + 1 || geometry.thread.top >= geometry.card.bottom - 1,
                  `${name}: conversation and card do not overlap`);
                assert.ok(geometry.card.width >= 210, `${name}: card usable width`);
                assert.ok(geometry.card.left >= 0 && geometry.card.right <= width + 1, `${name}: card within viewport`);
                for (const control of geometry.controls) assert.ok(control.left >= geometry.card.left - 1 && control.right <= geometry.card.right + 1,
                  `${name}: child control actually fits, not hidden by clipping`);
                if (geometry.navigation) assert.ok(geometry.navigation.right <= geometry.card.left + 1
                  || geometry.navigation.bottom <= geometry.card.top || geometry.navigation.top >= geometry.card.bottom, `${name}: navigation overlaps card`);
                if (panel) assert.ok(geometry.card.right <= geometry.workbench.left + 1 || geometry.card.bottom <= geometry.workbench.top,
                  `${name}: card overlaps Workbench`);
                assert.deepEqual(geometry.sections.slice(0, 2), locale === 'zh' ? ['产出', '来源与工具'] : ['Outputs', 'Sources & tools']);
              }
              await page.screenshot({ path: path.join(root, `matrix-${name.replaceAll('/', '-')}.png`) });
              results.push({ name, passed: true, geometry });
              console.log('MATRIX_PASS', name);
            }
          }
        }
      }
    }
    assert.equal(results.length, 48);
    return results;
  } finally {
    await writeFile(path.join(root, 'matrix.json'), JSON.stringify(results, null, 2));
  }
}
