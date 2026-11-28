import { BOT_DETAIL_SURFACE, BOT_DETAIL_CLOSE } from './bot-detail-surface-selectors.mjs';
import { taskEntry } from './bot-work-panel-checks.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';

export async function setFixtureBotAccess(page, workspaceId, accessLevel) {
  const result = await page.evaluate(async ({ workspaceId, accessLevel }) => {
    const current = await window.peerAgent.projectAgentReadAccessPolicy({ workspaceId });
    if (!current.ok || !current.policy) return current;
    return window.peerAgent.projectAgentUpdateAccessPolicy({ workspaceId, expectedRevision: current.policy.revision, accessLevel });
  }, { workspaceId, accessLevel });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.policy;
}

/** Uses production local IPC/persistence and actual child conversation metadata. No model calls. */
export async function checkBotAccessPolicy({ page, until, report, captureDirectory, home, bots, commandFile }) {
  if (await page.locator(BOT_DETAIL_SURFACE).count()) await page.locator(BOT_DETAIL_CLOSE).click();
  const viewport = page.viewportSize(), theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const read = workspaceId => page.evaluate(workspaceId => window.peerAgent.projectAgentReadAccessPolicy({ workspaceId }), workspaceId);
  const otherBefore = await read(bots[1].workspaceId);
  const picker = page.locator('.bot-composer .bot-access-picker > button');
  await until(() => picker.isEnabled(), Boolean);
  await picker.focus(); await page.keyboard.press('Enter');
  await page.getByRole('option', { name: '完全访问', exact: true }).click();
  await until(() => read(bots[0].workspaceId), result => result.ok && result.policy.accessLevel === 'full_local');
  await until(() => picker.innerText(), label => label.includes('完全访问'));
  assert.deepEqual((await read(bots[1].workspaceId)).policy, otherBefore.policy);
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 860 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    // The work panel and navigation can still be resizing after the viewport
    // event. Measure the final composer layout after visible finite motion ends.
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'
      && Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.effect?.target?.checkVisibility()), null, { timeout: 5000 });
    assert.equal(await page.locator('.bot-composer').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.locator('.bot-composer').screenshot({ path: path.join(captureDirectory, `bot-access-${width}-${appearance}.png`) });
  }
  const conversations = createConversationStore({ storeDir: path.join(home, 'conversations') });
  const history = conversations.getPersistedConversationHistory(bots[0].conversationId);
  const anchorMessageId = history.messages.findLast(message => message.role === 'user').id;
  const child = conversations.createChildConversation({ title: '继承主 Bot 权限的任务', role: 'work_session',
    capturedAt: new Date().toISOString(), anchorMessageId, delegation: { sessionId: 'access-policy-fixture', anchorMessageId, inputId: 'access-policy-input' },
    backgroundMessageIds: [anchorMessageId], runtimeState: { conversationId: bots[0].conversationId, contentRevision: history.contentRevision, status: 'idle' },
    workspaceId: bots[0].workspaceId, workspacePath: bots[0].path, parentConversationId: bots[0].conversationId });
  const inherited = await page.evaluate(conversationId => window.peerAgent.projectAgentReadAccessPolicy({ conversationId }), child.id);
  assert.equal(inherited.ok, true, JSON.stringify(inherited)); assert.equal(inherited.inherited, true); assert.equal(inherited.policy.accessLevel, 'full_local');
  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  const command = { ...initial, seq: initial.seq + 1, sessions: [{ ...initial.sessions[0], conversationId: child.id }] };
  writeFileSync(commandFile + '.next', JSON.stringify(command)); renameSync(commandFile + '.next', commandFile);
  await until(() => page.evaluate(workspaceId => window.peerAgent.projectAgentListSessions({ workspaceId }), bots[0].workspaceId),
    result => result.sessions?.some(session => session.sessionId === command.sessions[0].sessionId && session.conversationId === child.id));
  const row = await taskEntry(page, command.sessions[0]);
  await row.click();
  const workspace = page.locator('.bot-task-workspace');
  const scene = workspace.locator('.bot-task-conversation-stage .bot-inline-scene');
  await scene.waitFor();
  // Process viewing deliberately has no composer or inherited access control.
  // Verify inheritance through its real host facts, and the view through its DOM.
  const assertReadOnlyScene = async () => {
    await scene.locator('.chat-surface--process').waitFor({ state: 'visible' });
    assert.equal(await scene.locator('.chat-composer').count(), 0);
    assert.equal(await scene.locator('.composer-access-dropdown').count(), 0);
    assert.equal(await scene.locator('.conversation-access-inherited').count(), 0);
    const policy = await page.evaluate(conversationId => window.peerAgent.projectAgentReadAccessPolicy({ conversationId }), child.id);
    assert.equal(policy.ok, true); assert.equal(policy.inherited, true);
    assert.equal(policy.policy.accessLevel, 'full_local');
  };
  await assertReadOnlyScene();
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    const previousScene = await scene.elementHandle();
    await page.setViewportSize({ width, height: 860 }); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    // Keep the same worker conversation as the task workspace adapts to the window.
    await workspace.waitFor();
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'
      && Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.effect?.target?.checkVisibility()));
    assert.equal(await scene.evaluate((node, previous) => node === previous && previous.isConnected, previousScene), true);
    await previousScene.dispose();
    await scene.waitFor({ state: 'visible' });
    await assertReadOnlyScene();
    await page.screenshot({ path: path.join(captureDirectory, `bot-access-child-${width}-${appearance}.png`), animations: 'disabled' });
  }
  await page.locator('.bot-crumb-parent').focus(); await page.keyboard.press('Enter');
  await scene.waitFor({ state: 'detached' });
  await workspace.waitFor({ state: 'hidden' });
  assert.ok((await picker.innerText()).includes('完全访问'));
  writeFileSync(commandFile + '.next', JSON.stringify({ ...initial, seq: command.seq + 1 })); renameSync(commandFile + '.next', commandFile);
  await setFixtureBotAccess(page, bots[0].workspaceId, 'ask_before_local');
  if (viewport) await page.setViewportSize(viewport); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  report.botAccessPolicy = { passed: true, realLocalIPC: true, durablePolicy: true, keyboard: true, isolatedBots: true,
    childMetadata: true, childReadOnly: true, returnsToBot: true, darkWideLightNarrow: true };
}
