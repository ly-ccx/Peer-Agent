import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createGoalPlanStore } from '@peer-agent/runtime-node';
import { createWorkCoordinationStore } from '../../../packages/runtime-node/src/project-agent/work-coordination-store.mjs';
import { readRecoveredCoordination } from '../../../packages/runtime-node/src/project-agent/coordination-fork-recovery.mjs';

export const recoveryShots = [[1280, 'dark'], [760, 'light']].flatMap(([width, theme]) =>
  ['inspection', 'held', 'confirm', 'confirm-all', 'settled'].map(stage => `recovery-${stage}-${width}-${theme}.png`));
const historicalWorks = [['historical-review', '核对已有修改与报告'], ['historical-tests', '补齐失败的回归测试'], ['historical-notes', '整理发布说明']];
const stoppedChildTitle = '定位入口中断原因';

/** A child that stopped on a provider interruption the runner never consumed; ending it must settle as cancelled. */
function seedStoppedChild({ home, bot }) {
  const conversation = createConversationStore({ storeDir: path.join(home, 'conversations') }).createConversation({
    title: stoppedChildTitle, role: 'work_session', workspaceId: bot.workspaceId, workspacePath: bot.path });
  const plans = createGoalPlanStore({ storeDir: path.join(home, 'goal-plans') });
  const model = { providerId: 'synthetic-history-only', modelId: 'historical-child', modelProviderId: 'historical-child', family: 'synthetic' };
  // Session ids are global to the supervisor, so each bot owns a distinct one.
  const sessionId = `historical-child-${bot.workspaceId}`;
  const plan = plans.createPlan({ title: stoppedChildTitle, goal: 'Historical child stopped by a provider interruption; never execute.',
    conversationId: conversation.id, tasks: [{ taskId: 'historical-child-leaf', title: stoppedChildTitle, status: 'completed' }],
    delegationOrigin: { workspaceId: bot.workspaceId, parentConversationId: bot.conversationId, sessionId,
      anchorMessageId: 'child-input', inputId: 'child-input', phase: 'paused', depth: 1, readOnly: true,
      modelSelection: { worker: model, explorer: model, verifier: model, source: {}, resolvedAt: '2026-10-18T04:00:00.000Z' } } });
  plans.setRunnerState(plan.planId, { enabled: true, status: 'paused', intent: 'block', phase: 'blocked',
    interruption: { source: 'stream_error', origin: 'provider', reason: 'work_budget_limited', interruptedAt: '2026-10-18T04:10:11.123Z', recoverable: false, attempt: 1 } });
  plans.setPlanStatus(plan.planId, 'interrupted');
  assert.equal(plans.getPlan(plan.planId).status, 'interrupted');
  return { sessionId, planId: plan.planId, storeDir: plans.getStoreDir() };
}

/** Synthetic history; the app uses its real lease, maintenance service and IPC. */
export async function seedHistoryRecovery({ home, bot }) {
  const child = seedStoppedChild({ home, bot });
  const rootDir = path.join(home, 'project-runtime'), directory = path.join(rootDir, bot.workspaceId);
  const opts = { rootDir, workspaceId: bot.workspaceId, holdsLease: () => true, leaseEpoch: () => 'fixture-owner' };
  const legacy = createWorkCoordinationStore(opts);
  const works = historicalWorks.map(([workId, text], index) => {
    const suffix = index ? `-${index}` : '';
    return { workId, workspaceId: bot.workspaceId, parentConversationId: bot.conversationId,
      state: 'runnable', anchorInputIds: [`original-input${suffix}`], sessionIds: [],
      checkpointRef: legacy.checkpoint(workId, { job: { workId, kind: 'user',
        userInputs: [{ inputId: `original-input${suffix}`, text }] }, outcome: { rounds: [] } }),
      budget: { tokens: 17, observations: { 'saved-receipt': true }, uncertainDispatches: [{ toolCallId: `unknown-write${suffix}` }] } };
  });
  legacy.saveWork({ workId: 'already-delivered', state: 'delivered', anchorInputIds: ['completed-input'], reportRef: 'fixture://preserved-result' });
  for (const work of works) legacy.saveWork(work);
  const revision = legacy.read().revision; legacy.close();
  const current = createWorkCoordinationStore({ ...opts, formatVersion: 2 }); await current.prepare();
  for (const work of works) current.saveWork({ ...work, note: 'current branch' });
  current.close();
  rmSync(path.join(directory, 'coordination-v2/legacy-seal.json'));
  const source = path.join(directory, 'coordination.jsonl');
  appendFileSync(source, works.map((work, index) => JSON.stringify({ schemaVersion: 1, epoch: 'old-writer', revision: revision + 1 + index,
    kind: 'work', work: { ...work, anchorInputIds: [`legacy-input${index ? `-${index}` : ''}`], note: 'legacy branch' } }) + '\n').join(''));
  return { directory, child, sourceHash: createHash('sha256').update(readFileSync(source)).digest('hex') };
}

export async function checkHistoryRecovery({ page, until, report, captureDirectory, bots, histories, readTurns }) {
  const cases = [];
  for (const [index, [width, theme]] of [[1280, 'dark'], [760, 'light']].entries()) {
    const bot = bots[index], historical = histories[index];
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: `project-${String(index).padStart(3, '0')}` }) }).click();
    const control = page.locator('.bot-recovery-control'); await control.waitFor();
    const composer = page.locator('.bot-composer textarea');
    await composer.fill('这份草稿必须保留');
    await control.locator('.bot-recovery-toggle').focus(); await page.keyboard.press('Enter');
    await control.getByText('核对已有修改与报告', { exact: true }).waitFor();
    const capture = stage => page.screenshot({ path: path.join(captureDirectory, `recovery-${stage}-${width}-${theme}.png`) });
    const runtimeReady = () => until(() => page.evaluate(workspaceId => window.peerAgent.projectAgentRecovery({ workspaceId, action: 'inspect' }), bot.workspaceId),
      result => result.ok && result.view.runtimeReady === true);
    const fits = () => control.evaluate(element => element.scrollWidth <= element.clientWidth + 1);
    const retire = control.getByRole('button', { name: '保留成果并结束旧执行', exact: true });
    await capture('inspection');
    await control.getByRole('button', { name: '保全历史并安全继续', exact: true }).click();
    // Each historical work plus the stopped child task offers its own retire action.
    await until(() => retire.count(), count => count === historicalWorks.length + 1);
    await control.getByText(stoppedChildTitle, { exact: true }).waitFor();
    await runtimeReady();
    await until(() => retire.first().isEnabled(), Boolean);
    await capture('held');
    const heldFits = await fits();
    await retire.first().click();
    await control.getByText('会保留报告、历史和检查点并停止这次旧执行，不会把未知操作标成成功，也不会重发原指令。', { exact: true }).waitFor();
    await capture('confirm');
    await control.getByRole('button', { name: '确认结束旧执行', exact: true }).click();
    await until(() => retire.count(), count => count === historicalWorks.length);
    await runtimeReady();
    const retireAll = control.getByRole('button', { name: '全部结束旧执行', exact: true });
    await until(() => retireAll.isEnabled(), Boolean);
    await retireAll.click();
    await control.getByText('会保留这 3 项的报告、历史和检查点并停止它们，不会把未知操作标成成功，也不会重发原指令。可以安全继续的工作不受影响。', { exact: true }).waitFor();
    await capture('confirm-all');
    const confirmFits = await fits();
    await control.getByRole('button', { name: '确认结束 3 项旧执行', exact: true }).focus(); await page.keyboard.press('Enter');
    await runtimeReady();
    await control.waitFor({ state: 'detached' });
    const focusReturned = await until(() => page.evaluate(() => document.activeElement?.matches('.bot-composer textarea') === true), Boolean);
    assert.equal(await composer.inputValue(), '这份草稿必须保留');
    await capture('settled');
    const intent = JSON.parse(readFileSync(path.join(historical.directory, 'coordination-recovery.json')));
    const state = readRecoveredCoordination(historical.directory, intent.generation);
    assert.equal(state.works['already-delivered'].state, 'delivered');
    for (const [workId] of historicalWorks) assert.equal(state.works[workId].state, 'cancelled');
    assert.equal(state.works['historical-review'].budget.tokens, 17);
    assert.equal(state.works['historical-review'].budget.uncertainDispatches[0].toolCallId, 'unknown-write');
    assert.ok(state.lastRecovery.quarantinedInputIds.includes('legacy-input'));
    assert.ok(state.lastRecovery.retainedSessionIds.includes(historical.child.sessionId));
    const child = createGoalPlanStore({ storeDir: historical.child.storeDir }).getPlan(historical.child.planId);
    assert.equal(child.status, 'cancelled', 'structured cancellation settles a child stopped on an unconsumed interruption');
    assert.equal(child.runner.interruption.reason, 'work_budget_limited', 'the interruption stays as history');
    assert.equal(child.delegationOrigin.retainedForRecovery, true);
    assert.equal(createHash('sha256').update(readFileSync(path.join(historical.directory, intent.archive, 'original/coordination.jsonl'))).digest('hex'), historical.sourceHash);
    assert.equal(heldFits && confirmFits, true);
    assert.equal(readTurns().length, 0, 'historical recovery must not invoke cognition or replay original requests');
    cases.push({ width, theme, realLocalIPC: true, historyPreserved: true, unknownNotReplayed: true, draftPreserved: true, keyboard: true,
      batchRetired: true, interruptedChildSettled: true, entrySettled: true, focusReturned, fits: heldFits && confirmFits });
  }
  report.historyRecovery = { passed: true, cases };
}
