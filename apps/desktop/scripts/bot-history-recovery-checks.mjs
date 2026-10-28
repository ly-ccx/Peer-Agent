import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkCoordinationStore } from '../../../packages/runtime-node/src/project-agent/work-coordination-store.mjs';
import { readRecoveredCoordination } from '../../../packages/runtime-node/src/project-agent/coordination-fork-recovery.mjs';

export const recoveryShots = [[1280, 'dark'], [760, 'light']].flatMap(([width, theme]) =>
  ['inspection', 'held', 'confirm', 'retained'].map(stage => `recovery-${stage}-${width}-${theme}.png`));

/** Synthetic history; the app uses its real lease, maintenance service and IPC. */
export async function seedHistoryRecovery({ home, bot }) {
  const rootDir = path.join(home, 'project-runtime'), directory = path.join(rootDir, bot.workspaceId);
  const opts = { rootDir, workspaceId: bot.workspaceId, holdsLease: () => true, leaseEpoch: () => 'fixture-owner' };
  const legacy = createWorkCoordinationStore(opts);
  const work = { workId: 'historical-review', workspaceId: bot.workspaceId, parentConversationId: bot.conversationId,
    state: 'runnable', anchorInputIds: ['original-input'], sessionIds: [],
    checkpointRef: legacy.checkpoint('historical-review', { job: { workId: 'historical-review', kind: 'user',
      userInputs: [{ inputId: 'original-input', text: '核对已有修改与报告' }] }, outcome: { rounds: [] } }),
    budget: { tokens: 17, observations: { 'saved-receipt': true }, uncertainDispatches: [{ toolCallId: 'unknown-write' }] } };
  legacy.saveWork({ workId: 'already-delivered', state: 'delivered', anchorInputIds: ['completed-input'], reportRef: 'fixture://preserved-result' });
  legacy.saveWork(work); const revision = legacy.read().revision; legacy.close();
  const current = createWorkCoordinationStore({ ...opts, formatVersion: 2 }); await current.prepare();
  current.saveWork({ ...work, note: 'current branch' }); current.close();
  rmSync(path.join(directory, 'coordination-v2/legacy-seal.json'));
  const source = path.join(directory, 'coordination.jsonl');
  appendFileSync(source, JSON.stringify({ schemaVersion: 1, epoch: 'old-writer', revision: revision + 1,
    kind: 'work', work: { ...work, anchorInputIds: ['legacy-input'], note: 'legacy branch' } }) + '\n');
  return { directory, sourceHash: createHash('sha256').update(readFileSync(source)).digest('hex') };
}

export async function checkHistoryRecovery({ page, until, report, captureDirectory, bots, histories, readTurns }) {
  const cases = [];
  for (const [index, [width, theme]] of [[1280, 'dark'], [760, 'light']].entries()) {
    const bot = bots[index], historical = histories[index];
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.locator('.bot-row').filter({ has: page.locator('.bot-row-name', { hasText: `project-${String(index).padStart(3, '0')}` }) }).click();
    const control = page.locator('.bot-recovery-control'); await control.waitFor();
    await page.locator('.bot-composer textarea').fill('这份草稿必须保留');
    await control.locator(':scope > details > summary').focus(); await page.keyboard.press('Enter');
    await control.getByText('核对已有修改与报告', { exact: true }).waitFor();
    const capture = stage => page.screenshot({ path: path.join(captureDirectory, `recovery-${stage}-${width}-${theme}.png`) });
    await capture('inspection');
    await control.getByRole('button', { name: '保全历史并安全继续', exact: true }).click();
    await control.getByRole('button', { name: '保留成果并结束旧执行', exact: true }).waitFor();
    await until(() => page.evaluate(workspaceId => window.peerAgent.projectAgentRecovery({ workspaceId, action: 'inspect' }), bot.workspaceId),
      result => result.ok && result.view.runtimeReady === true);
    await until(() => control.getByRole('button', { name: '保留成果并结束旧执行', exact: true }).isEnabled(), Boolean);
    await capture('held');
    await control.getByRole('button', { name: '保留成果并结束旧执行', exact: true }).click();
    await control.getByText('会保留报告、历史和检查点并停止这次旧执行，不会把未知操作标成成功，也不会重发原指令。', { exact: true }).waitFor();
    await capture('confirm');
    await control.getByRole('button', { name: '确认结束旧执行', exact: true }).click();
    await until(() => control.getByRole('button', { name: '保留成果并结束旧执行', exact: true }).count(), count => count === 0);
    assert.equal(await page.locator('.bot-composer textarea').inputValue(), '这份草稿必须保留');
    await until(() => page.evaluate(workspaceId => window.peerAgent.projectAgentRecovery({ workspaceId, action: 'inspect' }), bot.workspaceId),
      result => result.ok && result.view.runtimeReady === true);
    await control.getByText('历史已保全，对话可以继续。', { exact: true }).waitFor();
    await capture('retained');
    const intent = JSON.parse(readFileSync(path.join(historical.directory, 'coordination-recovery.json')));
    const state = readRecoveredCoordination(historical.directory, intent.generation);
    assert.equal(state.works['already-delivered'].state, 'delivered');
    assert.equal(state.works['historical-review'].state, 'cancelled');
    assert.equal(state.works['historical-review'].budget.tokens, 17);
    assert.equal(state.works['historical-review'].budget.uncertainDispatches[0].toolCallId, 'unknown-write');
    assert.ok(state.lastRecovery.quarantinedInputIds.includes('legacy-input'));
    assert.equal(createHash('sha256').update(readFileSync(path.join(historical.directory, intent.archive, 'original/coordination.jsonl'))).digest('hex'), historical.sourceHash);
    const fits = await control.evaluate(element => element.scrollWidth <= element.clientWidth + 1);
    assert.equal(fits, true);
    assert.equal(readTurns().length, 0, 'historical recovery must not invoke cognition or replay original requests');
    cases.push({ width, theme, realLocalIPC: true, historyPreserved: true, unknownNotReplayed: true, draftPreserved: true, keyboard: true, fits });
  }
  report.historyRecovery = { passed: true, cases };
}
