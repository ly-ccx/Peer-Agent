import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openReplyDetails, closeReplyDetails, selectBotByName, wheelBotConversation } from './bot-reply-details-checks.mjs';
import {
  FIRST_PARAGRAPH, PRIVATE_REASONING, RETRY_INPUT, SECOND_PARAGRAPH,
  STOP_INPUT, STREAM_INPUT, STREAM_REPLY, WORK_INPUT,
} from './bot-shell-native-model-fixture.mjs';

const tray = page => page.locator('.bot-composer textarea');
const thread = page => page.locator('.bot-thread');
const liveReply = page => page.locator('.bot-live-reply').last();

async function submit(page, text) {
  const composer = tray(page);
  await composer.fill(text);
  await composer.press('Enter');
}

function history(home, bot) {
  return jsonLines(path.join(home, 'conversations', bot.conversationId + '.jsonl'));
}

function jsonLines(file) {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function wireRequests(model, scenario) {
  return model.requests.filter(request => request.scenario === scenario);
}

export async function checkNativeBotStreaming({ page, model, until, report, captureDirectory }) {
  await submit(page, STREAM_INPUT);
  await until(() => model.streaming(STREAM_INPUT), Boolean);
  model.send(STREAM_INPUT, FIRST_PARAGRAPH);
  const live = liveReply(page);
  const first = live.getByText(FIRST_PARAGRAPH, { exact: true });
  await first.waitFor();
  await first.evaluate(node => { globalThis.rcFirstNativeParagraph = node; });
  const turnId = await live.getAttribute('data-turn-id');
  assert.ok(turnId);
  model.send(STREAM_INPUT, '\n\n' + SECOND_PARAGRAPH);
  await live.getByText(SECOND_PARAGRAPH, { exact: true }).waitFor();
  assert.equal(await first.evaluate(node => {
    const original = globalThis.rcFirstNativeParagraph;
    delete globalThis.rcFirstNativeParagraph;
    return node === original;
  }), true, 'a new paragraph must not remount the preceding one');
  assert.equal(await live.getAttribute('data-turn-id'), turnId);
  assert.equal(await first.evaluate(node => node.getAnimations().filter(animation => animation.playState === 'running').length), 0);
  assert.doesNotMatch(await thread(page).innerText(), new RegExp(PRIVATE_REASONING));
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const originalViewport = page.viewportSize();
  for (const [width, theme] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const geometry = await first.evaluate(node => ({
      fits: node.scrollWidth <= node.clientWidth,
      hasSurface: getComputedStyle(node.closest('.bot-reply-body')).backgroundColor !== 'rgba(0, 0, 0, 0)',
    }));
    assert.deepEqual(geometry, { fits: true, hasSurface: true });
    await live.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `conversation-updates-${theme}.png`) });
  }
  if (originalViewport) await page.setViewportSize(originalViewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, originalTheme);
  await openReplyDetails(page, live);
  const details = page.locator('.bot-reply-details');
  assert.doesNotMatch(await details.innerText(), new RegExp(PRIVATE_REASONING));
  await wheelBotConversation(page, -400);
  const latest = page.getByRole('button', { name: '回到最新消息', exact: true });
  await latest.waitFor();
  const readingTop = await thread(page).evaluate(node => node.scrollTop);
  model.send(STREAM_INPUT, '\n\n' + STREAM_REPLY);
  await until(async () => (await details.innerText()).includes('项目概况') ||
    (await live.count()) > 0 && (await live.innerText()).includes('项目概况'), Boolean);
  assert.ok(Math.abs(await thread(page).evaluate(node => node.scrollTop) - readingTop) < 2, 'streamed content preserves the reading position');
  assert.equal(await details.isVisible(), true);
  await closeReplyDetails(page);
  if (await latest.isVisible()) await latest.click();
  model.finish(STREAM_INPUT);
  const completed = thread(page).locator('article[data-kind="agent_reply"]').filter({ hasText: '项目概况' });
  await completed.getByText('开始修改前，先核对项目规则。', { exact: true }).waitFor();
  assert.equal(await completed.count(), 1);
  assert.equal(await completed.locator('li').count(), 2);
  assert.match(await completed.innerText(), new RegExp(FIRST_PARAGRAPH));
  assert.equal(wireRequests(model, STREAM_INPUT).length, 1);
  report.nativeStreaming = { turnId, dispatches: 1, incrementalParagraphs: true, keptParagraphIdentity: true, readingPositionPreserved: true,
    noPrivateReasoning: true, markdownDelivered: true };
  report.checks.push('Rust SSE renders incrementally, retains paragraph identity, hides private reasoning and commits one Markdown reply');
}

async function retry(page, bot, turnId) {
  const receipt = await page.evaluate(
    ({ workspaceId, turnId }) => window.peerAgent.projectAgentRetry({ workspaceId, turnId }),
    { workspaceId: bot.workspaceId, turnId },
  );
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
}

export async function checkNativeBotRetry({ page, model, until, report, bot, home, captureDirectory }) {
  await submit(page, RETRY_INPUT);
  const failure = thread(page).locator('.bot-unavailable-reply').last();
  await failure.waitFor();
  const original = await until(() => history(home, bot).findLast(row =>
    row.card === 'agent_unavailable' && row.content?.includes('RC controlled provider rejection')), Boolean);
  assert.ok(original.turnId);
  assert.equal(original.meta?.httpStatus, 400);
  assert.equal(wireRequests(model, RETRY_INPUT).length, 1);
  await failure.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'native-retry-failed.png') });
  await selectBotByName(page, 'project-001');
  await selectBotByName(page, 'project-000');
  assert.equal(wireRequests(model, RETRY_INPUT).length, 1, 'conversation re-entry must not replay a rejected turn');

  await thread(page).and(page.locator('[aria-busy="false"]')).waitFor();
  const retryButton = page.locator(`[data-card-id="card:agent_unavailable:${original.turnId}"]`)
    .getByRole('button', { name: '继续尝试', exact: true });
  await retryButton.click();
  const expected = 'RC scripted reply: ' + RETRY_INPUT;
  await thread(page).getByText(expected, { exact: true }).waitFor();
  const rows = history(home, bot);
  const inputs = rows.filter(row => row.kind === 'user_input' && row.content === RETRY_INPUT);
  const replies = rows.filter(row => row.kind === 'agent_reply' && row.content === expected);
  assert.equal(inputs.length, 1);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].replyTo, [inputs[0].id]);
  assert.notEqual(replies[0].turnId, original.turnId);
  assert.equal(wireRequests(model, RETRY_INPUT).length, 2);
  report.nativeManualRetry = { originalTurnId: original.turnId, replyId: replies[0].id, inputId: inputs[0].id, dispatches: 2 };
  report.checks.push('manual retry through real preload IPC and Rust requeues the same input after a provider error and commits one replacement reply');
}

export async function checkNativeBotStop({ page, model, until, report, bot, home, captureDirectory }) {
  await submit(page, STOP_INPUT);
  await until(() => model.streaming(STOP_INPUT), Boolean);
  model.send(STOP_INPUT, FIRST_PARAGRAPH);
  await liveReply(page).getByText(FIRST_PARAGRAPH, { exact: true }).waitFor();
  const composer = tray(page);
  const draft = '停止后保留这份草稿';
  await composer.fill(draft);
  const stop = page.getByRole('button', { name: '停止生成', exact: true });
  await composer.focus();
  for (let step = 0; step < 12 && !await stop.evaluate(node => document.activeElement === node); step++) {
    await page.keyboard.press('Tab');
  }
  assert.equal(await stop.evaluate(node => document.activeElement === node && node.matches(':focus-visible')), true);
  assert.equal(await stop.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
  await stop.press('Enter');
  const stopped = thread(page).locator('.bot-stopped-reply').last();
  await stopped.getByText('生成已停止，以上内容未完成', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), draft);
  assert.equal(await stop.count(), 0);
  await until(() => wireRequests(model, STOP_INPUT)[0]?.disconnected, Boolean);
  const original = await until(() => history(home, bot).findLast(row => row.card === 'agent_stopped'), Boolean);
  assert.ok(original.turnId);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'stream-stopped.png') });
  await selectBotByName(page, 'project-001');
  await selectBotByName(page, 'project-000');
  assert.equal(wireRequests(model, STOP_INPUT).length, 1);
  await stopped.waitFor();
  assert.equal(await composer.inputValue(), draft);
  await retry(page, bot, original.turnId);
  const expected = 'RC scripted reply: ' + STOP_INPUT;
  await thread(page).getByText(expected, { exact: true }).waitFor();
  const rows = history(home, bot);
  const inputs = rows.filter(row => row.kind === 'user_input' && row.content === STOP_INPUT);
  const replies = rows.filter(row => row.kind === 'agent_reply' && row.content === expected);
  assert.equal(inputs.length, 1);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].replyTo, [inputs[0].id]);
  assert.equal(wireRequests(model, STOP_INPUT).length, 2);
  await composer.fill('');
  report.nativeStop = { originalTurnId: original.turnId, replyId: replies[0].id, stoppedOnWire: true, draftPreserved: true, dispatches: 2 };
  report.checks.push('keyboard stop cancels the physical SSE request, preserves the draft and requires explicit retry of the original input');
}

export async function checkNativeBotWork({ page, model, until, report, bot, home, captureDirectory }) {
  await selectBotByName(page, 'project-002');
  const composer = tray(page);
  await submit(page, WORK_INPUT);
  await thread(page).getByText('项目说明已核对，找到 RC_FIXTURE_OK。', { exact: true }).waitFor({ timeout: 40_000 });
  const child = await until(async () => {
    const result = await page.evaluate(workspaceId => window.peerAgent.projectAgentListSessions({ workspaceId }), bot.workspaceId);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.sessions.find(session => session.title === '核对项目说明');
  }, Boolean);
  assert.ok(model.requests.some(request => request.scenario.startsWith('Delegated Task: 核对项目说明')));
  const plan = JSON.parse(readFileSync(path.join(home, 'goal-plans', child.planId + '.json')));
  const rows = history(home, { conversationId: plan.delegationOrigin.workerConversationId });
  const reads = rows.flatMap(row => (row.segments || []).filter(segment => segment.type === 'tool-call' && segment.tool === 'read_file')
    .map(segment => ({ segment, grant: row.permissionGrants?.find(item => item.toolCallId === segment.toolCallId) })));
  assert.equal(reads.length, 1);
  const [{ segment, grant }] = reads;
  assert.equal(segment.result.status, 'success');
  assert.match(segment.result.output.content, /RC_FIXTURE_OK/);
  assert.equal(grant?.granted, true);
  const evidence = jsonLines(path.join(home, 'goal-plans', 'evidence-index.jsonl')).find(row => row.toolCallId === segment.toolCallId);
  assert.equal(evidence?.capabilityId, 'local.file.read');
  const reference = thread(page).locator(`.bot-reply-task-references [data-session-id="${child.sessionId}"]`).last();
  const original = '返回主会话后保留草稿';
  await composer.fill(original);
  await reference.focus();
  await page.keyboard.press('Enter');
  await page.locator('.bot-task-workspace').getByRole('heading', { name: '核对项目说明', exact: true }).waitFor();
  await page.screenshot({ path: path.join(captureDirectory, 'native-work-session.png') });
  await page.locator('.bot-crumb-parent').click();
  assert.equal(await composer.inputValue(), original);
  await composer.fill('');
  await selectBotByName(page, 'project-000');
  report.nativeWork = { sessionId: child.sessionId, evidenceRef: evidence.evidenceRef, grantId: grant.grantId,
    realRead: true, reported: true, openedOriginalTask: true, draftPreserved: true };
  report.checks.push('a real delegated worker reads the fixture file, reports through a host wake and opens its original task surface');
}
