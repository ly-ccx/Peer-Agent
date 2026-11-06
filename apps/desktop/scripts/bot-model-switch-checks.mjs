import { BOT_DETAIL_CLOSE } from './bot-detail-surface-selectors.mjs';
import assert from 'node:assert/strict';
import { modelMenuChannelName } from '@peer-agent/protocol';

/** Explicit provider activation selects its first eligible model through the real owner. */
export async function openModelProvider({ page, picker, model }) {
  if (await picker.getAttribute('aria-expanded') !== 'true') await picker.click();
  const panel = page.locator('.model-selection-popover[data-surface-state="open"] .model-selection-panel');
  await panel.waitFor();
  await panel.locator('.model-selection-provider').click();
  const group = model ? modelMenuChannelName(model.providerName, model.model, model.authMethod, true) : '默认与档位';
  await panel.locator('.model-selection-provider-menu').getByRole('option', { name: group, exact: true }).click();
  return panel;
}

export async function chooseModelInPanel({ page, picker, model, close = true }) {
  const panel = await openModelProvider({ page, picker, model });
  await panel.locator('.model-selection-model').filter({ has: page.getByText(model?.label || '跟随全局', { exact: true }) }).click();
  if (close) { await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' }); }
}

/** Real menu events and committed DOM, measured inside the disposable renderer. */
export async function checkModelSwitch({ page, picker, first, second, getBot, failNext, until, report }) {
  const label = () => picker.locator('.model-selection-trigger-label').textContent();
  const select = model => chooseModelInPanel({ page, picker, model });
  const measure = async model => {
    const panel = await openModelProvider({ page, picker, model });
    await page.evaluate(label => {
      globalThis.rcModelSwitch = new Promise(resolve => {
        let deadline;
        const begin = event => {
          const item = event.target.closest('.model-selection-model');
          if (item?.querySelector('.model-selection-model-label')?.textContent.trim() !== label) return;
          document.removeEventListener('click', begin, true); clearTimeout(deadline);
          const start = performance.now(); let last = start, maxFrameGapMs = 0, frames = 0;
          const frame = () => {
            const now = performance.now(); maxFrameGapMs = Math.max(maxFrameGapMs, now - last); last = now; frames++;
            const picker = document.querySelector('.bot-model-settings-row .model-selection-trigger');
            const committed = picker.querySelector('.model-selection-trigger-label').textContent.trim() === label
              && picker.getAttribute('aria-disabled') !== 'true' && !picker.disabled;
            if (committed || now - start > 4000) {
              resolve({ committed, committedMs: now - start, maxFrameGapMs, frames,
                panelRetained: Boolean(document.querySelector('.model-selection-popover[data-surface-state="open"] .model-selection-panel')) }); return;
            }
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        };
        deadline = setTimeout(() => { document.removeEventListener('click', begin, true); resolve({ committed: false, eventMissing: true }); }, 15000);
        document.addEventListener('click', begin, true);
      });
    }, model.label);
    await panel.locator('.model-selection-model').filter({ has: page.getByText(model.label, { exact: true }) }).click();
    const result = await page.evaluate(async () => {
      const result = await globalThis.rcModelSwitch; delete globalThis.rcModelSwitch; return result;
    });
    await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
    return result;
  };
  await select(first);
  await until(label, value => value === first.label); await until(() => picker.isEnabled(), Boolean);
  const switched = await measure(second);
  assert.equal(switched.committed, true, 'selected model must commit without redundant projection reads');
  assert.equal(switched.panelRetained, true, 'model and effort remain together until explicit dismissal');
  assert.ok(switched.committedMs < 2000, `controlled 650ms save took ${switched.committedMs}ms`);
  assert.ok(switched.maxFrameGapMs < 400, `renderer stopped drawing for ${switched.maxFrameGapMs}ms`);
  const committed = await getBot();
  assert.equal(committed.modelPolicy?.overrides?.project_agent?.modelProviderId, second.id);
  const repeated = await measure(second);
  assert.ok(repeated.committedMs < 250, `unchanged model unnecessarily waited ${repeated.committedMs}ms`);
  assert.deepEqual(await getBot(), committed, 'repeated choice must not write the profile or timestamp');
  failNext(); await select(first);
  await page.locator('.bot-model-error[role="alert"], .bot-model-feedback [role="alert"]').first().waitFor();
  assert.equal(await label(), second.label); assert.equal(await picker.isEnabled(), true);
  assert.deepEqual(await getBot(), committed, 'failed switch must retain the committed model and effort');
  // New recovery UI retains the failed draft; explicitly discard it in this disposable fixture.
  const discard = page.locator('.bot-settings-tab .bot-model-feedback').getByRole('button', { name: '舍弃修改', exact: true });
  if (await discard.count()) await discard.click();
  report.modelSwitch = { ...switched, repeatedMs: repeated.committedMs, rollbackVerified: true,
    scope: 'Unified model/effort panel and durable profile through actual IPC; 650ms controlled save, no model network' };
}

export async function checkModelSwitchOnly({ page, fixture, until, report, failNext, captureDirectory }) {
  const workspaceId = fixture.bots[0].workspaceId;
  await page.locator(`#bot-row-${workspaceId}`).click();
  await page.getByRole('button', { name: '机器人设置', exact: true }).click();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const models = await page.evaluate(async workspaceId => (await window.peerAgent.projectAgentGet({ workspaceId })).modelOptions, workspaceId);
  const picker = page.locator('.bot-model-settings-row').first().locator('.pa-cascading-trigger');
  await checkModelSwitch({ page, picker, first: models.find(model => model.label === 'RC Bot model A'),
    second: models.find(model => model.label === 'RC Bot model B'),
    getBot: () => page.evaluate(async workspaceId => (await window.peerAgent.projectAgentGet({ workspaceId })).item.profile, workspaceId),
    failNext, until, report });
  await page.locator(BOT_DETAIL_CLOSE).click();
  await page.locator('.bot-composer textarea').focus();
  await page.screenshot({ path: captureDirectory + '/composer-focus.png' });
  report.checks.push('real model switch, unchanged choice, failed save rollback and focused composer');
}
