import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

/** Disposable main-side session facts, delivered through the production read and notification IPC. */
export async function checkBotWorkSurfaces({ page, until, report, captureDirectory, commandFile }) {
  const checks = report.workSurfaces = [];
  const reply = page.locator('#bot-msg-rc-message-9999');
  await reply.scrollIntoViewIfNeeded();
  const context = reply.locator('.bot-reply-context');
  if (await context.getAttribute('open') !== null) await context.locator(':scope > summary').click();
  assert.equal(await context.locator('button').first().isVisible(), false);
  assert.equal(await reply.locator('.bot-reply-marks > button').count(), 0);
  assert.match(await context.locator(':scope > summary').textContent(), /结果依据 · 20 条记录/);
  const work = reply.locator('.bot-work-row');
  await work.waitFor();
  assert.match(await work.locator(':scope > summary').textContent(), /核查历史任务完成情况.*正在运行中/);
  assert.equal(await work.locator('.is-running').evaluate(node => getComputedStyle(node).animationName), 'motion-shimmer');
  await work.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  assert.match(await work.innerText(), /逐条核对历史记录/);
  await reply.locator('.bot-reply-body').click();
  assert.doesNotMatch(await reply.locator('.bot-reply-bar').innerText(), /rc-message-/);
  await reply.screenshot({ path: path.join(captureDirectory, 'work-running.png') });
  checks.push('named running work scans visibly and expands by keyboard to its actual progress');

  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  let seq = initial.seq;
  const change = (sessions, unavailable = false) => {
    writeFileSync(commandFile + '.next', JSON.stringify({ ...initial, seq: ++seq, sessions, unavailable }));
    renameSync(commandFile + '.next', commandFile);
  };
  change([{ ...initial.sessions[0], status: 'waiting_user', report: { summary: '需要确认是否只使用可读取的历史记录。' } }]);
  await until(() => work.getAttribute('data-status'), value => value === 'waiting_user');
  assert.match(await work.innerText(), /需要你处理/);
  assert.equal(await work.locator('.is-running').count(), 0);
  assert.equal(await work.getByRole('button', { name: '查看并处理', exact: true }).isVisible(), true);
  await reply.screenshot({ path: path.join(captureDirectory, 'work-waiting.png') });
  change([{ ...initial.sessions[0], status: 'accepted' }]);
  await until(() => work.getAttribute('data-status'), value => value === 'accepted');
  assert.match(await work.locator(':scope > summary').textContent(), /已签收/);
  assert.equal(await page.locator('.bot-background-work').count(), 0);
  change([]);
  await until(() => work.getAttribute('data-status'), value => value === 'unavailable');
  assert.match(await work.innerText(), /状态暂不可用/);
  checks.push('main-side notifications update running to waiting, accepted and unavailable; old reply snapshots never revive running');
  change(initial.sessions);
  await until(() => work.getAttribute('data-status'), value => value === 'running');
  change(initial.sessions, true);
  await until(() => work.getAttribute('data-status'), value => value === 'unavailable');
  assert.equal(await work.locator('.is-running').count(), 0);
  assert.equal(await page.locator('.bot-background-work').count(), 0);
  change(initial.sessions);
  await until(() => work.getAttribute('data-status'), value => value === 'running');
  await work.locator(':scope > summary').click();

  await context.locator(':scope > summary').click();
  assert.equal(await context.locator('.bot-evidence-list li').count(), 20);
  await context.getByRole('button', { name: '证据 1', exact: true }).click();
  await page.locator('.bot-inspect').waitFor();
  assert.equal(await page.locator('.bot-drawer-body [role=tablist]').count(), 0);
  assert.equal(await page.locator('.bot-drawer-pane').count(), 0);
  assert.equal(await page.locator('.bot-inspect details[open]').count(), 0);
  await page.getByRole('button', { name: '返回 Bot 档案', exact: true }).click();
  await page.locator('.bot-overview-identity').waitFor();
  assert.equal(await page.locator('.bot-process').count(), 0);
  assert.match(await page.locator('.bot-overview-identity').innerText(), /负责这个项目的工作协调/);
  await page.locator('.bot-drawer-body').screenshot({ path: path.join(captureDirectory, 'bot-overview.png') });
  checks.push('evidence has its own detail view; returning shows bot identity and responsibility, with no execution log');

  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.locator('.bot-memory-list').waitFor();
  assert.equal(await page.locator('.bot-process, .bot-inspect').count(), 0);
  assert.equal(await page.locator('.bot-memory-controls').getAttribute('open'), null);
  assert.equal(await page.locator('.bot-memory-tab').evaluate(node => node.querySelector('.bot-memory-section').compareDocumentPosition(node.querySelector('.bot-memory-controls')) & Node.DOCUMENT_POSITION_FOLLOWING), 4);
  const provenance = page.locator('.bot-memory-provenance').first();
  assert.equal(await provenance.getAttribute('open'), null);
  await provenance.locator('summary').click();
  assert.equal(await provenance.getAttribute('open'), '');
  await provenance.locator('summary').click();
  await page.locator('.bot-drawer-body').screenshot({ path: path.join(captureDirectory, 'bot-memory.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  checks.push('memory starts with saved content, keeps settings and provenance on demand and contains no process view');

  await context.getByRole('button', { name: '查看过程', exact: true }).click();
  await page.locator('.bot-process').waitFor();
  assert.equal(await page.locator('.bot-memory-tab, .bot-overview-tab').count(), 0);
  await page.getByRole('button', { name: '返回 Bot 档案', exact: true }).click();
  await page.locator('.bot-memory-tab').waitFor();
  assert.equal(await page.getByRole('tab', { name: '记忆', exact: true }).evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('.bot-process').count(), 0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  checks.push('process is isolated from profile tabs and returns to the previous memory tab');

  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.setViewportSize({ width: 760, height: 780 });
  await reply.scrollIntoViewIfNeeded();
  for (const value of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, value);
    assert.equal(await reply.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await reply.screenshot({ path: path.join(captureDirectory, `work-narrow-${value}.png`) });
  }
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.setViewportSize(viewport);
  await context.locator(':scope > summary').click();
  checks.push('classified reply and delegated work fit a 760px viewport in both themes');
  await checkTaskDetail({ page, until, checks, captureDirectory, initial, change });
}

async function checkTaskDetail({ page, until, checks, captureDirectory, initial, change }) {
  const project = await page.evaluate(workspaceId => window.peerAgent.projectAgentGet({ workspaceId }), initial.workspaceId);
  const conversation = await page.evaluate(workspacePath => window.peerAgent.conversationsCreate({
    title: '任务详情隔离验收', workspacePath, mode: 'chat',
  }), project.path);
  const task = { ...initial.sessions[0], title: '只读核实并统计本项目历史 AI 任务',
    status: 'waiting_user', statusLabel: '执行受阻', conversationId: conversation.id,
    spawnedAt: new Date().toISOString(), origin: { anchorMessageId: 'input-f82a5ead-c5a7-4e3d-aaff-070beabaec0d',
      modelSelection: { worker: { modelId: 'gpt-6.1-sol' } } }, report: { summary: '', evidenceRefs: [] } };
  change([task]);
  await page.locator('.bot-profile').click();
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.locator('.bot-task-row', { hasText: task.title }).click();
  const detail = page.locator('.bot-session-detail');
  const drawer = page.locator('.bot-drawer-body');
  await until(() => detail.getAttribute('data-status'), value => value === 'waiting_user');
  assert.equal(await detail.locator('.bot-session-info').getAttribute('open'), null);
  assert.doesNotMatch(await detail.innerText(), /input-f82|gpt-6|还没有|冻结|锚点/);
  assert.equal(await detail.locator('.bot-session-empty').count(), 1);
  assert.match(await detail.locator('.bot-session-progress').innerText(), /执行受阻.*打开工作会话/s);
  assert.equal(await detail.locator('.bot-session-open svg').count(), 2);
  const backSize = await detail.locator('.bot-session-back').boundingBox();
  const actionSize = await detail.locator('.bot-session-open').boundingBox();
  assert.ok(backSize.width < 150 && backSize.height >= 32);
  assert.ok(actionSize.width < 240 && actionSize.height >= 32);
  checks.push('task detail prioritizes factual progress and one compact action; IDs/model stay collapsed and one report empty state remains');

  const appearance = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme,
    fontScale: document.documentElement.dataset.fontScale, palette: document.documentElement.dataset.palette }));
  const viewport = page.viewportSize();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.palette = 'frost'; }, theme);
    await detail.locator('.bot-session-open').hover();
    await until(() => detail.locator('.bot-session-open').evaluate(node => {
      const style = getComputedStyle(node);
      const rgb = value => (value.match(/[\d.]+/g) ?? []).map(Number);
      const luminance = color => color.slice(0, 3).map(value => value / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
        .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
      const fg = rgb(style.color), bg = rgb(style.backgroundColor);
      const levels = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      return { opaque: bg.length === 3 || bg[3] === 1, ratio: (levels[0] + .05) / (levels[1] + .05) };
    }), paint => paint.opaque && paint.ratio >= 4.5);
    await detail.locator('.bot-session-back').hover();
    await drawer.screenshot({ path: path.join(captureDirectory, `task-detail-blocked-${theme}.png`), animations: 'disabled' });
  }
  await detail.locator('.bot-session-info > summary').focus();
  await page.keyboard.press('Enter');
  assert.match(await detail.innerText(), /gpt-6\.1-sol/);
  assert.match(await detail.innerText(), /input-f82/);
  await drawer.screenshot({ path: path.join(captureDirectory, 'task-detail-info.png') });
  await page.keyboard.press('Enter');
  assert.equal(await detail.locator('.bot-session-info').getAttribute('open'), null);
  await detail.locator('.bot-session-open').click();
  await page.locator('.conversation-chat-drawer--nested .chat-surface').waitFor();
  assert.equal((await page.evaluate(id => window.peerAgent.conversationsGet({ id }), conversation.id)).id, conversation.id);
  await page.keyboard.press('Escape');
  await page.locator('.conversation-chat-drawer--nested').waitFor({ state: 'detached' });
  assert.equal(await detail.locator('.bot-session-open').evaluate(node => node === document.activeElement), true);
  checks.push('task information expands with SVG by keyboard; the existing conversation opens and Escape restores focus');

  for (const status of ['running', 'result_ready', 'accepted', 'failed', 'cancelled', 'paused', 'superseded', 'starting', 'queued']) {
    change([{ ...task, status, statusLabel: '', report: { summary: '已整理可读取的记录，缺失材料对应事项仍无法确认。',
      evidenceRefs: ['rc-detail-evidence-1', 'rc-detail-evidence-1', 'rc-detail-evidence-2'] } }]);
    await until(() => detail.getAttribute('data-status'), value => value === status);
    assert.doesNotMatch(await detail.locator('.bot-session-progress').innerText(), /\brunning\b|result_ready|superseded|\bqueued\b/);
    assert.match(await detail.locator('.bot-session-report').innerText(), /2 条依据记录/);
    assert.equal(await detail.locator('.bot-session-empty').count(), 0);
    if (status !== 'accepted') assert.doesNotMatch(await detail.locator('.bot-session-status').innerText(), /已签收/);
    if (status === 'result_ready') assert.equal(await detail.locator('.bot-session-open').innerText(), '查看结果');
    if (status === 'accepted') await drawer.screenshot({ path: path.join(captureDirectory, 'task-detail-accepted.png') });
  }
  await detail.locator('.bot-session-info > summary').click();
  await detail.locator('.bot-session-evidence > summary').click();
  assert.equal(await detail.locator('.bot-session-evidence li').count(), 2);
  await detail.locator('.bot-session-info > summary').click();
  change([{ ...task, status: 'running', statusLabel: '正在核查历史记录' }], true);
  await until(() => detail.getAttribute('data-status'), value => value === 'unavailable');
  assert.doesNotMatch(await detail.locator('.bot-session-progress').innerText(), /正在核查历史记录/);
  checks.push('live task states preserve result/acceptance distinctions, deduplicate references and suppress stale progress when facts become unavailable');

  change([{ ...task, conversationId: '' }]);
  await until(() => detail.getAttribute('data-status'), value => value === 'waiting_user');
  await detail.getByText('尚未建立可打开的工作会话。', { exact: true }).waitFor();
  assert.equal(await detail.locator('.bot-session-open').count(), 0);
  checks.push('missing conversation has an explanation instead of a dead disabled action');

  change([task]);
  await detail.locator('.bot-session-open').waitFor();
  await page.setViewportSize({ width: 760, height: 780 });
  await page.evaluate(() => { document.documentElement.dataset.fontScale = 'large'; document.documentElement.dataset.theme = 'dark'; });
  assert.equal(await detail.evaluate(node => node.scrollWidth <= node.clientWidth), true);
  assert.equal(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await drawer.screenshot({ path: path.join(captureDirectory, 'task-detail-narrow-large.png'), animations: 'disabled' });
  await detail.locator('.bot-session-back').click();
  await page.locator('.bot-task-row', { hasText: task.title }).waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(original => {
    for (const key of ['theme', 'fontScale', 'palette']) {
      if (original[key] === undefined) delete document.documentElement.dataset[key];
      else document.documentElement.dataset[key] = original[key];
    }
  }, appearance);
  if (viewport) await page.setViewportSize(viewport);
  change(initial.sessions);
  checks.push('long task title, dark large type and a narrow drawer fit; compact back returns to the original task list');
}
