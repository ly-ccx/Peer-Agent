import assert from 'node:assert/strict';
import path from 'node:path';
import { BOT_DETAIL_SURFACE, BOT_DETAIL_CLOSE } from './bot-detail-surface-selectors.mjs';

export async function openWorkPanel(page) {
  // A closing resource pane changes the work panel's wide/compact preference.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => !document.querySelector('.bot-resource-layout')?.getAnimations({ subtree: true }).some(a =>
    a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime)), null, { timeout: 5000 });
  const toggle = page.locator('.bot-work-panel-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('.bot-work-panel[aria-hidden=false]').waitFor({ timeout: 5000 }).catch(async error => {
    const state = await page.locator('.bot-work-layout').evaluate(node => { const panel=node.querySelector('.bot-work-panel'), style=getComputedStyle(panel); return { layout: {...node.dataset}, panel: panel.outerHTML.slice(0,450), trigger: document.querySelector('.bot-work-panel-toggle')?.outerHTML.slice(0,400), visibility: style.visibility, display: style.display, width: panel.getBoundingClientRect().width, parent: node.parentElement.className }; });
    throw new Error(error.message + JSON.stringify(state));
  });
}

/** Opening, closing and responsive reflow retain the actual composer node and draft. */
export async function checkWorkPanelLayout({ page, report, captureDirectory }) {
  const viewport = page.viewportSize(), theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const input = page.locator('.bot-composer textarea'), original = await input.inputValue();
  const handle = await input.elementHandle();
  const toggle = page.locator('.bot-work-panel-toggle');
  const cases = report.workPanelLayout = [];
  await input.fill('面板开合和窗口变化应保留这份草稿。');
  try {
    for (const width of [1600, 1280, 760]) {
      await page.setViewportSize({ width, height: 860 });
      for (const appearance of ['dark', 'light']) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
        for (const expanded of [false, true]) {
          if ((await toggle.getAttribute('aria-expanded') === 'true') !== expanded) await toggle.click();
          await page.waitForFunction(open => document.querySelector('.bot-work-panel').getAttribute('aria-hidden') === String(!open), expanded);
          await page.waitForFunction(() => document.querySelector('.bot-work-layout').getAnimations({ subtree: true }).every(a =>
            a.playState !== 'running' || !Number.isFinite(a.effect?.getComputedTiming().endTime)), null, { timeout: 5000 });
          const bounds = await page.locator('.bot-work-layout').evaluate((node, expanded) => {
            const panel = node.querySelector('.bot-work-panel'), primary = node.querySelector('.bot-work-primary');
            const composer = node.querySelector('.bot-composer').getBoundingClientRect(), region = primary.getBoundingClientRect();
            const rect = panel.getBoundingClientRect();
            return { aligned: composer.left >= region.left && composer.right <= region.right + 1,
              contentFits: primary.scrollWidth <= primary.clientWidth + 1,
              panelFits: !expanded || rect.left >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1
                && panel.scrollWidth <= panel.clientWidth + 1,
              inert: panel.inert, wide: node.dataset.workPanelWide === 'true' };
          }, expanded);
          const continuity = await input.evaluate((node, previous) => node === previous, handle)
            && await input.inputValue() === '面板开合和窗口变化应保留这份草稿。';
          assert.ok(bounds.aligned && bounds.contentFits && bounds.panelFits && continuity, JSON.stringify({ width, appearance, expanded, ...bounds }));
          assert.equal(bounds.inert, !expanded);
          cases.push({ width, appearance, expanded, ...bounds, continuity });
          if (expanded && (width === 1600 && appearance === 'dark' || width === 760 && appearance === 'light'))
            await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `work-panel-${width}-${appearance}.png`) });
        }
      }
    }
    await page.locator('.bot-work-panel-head button').focus(); await page.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
  } finally {
    await input.fill(original); await handle.dispose();
    await page.setViewportSize(viewport); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  }
  report.workSurfaces.push('work panel fits 1600/1280/760px in both themes; opening, closing and reflow preserve the composer node and draft');
}

/** Independent task rows navigate by session identity instead of impersonating a task group. */
export async function checkParallelPanelTasks({ page, until, report, captureDirectory, change, initial }) {
  const panel = page.locator('.bot-work-panel'), rows = panel.locator('.bot-work-panel-session.is-task');
  const parallel = { ...initial.sessions[0], sessionId: 'rc-independent-work', title: '三处界面改动一起提交到当前分支',
    origin: { ...initial.sessions[0].origin, anchorMessageId: 'rc-message-9498' } };
  const viewport = page.viewportSize(), theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const cases = [];
  try {
    change([initial.sessions[0], parallel]);
    await until(() => rows.count(), count => count === 2);
    for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
      await page.setViewportSize({ width, height: 860 });
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
      await openWorkPanel(page);
      const ids = await rows.evaluateAll(nodes => nodes.map(node => node.dataset.sessionId));
      assert.equal(new Set(ids).size, 2);
      const bounds = await rows.evaluateAll(nodes => nodes.map(node => ({ left: node.getBoundingClientRect().left,
        right: node.getBoundingClientRect().right, parent: node.parentElement.className })));
      assert.ok(Math.abs(bounds[0].left - bounds[1].left) <= 1 && bounds[0].parent === bounds[1].parent);
      assert.ok(bounds.every(row => row.left >= 0 && row.right <= width + 1));
      await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `parallel-work-${width}-${appearance}.png`) });
      for (const session of [initial.sessions[0], parallel]) {
        await rows.filter({ has: page.getByText(session.title, { exact: true }) }).click();
        await page.locator(BOT_DETAIL_SURFACE).locator('.bot-task-detail').waitFor();
        assert.match(await page.locator('.bot-task-detail').innerText(), new RegExp(session.title));
        await page.locator(BOT_DETAIL_CLOSE).click(); await openWorkPanel(page);
      }
      cases.push({ width, appearance, sameLevel: true, uniqueRows: true, independentNavigation: true });
    }
    report.parallelWork = { neutralGroup: true, cases };
  } finally {
    if (await page.locator(BOT_DETAIL_CLOSE).count()) await page.locator(BOT_DETAIL_CLOSE).click();
    await page.setViewportSize(viewport); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    change(initial.sessions); await until(() => rows.count(), count => count === 1);
  }
}
