import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

/** Isolated task facts at the application-service seam; no personal tasks are changed. */
export async function checkBotVerification({ page, until, report, captureDirectory, commandFile }) {
  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  const viewport = page.viewportSize(), theme = await page.evaluate(() => document.documentElement.dataset.theme);
  let seq = initial.seq;
  const session = { ...initial.sessions[0], sessionId: 'verification-task', title: '核对历史记录并交还结果',
    origin: { anchorMessageId: 'rc-message-9993' }, sourceRevision: 'source-1' };
  const explanation = '历史记录核对完成，现有对话和证据均已保留；窗口恢复这一项尚未验证，需要继续核对。';
  const change = (outcome, extra = {}) => {
    const verification = { sessionId: session.sessionId, outcome, workerModel: 'configured-worker', verifierModel: 'configured-verifier', sameSource: false,
      checks: [{ name: 'leaf_evidence', result: ['partial', 'unverifiable'].includes(outcome) ? 'failed' : 'passed', evidenceRefs: ['tool-result://preserved'] },
        { name: 'independent_verifier', result: ['passed', 'partial'].includes(outcome) ? 'passed' : 'failed', reason: outcome === 'unverifiable' ? 'missing' : ['passed', 'partial'].includes(outcome) ? undefined : 'failed', evidenceRefs: ['tool-result://preserved'] }],
      outputs: [], reviewAttempts: [{ verifierRunId: 'previous-review', status: 'failed', diagnosticOnly: true, matchesCurrentSource: false,
        completedAt: '2026-10-22T08:39:00Z', failureReason: '窗口恢复检查未完成，不能据此认定全部验收通过。', failedCriteria: [], missingEvidence: [], risks: [], recommendedNextAction: '继续核对', evidenceRefs: ['tool-result://preserved'] }] };
    const command = { ...initial, seq: ++seq, reportReadMode: 'ready',
      sessions: [{ ...session, status: outcome === 'passed' ? 'result_ready' : 'waiting_agent', statusLabel: outcome === 'passed' ? '结果待核对' : '等待机器人继续处理', observationRevision: `review-${seq}` }],
      detailReports: { [session.sessionId]: { taskBrief: '保留历史记录，核对恢复结果。', evidenceRefs: ['tool-result://preserved'], verification } },
      conversationMessages: [
        { id: 'verification-start', kind: 'agent_activity', role: 'system', content: '', agentActivity: { eventId: 'checking', sessionId: session.sessionId, name: session.title, state: 'verifying' } },
        { id: 'legacy-verdict', kind: 'system_card', role: 'assistant', content: outcome, cards: [{ cardId: 'card:verdict:verification-task', kind: 'verdict', content: outcome, resolvedState: 'resolved' }] },
        { id: 'verification-ended', kind: 'agent_activity', role: 'system', content: '', agentActivity: { eventId: 'ended', sessionId: session.sessionId, name: session.title, state: 'ended' } },
        { id: 'verification-explanation', kind: 'agent_reply', role: 'assistant', content: explanation, sources: [session.sessionId], createdAt: new Date().toISOString() },
      ], ...extra };
    writeFileSync(commandFile + '.next', JSON.stringify(command)); renameSync(commandFile + '.next', commandFile);
  };
  const labels = { passed: '结论：已验证', failed: '结论：没通过', partial: '结论：部分验证', unverifiable: '结论：无法验证' };
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, appearance);
    change('passed');
    await page.locator('#bot-msg-verification-explanation').waitFor();
    await page.locator('#bot-msg-verification-explanation').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('[data-card-id="card:verdict:verification-task"]').count(), 0);
    assert.equal(await page.locator('#bot-msg-legacy-verdict').count(), 0);
    assert.equal(await page.locator('#bot-msg-verification-start').count(), 0);
    assert.equal(await page.locator('.bot-agent-activity[data-agent-state=verified]').count(), 0);
    assert.ok((await page.locator('#bot-msg-verification-explanation').innerText()).includes(explanation));
    await page.screenshot({ path: path.join(captureDirectory, `verification-main-${width}-${appearance}.png`), animations: 'disabled' });
    await page.locator('.bot-profile').click();
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    if (await page.locator('.bot-task-detail').count()) await page.getByRole('button', { name: '任务列表', exact: true }).click();
    await page.locator('.bot-task-row').filter({ hasText: session.title }).click();
    for (const outcome of ['passed', 'failed', 'partial', 'unverifiable']) {
      change(outcome);
      const detail = page.locator('.bot-task-verification');
      await until(() => detail.getAttribute('data-outcome'), value => value === outcome);
      assert.ok((await detail.innerText()).includes(labels[outcome]));
      const history = detail.locator('summary');
      await history.focus(); await history.press('Enter');
      await detail.getByText('窗口恢复检查未完成，不能据此认定全部验收通过。', { exact: true }).waitFor({ state: 'visible' });
      assert.ok((await detail.innerText()).includes('历史记录仅供调查，不代表当前结论。'));
      assert.equal(await page.locator('.bot-task-detail').evaluate(node => node.scrollWidth <= node.clientWidth), true);
      await detail.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(captureDirectory, `verification-task-${outcome}-${width}-${appearance}.png`), animations: 'disabled' });
    }
    change('passed', { reportReadMode: 'unavailable' });
    await until(() => page.locator('.bot-task-verification').count(), count => count === 0);
    const info = page.locator('.bot-task-information');
    await info.locator(':scope > summary').click();
    await info.getByRole('button', { name: '重试', exact: true }).waitFor();
    const retryState = JSON.parse(readFileSync(commandFile, 'utf8'));
    writeFileSync(commandFile + '.next', JSON.stringify({ ...retryState, seq: ++seq, reportReadMode: 'ready' }));
    renameSync(commandFile + '.next', commandFile);
    const retry = info.getByRole('button', { name: '重试', exact: true });
    await retry.focus(); await retry.press('Enter');
    await until(() => page.locator('.bot-task-verification').getAttribute('data-outcome'), value => value === 'passed');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.bot-task-detail').waitFor({ state: 'hidden' });
  }
  report.taskVerification = { outcomes: ['passed', 'failed', 'partial', 'unverifiable'], themes: ['dark', 'light'], legacyHidden: true, botExplanation: true, historyKeyboard: true, staleHidden: true, retry: true };
  if (viewport) await page.setViewportSize(viewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  report.checks.push('verification stays in task details for all four outcomes; legacy verdict cards are hidden, bot explanation survives, history is keyboard-accessible, failed refresh hides stale verdict and retry restores it in dark wide and light narrow windows');
  writeFileSync(commandFile + '.next', JSON.stringify({ ...initial, seq: ++seq })); renameSync(commandFile + '.next', commandFile);
}
