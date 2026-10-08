import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exercise the real composer without sending or mutating a model policy. */
export async function checkBotComposerLayout({ page, until, report, captureDirectory }) {
  if (await page.locator('.bot-drawer-dock.is-open').count()) {
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await until(() => page.locator('.bot-drawer-dock').count(), count => count === 0);
  }
  const composer = page.locator('.bot-composer');
  const input = composer.locator('textarea');
  const originalText = await input.inputValue();
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const cases = [];
  const measure = () => composer.evaluate(node => {
    const box = el => { const { left, right, top, bottom, width, height } = el.getBoundingClientRect(); return { left, right, top, bottom, width, height }; };
    const rect = box(node), style = getComputedStyle(node), textarea = node.querySelector('textarea');
    const attach = box(node.querySelector('.bot-attach-button'));
    const model = box(node.querySelector('.bot-model-toolbar'));
    const send = box(node.querySelector('button[type="submit"]'));
    const controls = [attach, model, send];
    return { height: rect.height, inputHeight: box(textarea).height,
      fits: node.scrollWidth <= node.clientWidth && controls.every(b => b.left >= rect.left && b.right <= rect.right && b.bottom <= rect.bottom),
      grouped: attach.right < model.left && model.right <= send.left,
      centered: controls.every(b => Math.abs((b.top + b.bottom) / 2 - (send.top + send.bottom) / 2) < 1),
      radius: parseFloat(style.borderRadius), surface: style.backgroundColor,
      distinctSurface: style.backgroundColor !== getComputedStyle(node.closest('.bot-convo')).backgroundColor,
      scrolls: getComputedStyle(textarea).overflowY === 'auto' && textarea.scrollHeight > textarea.clientHeight,
      textInset: box(textarea).left - rect.left,
      bottomInset: rect.bottom - send.bottom,
      toolbarHeight: box(node.querySelector('.bot-composer-bar')).height,
      controlSizes: [...node.querySelectorAll('.bot-composer-bar button')].map(el => ({
        className: el.className, height: box(el).height, padding: getComputedStyle(el).padding,
        sizing: getComputedStyle(el).boxSizing,
      })),
      sendFilled: getComputedStyle(node.querySelector('button[type="submit"]')).backgroundColor !== 'rgba(0, 0, 0, 0)',
    };
  });
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 860 });
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
      await input.fill('');
      await until(measure, layout => layout.fits && layout.grouped && layout.centered);
      const layout = await measure();
      assert.ok(layout.height <= 112 && layout.inputHeight <= 40, `empty composer stays compact: ${JSON.stringify(layout)}`);
      assert.ok(layout.distinctSurface && layout.sendFilled && layout.radius <= 18);
      assert.ok(layout.textInset >= 14 && layout.textInset <= 18 && layout.bottomInset >= 10 && layout.bottomInset <= 12);
      cases.push({ width, appearance, ...layout });
      if (width === 1280 || appearance === 'dark') await composer.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `composer-empty-${width}-${appearance}.png`) });
      await input.fill('把这段说明整理得更清楚一些。');
      assert.equal(await composer.locator('button[type="submit"]').isEnabled(), true);
      const before = (await measure()).height;
      await input.fill(Array.from({ length: 14 }, (_, index) => `第 ${index + 1} 项：检查输入框的间距、模型菜单和附件，保持内容完整可读。`).join('\n'));
      await until(measure, layout => layout.inputHeight === 200 && layout.scrolls);
      assert.ok((await measure()).fits && (await measure()).height > before);
      if (width === 760 && appearance === 'light') await composer.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'composer-multiline-760-light.png') });
    }
  }
  // A width change must reflow an existing draft before the next keystroke.
  await page.setViewportSize({ width: 1280, height: 860 });
  await input.fill('已有草稿在打开侧栏和改变窗口宽度时也应该自动换行并调整高度。'.repeat(4));
  const wideHeight = (await measure()).inputHeight;
  await page.setViewportSize({ width: 760, height: 860 });
  await until(measure, layout => layout.inputHeight > wideHeight);
  await input.fill('');
  assert.equal(await composer.locator('button[type="submit"]').isDisabled(), true);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await composer.locator('input[type="file"]').setInputFiles(fileURLToPath(new URL('../public/logo-dark.png', import.meta.url)));
  await until(() => composer.locator('.bot-attachment.image img').count(), count => count === 1);
  await until(() => composer.locator('button[type="submit"]').isEnabled(), Boolean);
  await input.fill('请看一下这个附件。');
  assert.ok((await measure()).fits);
  await composer.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'composer-attachment-1280-dark.png') });
  await composer.locator('.bot-attachment-remove').click();
  await input.fill('');
  await composer.locator('.bot-attach-button').focus();
  await page.keyboard.press('Tab');
  assert.equal(await composer.locator('.bot-model-picker > button').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.locator('.pa-cascading-menu-panel').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await composer.locator('.bot-model-picker > button').evaluate(node => node === document.activeElement), true);
  await input.fill(originalText);
  await page.setViewportSize(viewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  report.composerLayout = { cases, multilineScroll: true, widthReflow: true, attachmentFits: true, keyboard: true,
    scope: 'Production composer, real draft and attachment admission in an isolated source Electron; no model message or permission change' };
}
