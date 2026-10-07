import assert from 'node:assert/strict';
import path from 'node:path';

/** Production Quick Chat and profile IPC; native popup delivery is controlled in the isolated app. */
export async function checkQuickChatBots({ app, quick, fixture, until, report, captureDirectory, failNext }) {
  const getBot = workspaceId => quick.evaluate(async id => (await window.peerAgent.projectAgentGet({ workspaceId: id })).item.profile, workspaceId);
  const bot = quick.getByRole('button', { name: '选择机器人', exact: true });
  const model = quick.getByRole('button', { name: '选择机器人模型', exact: true });
  const strength = quick.getByRole('button', { name: '思考强度', exact: true });
  // Keep the real Menu construction and selection callbacks, avoiding OS focus in deterministic tests.
  await app.evaluate(({ Menu }) => {
    globalThis.rcQuickOriginalPopup = Menu.prototype.popup;
    Menu.prototype.popup = function (options) { globalThis.rcQuickMenu = this; globalThis.rcQuickMenuOptions = options; };
  });
  const selectNative = async (trigger, label) => {
    await app.evaluate(() => { delete globalThis.rcQuickMenu; });
    await trigger.focus(); await trigger.press('Enter');
    await until(() => app.evaluate(() => Boolean(globalThis.rcQuickMenu)), Boolean);
    await app.evaluate((_electron, label) => {
      const item = globalThis.rcQuickMenu.items.find(item => item.label === label);
      if (!item) throw Error('Quick Chat native choice missing: ' + label);
      item.click(); globalThis.rcQuickMenuOptions.callback();
    }, label);
  };
  const selectBot = async index => {
    await selectNative(bot, `project-${String(index).padStart(3, '0')}`);
    await until(() => quick.locator('textarea').getAttribute('placeholder'), text => text === `给 project-${String(index).padStart(3, '0')} 发消息`);
    await until(() => model.isEnabled(), Boolean);
  };
  const selectModel = async label => {
    await model.click();
    const pop = await until(() => app.windows().find(page => new URL(page.url()).searchParams.get('window') === 'quick-chat-popover'), Boolean);
    await pop.getByRole('button', { name: label, exact: true }).click();
    await until(() => model.isEnabled(), Boolean);
  };
  try {
    await selectBot(0);
    assert.equal(await quick.locator('.quick-chat-mode, .quick-chat-access, .quick-chat-bot-picker, .quick-chat-workspace-dot').count(), 0);
    assert.equal(await quick.locator('.quick-chat-selectors button').count(), 3, 'Bot, model and effort are the only controls');
    await selectModel('RC Bot model B');
    await until(() => model.textContent(), value => value === 'RC Bot model B');
    const options = await quick.evaluate(async id => (await window.peerAgent.projectAgentGet({ workspaceId: id })).modelOptions, fixture.bots[0].workspaceId);
    const second = options.find(item => item.label === 'RC Bot model B');
    const highest = second.reasoningEffortLevels.at(-1);
    const effortLabel = highest === 'max' ? '最大强度思考' : highest === 'xhigh' ? '超高强度思考' : '深度思考';
    await selectNative(strength, effortLabel);
    await until(() => strength.isEnabled(), Boolean);
    await until(() => getBot(fixture.bots[0].workspaceId), profile => profile.modelPolicy?.overrides?.project_agent?.reasoningEffort === highest);
    const saved = await getBot(fixture.bots[0].workspaceId);
    assert.equal(saved.modelPolicy.overrides.project_agent.modelProviderId, second.id);
    if (failNext) {
      failNext(); await selectModel('RC Bot model A');
      await quick.getByRole('alert').getByText('模型设置未保存，请重试。', { exact: true }).waitFor();
      assert.equal(await model.textContent(), 'RC Bot model B');
      assert.deepEqual(await getBot(fixture.bots[0].workspaceId), saved);
    }
    await selectBot(1);
    assert.equal(await model.textContent(), 'RC Bot model A', 'another Bot retains its own model');
    await selectBot(0);
    assert.equal(await model.textContent(), 'RC Bot model B');
    assert.equal((await strength.textContent()).trim(), effortLabel);
    const theme = await quick.evaluate(() => document.documentElement.dataset.theme);
    await quick.locator('textarea').focus();
    await quick.mouse.move(700, 2);
    for (const appearance of ['dark', 'light']) {
      await quick.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
      await until(() => quick.locator('.quick-chat-selectors button').evaluateAll(buttons =>
        buttons.every(button => getComputedStyle(button).backgroundColor === 'rgba(0, 0, 0, 0)')), Boolean);
      const layout = await quick.locator('.quick-chat-selectors').evaluate(node => {
        const parent = node.getBoundingClientRect();
        const controls = [...node.querySelectorAll('button')].map(button => {
          const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
          return { y: rect.y, height: rect.height, fits: rect.left >= parent.left - 1 && rect.right <= parent.right + 1, background: style.backgroundColor };
        });
        return { controls, aligned: controls.every(item => Math.abs(item.y - controls[0].y) < 1 && item.height === controls[0].height) };
      });
      assert.equal(layout.aligned, true);
      assert.ok(layout.controls.every(item => item.fits && item.background === 'rgba(0, 0, 0, 0)'), JSON.stringify(layout));
      await quick.screenshot({ path: path.join(captureDirectory, `quick-chat-bots-${appearance}.png`), animations: 'disabled' });
    }
    await quick.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    report.quickChatBots = { compactControls: true, persistedModel: true, persistedEffort: true, perBot: true,
      failedSaveRetained: Boolean(failNext), keyboardTrigger: true, aligned: true,
      scope: 'Actual window and durable Bot profile IPC; native popup callbacks controlled, scripted model only' };
  } finally {
    await app.evaluate(({ Menu }) => { Menu.prototype.popup = globalThis.rcQuickOriginalPopup; delete globalThis.rcQuickMenu; delete globalThis.rcQuickMenuOptions; });
  }
}
