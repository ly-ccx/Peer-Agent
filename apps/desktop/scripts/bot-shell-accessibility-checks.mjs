import assert from 'node:assert/strict';
import path from 'node:path';

/** Actual production DOM, keyboard and persistence; no replacement of product results. */
export async function checkBotShellAccessibility({ page, app, until, report, captureDirectory }) {
  const checks = report.accessibility = [];
  const focused = locator => locator.evaluate(node => node === document.activeElement);
  const list = page.getByRole('listbox', { name: 'Peer', exact: true });
  await list.focus(); assert.equal(await focused(list), true);
  const rowIds = await page.locator('.bot-row').evaluateAll(rows => rows.map(row => row.id));
  await list.press('End'); assert.equal(await list.getAttribute('aria-activedescendant'), rowIds.at(-1));
  await list.press('Home'); assert.equal(await list.getAttribute('aria-activedescendant'), rowIds[0]);
  await list.press('ArrowDown'); assert.equal(await list.getAttribute('aria-activedescendant'), rowIds[1]);
  await list.press('ArrowUp'); await list.press('Enter');
  await page.locator('.bot-composer textarea').waitFor();
  checks.push('focusable list: Home/End, arrows, Enter open the selected bot');
  await list.focus(); await list.press('End'); await list.press('Space');
  await page.locator('.bot-composer textarea').waitFor();
  assert.equal(await page.locator('.bot-row.is-open').getAttribute('id'), rowIds.at(-1));
  await list.focus(); await list.press('Home'); await list.press('Enter');
  checks.push('Space opens the selected bot without scrolling the page');
  const trigger = page.locator('.bot-profile'); await trigger.focus(); await trigger.press('Enter');
  const tabs = page.locator('.bot-drawer-tabs');
  await until(() => focused(tabs.getByRole('tab', { selected: true })), Boolean);
  await page.keyboard.press('End');
  assert.equal(await tabs.getByRole('tab', { name: '设置', exact: true }).getAttribute('aria-selected'), 'true');
  await checkSettings({ page, until, report, captureDirectory });
  await tabs.getByRole('tab', { name: '设置', exact: true }).focus();
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  assert.equal(await tabs.getByRole('tab', { name: '任务', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.bot-drawer-dock.is-open').count(), 1, 'tab Enter must not be intercepted by the shell');
  await page.keyboard.press('Escape');
  await until(() => focused(trigger), Boolean);
  assert.equal(await page.locator('.bot-drawer-dock:not([inert])').count(), 0);
  checks.push('docked drawer enters selected tab, roves with arrows/endpoints, closes with focus returned; hidden dock is inert');

  await page.setViewportSize({ width: 900, height: 780 });
  await trigger.focus(); await trigger.press('Enter');
  const modal = page.getByRole('dialog', { name: '档案', exact: true });
  await modal.waitFor();
  await modal.getByRole('tab', { name: '设置', exact: true }).click();
  const narrow = modal.locator('.bot-settings-tab');
  await narrow.waitFor();
  assert.equal(await narrow.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'settings must fit the cover drawer');
  await narrow.locator('.bot-runtime-settings summary').press('Enter');
  await narrow.locator('.bot-runtime-settings').getByRole('button', { name: '在桌面接管', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await tabsVisible(page), true);
  if (captureDirectory) await page.screenshot({ path: path.join(captureDirectory, 'settings-narrow.png') });
  const ends = () => modal.evaluate(node => {
    const items = [...node.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')]
      .filter(item => item.tabIndex >= 0 && !item.disabled && item.getClientRects().length && !item.closest('[inert]'));
    return { first: items[0]?.outerHTML, last: items.at(-1)?.outerHTML, active: document.activeElement?.outerHTML };
  });
  await modal.evaluate(node => {
    const items = [...node.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')].filter(item => item.tabIndex >= 0 && !item.disabled && item.getClientRects().length);
    items.at(-1).focus();
  });
  await page.keyboard.press('Tab'); let edge = await ends(); assert.equal(edge.active, edge.first);
  await page.keyboard.press('Shift+Tab'); edge = await ends(); assert.equal(edge.active, edge.last);
  await page.keyboard.press('Escape'); await modal.waitFor({ state: 'detached' });
  await until(() => focused(trigger), Boolean);
  await page.setViewportSize({ width: 1360, height: 900 });
  checks.push('900px emulated viewport modal drawer constrains Tab in both directions, Escape returns focus');

  const composer = page.locator('.bot-composer textarea');
  await composer.fill('界'.repeat(100001));
  assert.equal(await page.locator('.bot-composer button[type="submit"]').isDisabled(), true);
  await composer.press('Enter'); assert.equal((await composer.inputValue()).length, 100001);
  await page.getByRole('alert').filter({ hasText: '100000' }).waitFor(); await composer.fill('');
  checks.push('oversize input is rejected before submission and the editable draft is retained');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await until(() => page.locator('[data-avatar-animated="true"]').count(), count => count === 0);
  const moving = await page.evaluate(() => document.getAnimations().filter(animation => {
    const node = animation.effect?.target;
    return node instanceof Element && node.closest('.bot-shell,.pa-overlay-panel');
  }).length);
  assert.equal(moving, 0);
  await trigger.click(); await page.getByRole('tab', { name: '记忆', exact: true }).click();
  assert.equal(await page.locator('.bot-drawer-pane').evaluate(node => getComputedStyle(node).animationName), 'none');
  const memoryRows = page.locator('.bot-memory-list > li');
  await until(() => memoryRows.count(), count => count === 50);
  const firstMemory = await memoryRows.first().locator('p').first().textContent();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await memoryRows.count(), 50);
  assert.notEqual(await memoryRows.first().locator('p').first().textContent(), firstMemory);
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  assert.equal(await memoryRows.first().locator('p').first().textContent(), firstMemory);
  checks.push('10000 memory records render 50 at a time; next and previous retain distinct identities');
  report.reducedDrawerState = await page.locator('.bot-drawer-dock').evaluate(node => ({ attrs: [...node.attributes].map(a => [a.name,a.value]), active: document.activeElement?.className, focused: document.hasFocus(), buttons: [...node.querySelectorAll('button')].slice(0,8).map(item => ({text:item.textContent,disabled:item.disabled,inert:!!item.closest('[inert]'),hidden:!!item.closest('[aria-hidden=\"true\"]')})) }));
  report.reducedDrawerState.roleButtonCount = await page.getByRole('button').count();
  report.reducedDrawerState.closeSnapshot = await page.locator('.bot-drawer-head button').ariaSnapshot();
  report.reducedDrawerState.closeMatches = await page.getByRole('button', { name: '关闭', exact: true }).count();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  checks.push('reduced motion stops avatar/enter displacement animations while drawer remains usable');

  report.contrast = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => { ctx.clearRect(0,0,1,1); ctx.fillStyle = value; ctx.fillRect(0,0,1,1); return [...ctx.getImageData(0,0,1,1).data]; };
    const blend = (front, back) => front.slice(0,3).map((x,i) => x * front[3]/255 + back[i]*(1-front[3]/255));
    const background = node => {
      if (!node) return [255,255,255];
      const color = rgba(getComputedStyle(node).backgroundColor);
      return blend(color, color[3] === 255 ? [0,0,0] : background(node.parentElement));
    };
    const lum = rgb => rgb.map(x => x/255).map(x => x<=0.04045 ? x/12.92 : ((x+0.055)/1.055)**2.4).reduce((n,x,i)=>n+x*[0.2126,0.7152,0.0722][i],0);
    const root = document.documentElement, original = { theme: root.dataset.theme, palette: root.dataset.palette };
    const samples = [];
    for (const palette of ['frost','catppuccin']) for (const theme of ['light','dark']) {
      root.dataset.theme = theme; root.dataset.palette = palette;
      for (const selector of ['.bot-row-name','.bot-row-preview','.bot-row-time']) {
        const node = document.querySelector(selector), bg = background(node), fg = blend(rgba(getComputedStyle(node).color), bg);
        const values = [lum(fg),lum(bg)].sort((a,b)=>b-a);
        samples.push({ palette, theme, selector, ratio: (values[0]+0.05)/(values[1]+0.05) });
      }
    }
    for (const key of ['theme','palette']) if (original[key] === undefined) delete root.dataset[key]; else root.dataset[key] = original[key];
    return samples;
  });
  assert.ok(report.contrast.every(sample => sample.ratio >= 4.5), 'small readable list text contrast must reach 4.5:1');
  checks.push('actual list name/preview/time contrast reaches 4.5:1 in both light/dark and Frost/Catppuccin');

  await page.locator('.bot-me-button').click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const quiet = page.getByRole('switch', { name: '安静时段', exact: true }); await quiet.waitFor();
  const previous = await quiet.getAttribute('aria-checked'); await quiet.focus(); await quiet.press('Space');
  await until(() => quiet.getAttribute('aria-checked'), value => value !== previous);
  const choose = async (label, name) => { await page.getByRole('button', { name: label, exact: true }).click(); await page.getByRole('option', { name, exact: true }).click(); };
  await choose('免打扰开始时间：小时', '23'); await choose('免打扰开始时间：分钟', '15');
  const settings = await page.evaluate(() => window.peerAgent.getSettings());
  assert.equal(settings.projectAgent.quietHours.start, '23:15');
  assert.equal(settings.projectAgent.quietHours.enabled, previous !== 'true');
  assert.equal(await page.locator('.general-bots-hours input').count(), 0);
  checks.push('custom quiet switch and HH:mm field use keyboard, save canonical values and expose independent labels');
  await choose('语言', 'English'); await page.getByRole('button', { name: 'Interface', exact: true }).waitFor();
  await page.locator('.settings-nav').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.bot-shell').waitFor();
  await trigger.click(); await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const quick = app.windows().find(window => new URL(window.url()).searchParams.get('window') === 'quick-chat');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => new URL(window.webContents.getURL()).searchParams.get('window') === 'quick-chat');
    window.show(); window.webContents.send('quick-chat:shown');
  });
  await quick.getByRole('button', { name: 'Choose bot', exact: true }).waitFor();
  await quick.getByLabel('Quick Chat message', { exact: true }).waitFor();
  assert.equal(await quick.locator('select').count(), 0);
  checks.push('English settings/drawer/Quick Chat labels refresh from persisted locale; bot picker is custom');
  await page.bringToFront(); await page.locator('.bot-me-button').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await choose('Language', '简体中文');
  await page.locator('.settings-nav').getByRole('button', { name: '设置', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}

async function checkSettings({ page, until, report, captureDirectory }) {
  const form = page.locator('.bot-settings-tab');
  await form.waitFor();
  const workspaceId = (await page.locator('.bot-row.is-open').getAttribute('id')).slice('bot-row-'.length);
  const profile = () => page.evaluate(async workspaceId => (await window.peerAgent.projectAgentGet({ workspaceId })).item.profile, workspaceId);
  const original = await profile();
  const advanced = form.locator('.bot-model-advanced');
  const runtime = form.locator('.bot-runtime-settings');
  assert.equal(await advanced.getAttribute('open'), null);
  assert.equal(await runtime.getAttribute('open'), null);
  assert.equal(await form.getByRole('button', { name: '项目代理', exact: true }).isVisible(), true);
  assert.equal(await form.getByRole('button', { name: '探索', exact: true }).count(), 0);
  const handoff = form.getByRole('switch', { name: '策略签收后自动合回', exact: true });
  const switchPaint = await handoff.evaluate(node => {
    const track = node.getBoundingClientRect(), thumb = node.querySelector('.peer-switch-thumb').getBoundingClientRect();
    return { track: { width: track.width, height: track.height }, thumb: { width: thumb.width, height: thumb.height },
      trackColor: getComputedStyle(node).backgroundColor, thumbColor: getComputedStyle(node.querySelector('.peer-switch-thumb')).backgroundColor };
  });
  assert.equal(switchPaint.track.width, 36);
  assert.equal(switchPaint.track.height, 20);
  assert.equal(switchPaint.thumb.width, 16);
  assert.notEqual(switchPaint.trackColor, switchPaint.thumbColor, 'switch thumb must be visible');
  await handoff.focus(); await handoff.press('Space');
  await until(profile, p => p.autoHandoffOnPolicyAccept === !(original.autoHandoffOnPolicyAccept === true));
  await handoff.press('Space');
  await until(profile, p => p.autoHandoffOnPolicyAccept === (original.autoHandoffOnPolicyAccept === true));
  await form.getByRole('button', { name: '开工前批准计划', exact: true }).click();
  await page.getByRole('option', { name: '所有任务先批准', exact: true }).click();
  await until(profile, p => p.planApproval === 'always');
  await form.getByRole('button', { name: '签收策略', exact: true }).click();
  await page.getByRole('option', { name: '由我确认结果', exact: true }).click();
  await until(profile, p => p.acceptancePolicy === 'confirm');
  await advanced.locator('summary').focus(); await advanced.locator('summary').press('Enter');
  assert.notEqual(await advanced.getAttribute('open'), null);
  const local = advanced.getByRole('switch', { name: '只使用本地模型', exact: true });
  await local.press('Space'); await until(profile, p => p.modelPolicy?.scope?.localOnly === true);
  await local.press('Space'); await until(profile, p => p.modelPolicy?.scope?.localOnly === false);
  if (captureDirectory) await page.screenshot({ path: path.join(captureDirectory, 'settings-advanced.png') });
  await advanced.locator('summary').press('Enter');
  await runtime.locator('summary').press('Enter');
  await runtime.getByText('影响所有机器人', { exact: true }).waitFor();
  const oldConcurrency = (await page.evaluate(() => window.peerAgent.getSettings())).projectAgent.concurrency || 4;
  const nextConcurrency = oldConcurrency === 5 ? 4 : 5;
  await runtime.getByRole('button', { name: '全局并发回合', exact: true }).click();
  await page.getByRole('option', { name: String(nextConcurrency), exact: true }).click();
  await until(() => page.evaluate(() => window.peerAgent.getSettings()), s => s.projectAgent.concurrency === nextConcurrency);
  await runtime.getByRole('button', { name: '全局并发回合', exact: true }).click();
  await page.getByRole('option', { name: String(oldConcurrency), exact: true }).click();
  await until(() => page.evaluate(() => window.peerAgent.getSettings()), s => s.projectAgent.concurrency === oldConcurrency);
  await runtime.getByRole('button', { name: '在桌面接管', exact: true }).scrollIntoViewIfNeeded();
  const hostPaint = await runtime.locator('.bot-host-action').evaluate(node => {
    const button = node.getBoundingClientRect(), icon = node.querySelector('svg').getBoundingClientRect();
    return { display: getComputedStyle(node).display, centered: Math.abs(icon.y + icon.height / 2 - button.y - button.height / 2) < 2 };
  });
  // Flex items blockify inline-flex in computed style; geometry proves icon/text alignment.
  assert.equal(hostPaint.display, 'flex'); assert.equal(hostPaint.centered, true);
  assert.equal(await tabsVisible(page), true, 'drawer tabs must remain visible after settings scroll');
  if (captureDirectory) await page.screenshot({ path: path.join(captureDirectory, 'settings-runtime.png') });
  await runtime.locator('summary').press('Enter');
  await page.locator('.bot-drawer-body').evaluate(node => { node.scrollTop = 0; });
  if (captureDirectory) await page.screenshot({ path: path.join(captureDirectory, 'settings-default-light.png') });
  const originalTheme = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, palette: document.documentElement.dataset.palette }));
  const themedSwitches = [];
  for (const palette of ['catppuccin', 'frost']) for (const theme of ['light', 'dark']) {
    await page.evaluate(({ theme, palette }) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.palette = palette;
    }, { theme, palette });
    for (const checked of [false, true]) {
      if ((await handoff.getAttribute('aria-checked') === 'true') !== checked) await handoff.press('Space');
      await until(profile, p => (p.autoHandoffOnPolicyAccept === true) === checked);
      await settleColorTransitions(page);
      const paint = await handoff.evaluate(node => {
        const track = getComputedStyle(node).backgroundColor;
        const thumb = getComputedStyle(node.querySelector('.peer-switch-thumb')).backgroundColor;
        const luminance = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(x => x / 255)
          .map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
          .reduce((n, x, i) => n + x * [0.2126, 0.7152, 0.0722][i], 0);
        const values = [luminance(track), luminance(thumb)].sort((a, b) => b - a);
        return { theme: document.documentElement.dataset.theme, palette: document.documentElement.dataset.palette,
          checked: node.getAttribute('aria-checked') === 'true', track, thumb, contrast: (values[0] + 0.05) / (values[1] + 0.05) };
      });
      assert.ok(paint.contrast >= 3, 'switch thumb contrast must reach 3:1 in each theme and state');
      themedSwitches.push(paint);
    }
    await handoff.press('Space');
    await until(profile, p => p.autoHandoffOnPolicyAccept !== true);
  }
  if (original.autoHandoffOnPolicyAccept === true) await handoff.press('Space');
  await until(profile, p => (p.autoHandoffOnPolicyAccept === true) === (original.autoHandoffOnPolicyAccept === true));
  await settleColorTransitions(page);
  if (captureDirectory) await page.screenshot({ path: path.join(captureDirectory, 'settings-default.png') });
  await page.evaluate(original => {
    for (const key of ['theme', 'palette']) if (original[key] === undefined) delete document.documentElement.dataset[key]; else document.documentElement.dataset[key] = original[key];
  }, originalTheme);
  report.settingsLayout = { switchPaint, hostPaint, planApproval: 'always', acceptancePolicy: 'confirm', globalSettingRestored: true,
    themedSwitches,
    scope: 'Actual isolated source UI and persistence, no model or permission grant exercised' };
  report.accessibility.push('settings groups, keyboard disclosures, visible switches, policy/local-model/global-concurrency persistence and sticky tabs');
  await page.evaluate(async ({ workspaceId, original }) => {
    const result = await window.peerAgent.projectAgentUpdateProfile({ workspaceId, planApproval: original.planApproval || 'never', acceptancePolicy: original.acceptancePolicy || 'auto', modelPolicy: original.modelPolicy || {} });
    if (!result.ok) throw Error('Fixture policy restore failed');
  }, { workspaceId, original });
}

async function settleColorTransitions(page) {
  // Theme changes animate button colors. Capture the settled product, not a transition frame.
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().filter(animation => animation instanceof CSSTransition)
      .map(animation => animation.finished.catch(() => {})));
  });
}

async function tabsVisible(page) {
  return page.locator('.bot-drawer-tabs').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
}
