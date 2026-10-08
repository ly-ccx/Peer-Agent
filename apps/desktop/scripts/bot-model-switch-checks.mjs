import assert from 'node:assert/strict';
import { modelMenuChannelName } from '@peer-agent/protocol';

/** Real menu events and committed DOM, measured inside the disposable renderer. */
export async function checkModelSwitch({ page, picker, first, second, getBot, failNext, until, report }) {
  const select = async model => {
    await picker.click();
    await page.getByRole('menuitem', { name: modelMenuChannelName(model.providerName, model.model, model.authMethod, true), exact: true }).click();
    await page.getByRole('menuitemradio', { name: model.label, exact: true }).click();
  };
  const measure = async model => {
    await picker.click();
    await page.getByRole('menuitem', { name: modelMenuChannelName(model.providerName, model.model, model.authMethod, true), exact: true }).click();
    await page.evaluate(label => {
      globalThis.rcModelSwitch = new Promise(resolve => {
        let deadline;
        // The production menu selects on mousedown and removes its portal
        // before click. Start at that actual selection event.
        const begin = event => {
          const item = event.target.closest('[role="menuitemradio"]');
          if (item?.textContent.trim() !== label) return;
          document.removeEventListener('mousedown', begin, true);
          clearTimeout(deadline);
          const start = performance.now(); let last = start, closedMs = null, maxFrameGapMs = 0, frames = 0;
          const frame = () => {
            const now = performance.now(); maxFrameGapMs = Math.max(maxFrameGapMs, now - last); last = now; frames++;
            const picker = document.querySelector('.bot-model-settings-row .pa-cascading-trigger');
            if (closedMs === null && !document.querySelector('[role="menuitemradio"]')) closedMs = now - start;
            const committed = picker.textContent.trim() === label && !picker.disabled;
            if (committed || now - start > 4000) {
              resolve({ committed, committedMs: now - start, closedMs, maxFrameGapMs, frames }); return;
            }
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        };
        deadline = setTimeout(() => { document.removeEventListener('mousedown', begin, true); resolve({ committed: false, eventMissing: true }); }, 15000);
        document.addEventListener('mousedown', begin, true);
      });
    }, model.label);
    await page.getByRole('menuitemradio', { name: model.label, exact: true }).click();
    return page.evaluate(async () => {
      const result = await globalThis.rcModelSwitch; delete globalThis.rcModelSwitch; return result;
    });
  };
  await select(first);
  await until(() => picker.textContent(), value => value === first.label);
  await until(() => picker.isEnabled(), Boolean);
  const switched = await measure(second);
  report.modelSwitch = { ...switched, scope: 'Production menu, renderer and durable profile through actual IPC; 650ms controlled save, no model network' };
  assert.equal(switched.committed, true, 'selected model must commit without waiting on redundant projection reads');
  assert.ok(switched.closedMs < 250, `menu close ${switched.closedMs}ms`);
  assert.ok(switched.committedMs < 2000, `controlled 650ms save took ${switched.committedMs}ms`);
  assert.ok(switched.maxFrameGapMs < 400, `renderer stopped drawing for ${switched.maxFrameGapMs}ms`);
  const committed = await getBot();
  assert.equal(committed.modelPolicy?.overrides?.project_agent?.modelProviderId, second.id, 'the displayed choice must be durably saved for this bot');
  const repeated = await measure(second);
  assert.ok(repeated.committedMs < 250, `unchanged model unnecessarily waited ${repeated.committedMs}ms`);
  assert.deepEqual(await getBot(), committed, 'repeated model choice must not write the profile or its update timestamp');
  failNext(); await select(first);
  await page.getByText('模型设置未保存，请重试。', { exact: true }).first().waitFor();
  assert.equal(await picker.textContent(), second.label);
  assert.equal(await picker.isEnabled(), true);
  assert.deepEqual(await getBot(), committed, 'failed switch must retain the last committed model and effort');
  report.modelSwitch = { ...switched, repeatedMs: repeated.committedMs, rollbackVerified: true,
    scope: 'Production menu, renderer and durable profile through actual IPC; 650ms controlled save, no model network' };
}

export async function checkModelSwitchOnly({ page, fixture, until, report, failNext, captureDirectory }) {
  const workspaceId = fixture.bots[0].workspaceId;
  await page.locator(`#bot-row-${workspaceId}`).click();
  await page.locator('.bot-profile').click();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const models = await page.evaluate(async workspaceId => (await window.peerAgent.projectAgentGet({ workspaceId })).modelOptions, workspaceId);
  const picker = page.locator('.bot-model-settings-row').first().locator('.pa-cascading-trigger');
  await checkModelSwitch({ page, picker, first: models.find(model => model.label === 'RC Bot model A'),
    second: models.find(model => model.label === 'RC Bot model B'),
    getBot: () => page.evaluate(async workspaceId => (await window.peerAgent.projectAgentGet({ workspaceId })).item.profile, workspaceId),
    failNext, until, report });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.bot-composer textarea').focus();
  await page.screenshot({ path: captureDirectory + '/composer-focus.png' });
  report.checks.push('real model switch, unchanged choice, failed save rollback and focused composer');
}
