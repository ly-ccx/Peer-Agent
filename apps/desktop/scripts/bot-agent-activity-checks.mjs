import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync, writeFileSync, renameSync} from 'node:fs';

/** Actual production renderer and task navigation over explicit isolated host facts. */
export async function checkBotAgentActivity({page, until, report, captureDirectory, commandFile}) {
  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  const command = {...initial, seq: initial.seq + 1, sessions: [
    {...initial.sessions[0], sessionId: 'rc-work-1', title: '实现检查', status: 'waiting_agent', statusLabel: '等待主 Bot 答复'},
    {...initial.sessions[0], sessionId: 'rc-work-2', title: '独立核验', status: 'running', statusLabel: '正在运行中'},
  ]};
  writeFileSync(commandFile + '.next', JSON.stringify(command)); renameSync(commandFile + '.next', commandFile);
  const cases = []; let marker;
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({width, height: 780});
    await page.evaluate(theme => {document.documentElement.dataset.theme = theme;}, appearance);
    const row = page.locator('#bot-msg-rc-message-9981.bot-agent-activity');
    await row.scrollIntoViewIfNeeded();
    assert.match(await row.innerText(), /实现检查.*发来问题/s);
    assert.equal(await row.locator('svg').count(), 2);
    const tone = await row.locator('.bot-agent-marker').getAttribute('data-tone');
    marker ??= tone; assert.equal(marker, tone);
    assert.equal(await row.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({path: path.join(captureDirectory, `agent-activity-${width}-${appearance}.png`), animations: 'disabled'});
    await row.focus(); await page.keyboard.press('Enter');
    const detail = page.locator('.bot-task-detail'); await detail.waitFor();
    await until(() => detail.innerText(), text => text.includes('实现检查') && text.includes('等待主 Bot 答复'));
    assert.doesNotMatch(await detail.innerText(), /需要你的选择/);
    await page.screenshot({path: path.join(captureDirectory, `agent-activity-detail-${width}-${appearance}.png`), animations: 'disabled'});
    await page.getByRole('button', {name: '关闭', exact: true}).click();
    await detail.waitFor({state: 'hidden'});
    await page.locator('.bot-drawer-body').waitFor({state: 'hidden'});
    await page.locator('.pa-overlay-backdrop--drawer').waitFor({state: 'hidden'});
    cases.push({width, appearance, named: true, svg: true, stableIdentity: true, taskDestination: true, humanWaitDistinct: true, fits: true});
  }
  writeFileSync(commandFile + '.next', JSON.stringify({...initial, seq: command.seq + 1})); renameSync(commandFile + '.next', commandFile);
  report.agentActivity = {cases, scope: 'Production renderer and IPC with explicit isolated Agent facts; communication/Runner execution tested separately'};
}
