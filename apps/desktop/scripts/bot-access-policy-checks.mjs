import { BOT_DETAIL_SURFACE, BOT_DETAIL_CLOSE } from './bot-detail-surface-selectors.mjs';
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

async function openTaskScene(page, scene) {
  const information = page.locator('.bot-task-information');
  if (await information.getAttribute('open') === null) await information.locator(':scope > summary').click();
  // Native details keeps descendant rectangles at their final positions while
  // its clipped content is still expanding. Wait for that real transition
  // before dispatching the single pointer action into the revealed content.
  await information.evaluate(async node => {
    await Promise.all(node.getAnimations({ subtree: true })
      .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.locator('.bot-task-scene').click();
  await scene.waitFor({ state: 'visible' });
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
  await page.getByRole('button', { name: '机器人设置', exact: true }).click();
  // The preceding 760px case must reach its cover layout before opening a child.
  await page.locator('.bot-drawer-panel .bot-drawer-body').waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  if (await page.locator('.bot-task-detail').count()) await page.getByRole('button', { name: '任务列表', exact: true }).click();
  await page.locator('.bot-task-row').filter({ has: page.getByText(command.sessions[0].title, { exact: true }) }).click();
  const scene = page.locator('.conversation-chat-drawer--nested');
  await openTaskScene(page, scene);
  const status = scene.locator('.conversation-access-inherited');
  await until(() => status.innerText(), text => text.includes('继承自主 Bot') && text.includes('完全访问'));
  assert.equal(await scene.locator('.composer-access-dropdown').count(), 0);
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    const previousScene = await scene.elementHandle();
    await page.setViewportSize({ width, height: 860 }); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    // Crossing the push/cover breakpoint remounts the task and its nested scene.
    // Observe the new parent before deciding whether the scene needs reopening.
    await page.locator(BOT_DETAIL_SURFACE).locator('.bot-task-detail').waitFor({ state: 'visible' });
    // The old portal can remain connected during its exit animation even after
    // the new parent is visible. Inspect only the newly mounted scene.
    await page.waitForFunction(node => !node.isConnected, previousScene);
    await previousScene.dispose();
    // Presence and responsive layout can finish in different commits. Decide
    // whether to reopen only after finite transitions and the resulting DOM settle.
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'
      && Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.effect?.target?.checkVisibility()));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (!await scene.count()) {
      await openTaskScene(page, scene);
    }
    await scene.waitFor({ state: 'visible' });
    await until(() => status.innerText(), text => text.includes('继承自主 Bot') && text.includes('完全访问'));
    await page.screenshot({ path: path.join(captureDirectory, `bot-access-child-${width}-${appearance}.png`), animations: 'disabled' });
  }
  await status.focus(); await page.keyboard.press('Enter');
  await scene.waitFor({ state: 'detached' });
  await until(() => page.locator(BOT_DETAIL_SURFACE).count(), count => count === 0);
  assert.ok((await picker.innerText()).includes('完全访问'));
  writeFileSync(commandFile + '.next', JSON.stringify({ ...initial, seq: command.seq + 1 })); renameSync(commandFile + '.next', commandFile);
  await setFixtureBotAccess(page, bots[0].workspaceId, 'ask_before_local');
  if (viewport) await page.setViewportSize(viewport); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  report.botAccessPolicy = { passed: true, realLocalIPC: true, durablePolicy: true, keyboard: true, isolatedBots: true,
    childMetadata: true, childReadOnly: true, returnsToBot: true, darkWideLightNarrow: true };
}
