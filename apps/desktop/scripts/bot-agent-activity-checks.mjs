import { BOT_DETAIL_SURFACE } from './bot-detail-surface-selectors.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync, writeFileSync, renameSync} from 'node:fs';
import {scrollToBotMessage} from './bot-reply-details-checks.mjs';

/** Actual production renderer and task navigation over explicit isolated host facts. */
export async function checkBotAgentActivity({page, until, report, captureDirectory, commandFile}) {
  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  const command = {...initial, seq: initial.seq + 1, sessions: [
    {...initial.sessions[0], sessionId: 'rc-work-1', title: '实现检查', status: 'waiting_agent', statusLabel: '由主 Bot 跟进'},
    {...initial.sessions[0], sessionId: 'rc-work-2', title: '独立核验', status: 'verifying', statusLabel: '正在核对结果', verificationProgress: { continuationId: 'rc-review', startedAt: '2026-10-21T00:00:00Z', lastProgressAt: '2026-10-21T00:01:00Z', observationCount: 7, phase: 'ready' }},
  ]};
  writeFileSync(commandFile + '.next', JSON.stringify(command)); renameSync(commandFile + '.next', commandFile);
  const cases = []; let marker;
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({width, height: 780});
    await page.evaluate(theme => {document.documentElement.dataset.theme = theme;}, appearance);
    const row = page.locator('#bot-msg-rc-message-9981.bot-agent-activity');
    await scrollToBotMessage(page, row);
    assert.match(await row.innerText(), /实现检查.*发来问题/s);
    assert.equal(await row.locator('svg').count(), 2);
    const identity = target => target.locator('.bot-agent-marker').evaluate(node => ({
      tone: node.dataset.tone, icon: node.dataset.agentIcon, svg: node.querySelector('svg').innerHTML,
    }));
    const current = await identity(row);
    marker ??= current; assert.deepEqual(marker, current);
    assert.deepEqual(await identity(page.locator('#bot-msg-rc-message-9980')), current);
    const otherRow = page.locator('#bot-msg-rc-message-9977');
    const other = await identity(otherRow);
    assert.equal(await page.locator('#bot-msg-rc-message-9984').count(), 0, 'internal verification progress stays out of the main conversation');
    assert.notEqual(current.icon, other.icon);
    assert.notEqual(current.svg, other.svg);
    assert.equal(await page.locator('#bot-msg-rc-message-9982').count(), 1);
    assert.equal(await page.locator('#bot-msg-rc-message-9983').count(), 0);
    assert.equal(await page.locator('.bot-agent-activity[data-agent-session="rc-work-1"][data-agent-state="reported"]').count(), 1);
    assert.equal(await row.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({path: path.join(captureDirectory, `agent-activity-${width}-${appearance}.png`), animations: 'disabled'});
    await row.focus(); await page.keyboard.press('Enter');
    const detail = page.locator('.bot-task-detail'); await detail.waitFor();
    await until(() => detail.innerText(), text => text.includes('实现检查') && text.includes('由主 Bot 跟进'));
    assert.doesNotMatch(await detail.innerText(), /需要你的选择/);
    await page.getByRole('button', {name: '关闭', exact: true}).click();
    await detail.waitFor({state: 'hidden'});
    await scrollToBotMessage(page, otherRow);
    await otherRow.focus(); await page.keyboard.press('Enter');
    await until(() => detail.innerText(), text => text.includes('独立核验') && text.includes('已检查 7 项事实'));
    await page.screenshot({path: path.join(captureDirectory, `agent-activity-detail-${width}-${appearance}.png`), animations: 'disabled'});
    await page.getByRole('button', {name: '关闭', exact: true}).click();
    await detail.waitFor({state: 'hidden'});
    await page.locator(BOT_DETAIL_SURFACE).waitFor({ state: 'hidden' });
    await page.locator('.pa-overlay-backdrop--drawer').waitFor({state: 'hidden'});
    cases.push({width, appearance, named: true, svg: true, stableIdentity: true, distinctShapes: true, legacyReportDeduped: true,
      taskDestination: true, humanWaitDistinct: true, verificationProgress: true, fits: true});
  }
  writeFileSync(commandFile + '.next', JSON.stringify({...initial, seq: command.seq + 1})); renameSync(commandFile + '.next', commandFile);
  report.agentActivity = {cases, scope: 'Production renderer and IPC with explicit isolated Agent facts; communication/Runner execution tested separately'};
}
