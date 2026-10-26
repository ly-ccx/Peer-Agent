import assert from 'node:assert/strict';
import path from 'node:path';
import { chooseModelInPanel } from './bot-model-switch-checks.mjs';
import { checkEffortStability } from './bot-effort-stability-checks.mjs';

/** Production controls in the disposable host; never sends a model request. */
export async function checkSurfaceMotion({ page, fixture, until, report, captureDirectory, failNext }) {
  const workspaceId = fixture.bots[0].workspaceId;
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.locator(`#bot-row-${workspaceId}`).click();
  const composer = page.locator('.bot-composer textarea');
  await composer.fill('SURFACE_MOTION_DRAFT');
  const menu = page.locator('.bot-app-menu-button');
  await menu.click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const sections = ['通用', '外观', '个性化', '快捷键', '服务商', '模型分工', '使用统计', 'Git', '开发者', '远程访问', '更新与关于', '已归档会话'];
  for (const name of sections) {
    await page.locator('.settings-nav').getByRole('button', { name, exact: true }).click();
    await page.locator('.settings-content').waitFor();
    assert.equal(await page.locator('.app-error-boundary').count(), 0);
  }
  await page.screenshot({ path: path.join(captureDirectory, 'surface-settings-wide.png') });
  await page.locator('.settings-nav-header').getByRole('button').click();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), 'SURFACE_MOTION_DRAFT');
  await menu.click(); await page.getByRole('menu').waitFor(); await page.keyboard.press('Escape');
  await until(() => page.getByRole('menu').count(), count => count === 0);
  assert.equal(await menu.evaluate(node => document.activeElement === node), true);
  // A closed surface must not remove its replacement when its old exit finishes.
  await menu.click(); await menu.click(); await menu.click();
  await until(() => page.locator('.bot-app-menu-menu[data-surface-state="open"]').count(), count => count === 1);
  await composer.click();
  await until(() => page.getByRole('menu').count(), count => count === 0);
  await page.getByRole('button', { name: '机器人设置', exact: true }).click();
  for (const name of ['概况', '任务', '目标', '记忆', '设置']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await page.locator('.bot-drawer-pane').waitFor();
  }
  const details = page.locator('.bot-model-advanced');
  await details.locator('summary').click();
  await until(() => details.getAttribute('open'), value => value !== null);
  await details.locator('summary').click();
  await until(() => details.getAttribute('open'), value => value === null);
  const models = await page.evaluate(async workspaceId => (await window.peerAgent.projectAgentGet({ workspaceId })).modelOptions, workspaceId);
  const model = models.find(item => item.label === 'RC Bot model A');
  assert.ok(model);
  const settingsPicker = page.locator('.bot-model-settings-row').first().locator('.model-selection-trigger');
  await chooseModelInPanel({ page, picker: settingsPicker, model });
  const getBot = () => page.evaluate(async workspaceId => (await window.peerAgent.projectAgentGet({ workspaceId })).item.profile, workspaceId);
  await until(getBot, profile => profile.modelPolicy?.overrides?.project_agent?.modelProviderId === model.id);
  await settingsPicker.click();
  await checkEffortStability({ page, slider: page.getByRole('slider'), strength: settingsPicker, until, getBot, failNext,
    report, captureDirectory, highEffort: model.reasoningEffortLevels.at(-1) });
  await page.keyboard.press('Escape');
  const compactPicker = page.locator('.bot-composer .model-selection-trigger');
  await compactPicker.click();
  await checkEffortStability({ page, slider: page.getByRole('slider'), strength: compactPicker, until, getBot, failNext,
    report, captureDirectory, highEffort: model.reasoningEffortLevels.at(-1), scope: 'composer' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.bot-settings-tab').isVisible(), true);
  await page.locator('.model-selection-popover').waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(captureDirectory, 'surface-drawer-effort-wide.png') });
  await page.locator('.bot-drawer-head button').click();
  await until(() => page.locator('.bot-drawer-dock').count(), count => count === 0);
  assert.equal(await composer.inputValue(), 'SURFACE_MOTION_DRAFT');
  await page.setViewportSize({ width: 760, height: 860 });
  await page.getByRole('button', { name: '机器人设置', exact: true }).click();
  await page.locator('.pa-overlay-panel.bot-drawer-panel').waitFor();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.screenshot({ path: path.join(captureDirectory, 'surface-drawer-narrow.png') });
  await page.keyboard.press('Escape');
  await until(() => page.locator('.pa-overlay-panel.bot-drawer-panel').count(), count => count === 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '机器人设置', exact: true }).click();
  const cover = page.locator('.pa-overlay-panel.bot-drawer-panel');
  await cover.waitFor();
  await until(() => cover.evaluate(node => node.getAnimations().some(animation => animation.playState === 'running')), running => !running);
  await page.screenshot({ path: path.join(captureDirectory, 'surface-drawer-reduced.png') });
  await page.locator('.bot-drawer-head button').click();
  await cover.waitFor({ state: 'detached' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await composer.inputValue(), 'SURFACE_MOTION_DRAFT');
  assert.deepEqual(report.pageErrors, []);
  report.surfaceMotion = { settingsSections: sections, drawerTabs: 5, draftRetained: true, menuReversal: true,
    keyboardAndFocus: true, disclosure: true, pushAndCover: true, reducedMotion: true,
    effortSaveAndFailure: true, composerSaveWithDrawerOpen: true, noPageErrors: true };
  report.checks.push('surface motion: settings navigation, menu reversal, draft/focus, drawer tabs and native disclosure, delayed/failing effort with open drawer, cover and reduced motion');
}
