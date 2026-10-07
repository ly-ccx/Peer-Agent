import assert from 'node:assert/strict';
import path from 'node:path';

/** Real settings renderer/persistence, with disposable models and no provider network. */
export async function checkFallbackVisionLayout({ page, until, report, captureDirectory }) {
  const navigate = async () => page.locator('.settings-nav').getByRole('button', { name: '服务商', exact: true }).click();
  await navigate();
  const row = page.locator('.llm-fallback-vision');
  const toggle = row.locator('.llm-fallback-vision-toggle');
  const selector = row.locator('.pa-cascading-trigger');
  await until(() => row.locator('.llm-fallback-vision-model').textContent(), text => text.includes('RC Bot model A'));
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await selector.count(), 0, 'default view discloses a model summary, not a picker');
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const cases = [];
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 780 });
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
      await row.scrollIntoViewIfNeeded();
      assert.equal(await row.locator('strong').textContent(), '图像识别设置');
      assert.equal(await row.locator('.llm-fallback-vision-help').textContent(), '主模型无法识别图片时使用。');
      const bounds = await toggle.evaluate(node => {
        const copy = node.querySelector('.llm-fallback-vision-copy');
        const select = node.querySelector('.llm-fallback-vision-summary');
        const help = copy.querySelector('.llm-fallback-vision-help');
        const left = copy.getBoundingClientRect(); const right = select.getBoundingClientRect();
        const style = getComputedStyle(help);
        return { centered: Math.abs((left.top + left.bottom - right.top - right.bottom) / 2) < 1,
          fits: node.scrollWidth <= node.clientWidth && left.right <= right.left && right.right <= node.getBoundingClientRect().right,
          helpSize: parseFloat(style.fontSize), labelSize: parseFloat(getComputedStyle(copy.querySelector('strong')).fontSize),
          helpWeight: style.fontWeight, helpColor: style.color, labelColor: getComputedStyle(copy.querySelector('strong')).color };
      });
      assert.ok(bounds.centered && bounds.fits, `fallback row must align and fit: ${JSON.stringify({ width, appearance, ...bounds })}`);
      assert.ok(bounds.helpSize < bounds.labelSize && bounds.helpWeight === '400' && bounds.helpColor !== bounds.labelColor);
      cases.push({ width, appearance, ...bounds });
      await row.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `fallback-vision-${width}-${appearance}.png`) });
    }
  }
  await page.setViewportSize({ width: 1280, height: 780 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('.settings-provider-page').screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'providers-1280-dark.png') });
  // Measure actual intermediate rendered heights in both directions, then keyboard access.
  const motion = async () => {
    await page.evaluate(() => {
      window.rcDisclosureSamples = [];
      window.rcDisclosureDone = false;
      const start = performance.now();
      const sample = () => {
        window.rcDisclosureSamples.push(document.querySelector('.llm-fallback-vision .llm-settings-disclosure').getBoundingClientRect().height);
        if (performance.now() - start < 320) requestAnimationFrame(sample);
        else window.rcDisclosureDone = true;
      };
      requestAnimationFrame(sample);
    });
    await toggle.click();
    await page.waitForFunction(() => window.rcDisclosureDone);
    const values = await page.evaluate(() => window.rcDisclosureSamples);
    const max = Math.max(...values);
    assert.ok(max > 20 && values.some(height => height > 1 && height < max - 1), `intermediate heights required: ${values}`);
    return true;
  };
  const openingAnimated = await motion();
  await selector.waitFor();
  await page.locator('.settings-provider-page').screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'providers-expanded-1280-dark.png') });
  await selector.focus(); await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.getByRole('menuitemradio', { name: 'RC Bot model B', exact: true }).click();
  await until(() => row.locator('.llm-fallback-vision-model').textContent(), text => text.includes('RC Bot model B'));
  await until(() => selector.isEnabled(), Boolean);
  const closingAnimated = await motion();
  await until(() => selector.count(), count => count === 0);
  await page.locator('.settings-nav').getByRole('button', { name: '通用', exact: true }).click();
  await navigate();
  await until(() => row.locator('.llm-fallback-vision-model').textContent(), text => text.includes('RC Bot model B'));
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'saved model remains visible after remount');
  await toggle.focus(); await page.keyboard.press('Enter');
  await selector.click();
  await page.getByRole('menuitem', { name: '不使用', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '不使用备用模型', exact: true }).click();
  await until(() => row.locator('.llm-fallback-vision-model').textContent(), text => text === '不使用备用模型');
  await until(() => selector.isEnabled(), Boolean);
  await selector.click();
  await page.getByRole('menuitem', { name: 'RC synthetic channel', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'RC Bot model A', exact: true }).click();
  await until(() => selector.isEnabled(), Boolean);
  await toggle.click();
  await until(() => selector.count(), count => count === 0);
  const group = page.locator('.llm-provider-group').first();
  await group.locator('.llm-group-toggle').click();
  await group.locator('.llm-group-body').waitFor();
  assert.equal(await group.locator('.llm-configured-model-row').count(), 2);
  await group.locator('.llm-group-toggle').click();
  await group.getByRole('button', { name: '管理 RC synthetic channel', exact: true }).click();
  await page.getByRole('menuitem', { name: '编辑连接', exact: true }).click();
  await page.getByRole('dialog', { name: '编辑连接', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '编辑连接', exact: true }).waitFor({ state: 'hidden' });
  await page.locator('.llm-add-channel-btn').click();
  await page.getByRole('dialog', { name: '添加服务', exact: true }).waitFor();
  await page.locator('.llm-catalog-back-btn').click();
  await page.getByRole('dialog', { name: '添加服务', exact: true }).waitFor({ state: 'hidden' });
  await page.setViewportSize(viewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.locator('.settings-nav').getByRole('button', { name: '通用', exact: true }).click();
  report.fallbackVision = { cases, openingAnimated, closingAnimated, persisted: true, keyboard: true,
    serviceManagement: true, scope: 'Production settings renderer/persistence; disposable models, no provider requests.' };
}
