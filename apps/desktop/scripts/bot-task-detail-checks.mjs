import { openTaskInspector, openWorkPanel, taskEntry } from './bot-work-panel-checks.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

/** Test the destination, next actor and concrete decision, beyond just opening a drawer. */
export async function checkBotTaskDetails({ page, until, report, captureDirectory, commandFile, readTurns }) {
  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  let seq = initial.seq;
  const task = { ...initial.sessions[0], sessionId: initial.sessions[0].sessionId + '-report-read', conversationId: 'rc-task-scene-empty', report: undefined, origin: { anchorMessageId: 'internal-source-message-id',
    modelSelection: { worker: { modelId: 'internal-execution-model-id' } } } };
  const instructions = '只读核对历史任务的目标、完成结果和判断依据。\n只使用 list_files / read_file，禁止 bash / write_file。\n分支：internal-branch，提交：' + 'a'.repeat(40);
  const noteHeadline = '核查未通过：部分历史记录缺少可核对的结果依据。我会整理已有记录，并将无法确认的部分单独标明。';
  const note = { id: 'rc-task-note', kind: 'agent_reply', role: 'assistant', sources: [task.sessionId], createdAt: new Date(Date.now() + 10000).toISOString(),
    content: noteHeadline + '\n\n**核对范围**：保留任务目标、报告、结果引用和完成判断之间的关联。`README.md`、`AGENTS.md` 与历史报告提供背景，已有文件记录必须与具体断言对应。\n\n**后续安排**：我会逐条整理可读取的记录，对缺少原文或验证结果的部分标注无法确认，并区分已完成、部分完成和执行受阻。原任务保持现状，整理后在主对话汇报；需要你补充信息时，我会提出具体问题。不得把任务数量直接当作已完成数量，也不能把报告中的目标当作完成结论。NOTE_FULL_END' };
  const question = { ...note, id: 'rc-task-question', content: '有两条记录无法读取。你希望只核对可读取的记录，还是补充这些记录后再继续？',
    cards: [{ cardId: 'card:question:reply:rc-task-question', kind: 'question', content: '只核对可读取的记录，还是补充记录后继续？', resolvedState: 'open',
      refs: { sessionId: task.sessionId },
      actions: [{ id: 'answer', channel: 'project-agent:submit-input', payload: { text: '只核对可读取的记录', answerTo: 'card:question:reply:rc-task-question' } }] }] };
  let conversationMessages = [note];
  const states = ['running', 'waiting_user', 'result_ready', 'accepted', 'failed', 'queued', 'paused', 'cancelled'];
  const change = (status, unavailable = false, reportReadMode = 'ready') => {
    const command = { ...initial, seq: ++seq, unavailable, reportReadMode, sessions: [{ ...task, status, statusLabel: '' }], conversationMessages,
      detailReports: { [task.sessionId]: { summary: instructions, evidenceRefs: ['tool-result://actual-record'] } } };
    writeFileSync(commandFile + '.next', JSON.stringify(command)); renameSync(commandFile + '.next', commandFile);
  };
  const detail = page.locator('.bot-task-workspace');
  const parent = page.locator('.bot-crumb-parent');
  const inspector = detail.getByRole('complementary', { name: '任务详情', exact: true });
  const scope = inspector.getByRole('tab', { name: '边界与信息', exact: true });
  const brief = inspector.getByRole('tab', { name: '说明', exact: true });
  const reportFeedback = inspector.locator('.bot-task-report-read');
  const taskInstructions = inspector.locator('.bot-inspector-brief-text');
  const open = async (source = 'board') => {
    const row = await taskEntry(page, task, { source });
    await row.click();
    await detail.getByRole('heading', { name: task.title, exact: true }).waitFor();
    await openTaskInspector(page);
    const latest = conversationMessages.at(-1);
    const pendingQuestion = latest.cards?.find(card => card.kind === 'question' && card.resolvedState !== 'resolved');
    if (pendingQuestion) await until(() => inspector.locator('.bot-task-question').innerText(), text => text === pendingQuestion.content);
    else await until(() => inspector.locator('.bot-task-update-preview').innerText(), text => text.startsWith(latest.content.split('\n')[0]));
  };
  const captureReport = async name => {
    await reportFeedback.scrollIntoViewIfNeeded();
    assert.equal(await brief.getAttribute('aria-selected'), 'true');
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, name) });
    assert.equal(await brief.getAttribute('aria-selected'), 'true', 'capture retains the task brief');
  };
  change('running', false, 'unavailable'); await open();
  await reportFeedback.getByText('任务资料暂时无法读取，请重试。', { exact: true }).waitFor();
  await captureReport('task-report-unavailable.png');
  const turnsBeforeReportRetry = readTurns();
  change('running', false, 'waiting');
  await reportFeedback.getByRole('button', { name: '重试', exact: true }).click();
  await until(() => reportFeedback.getAttribute('aria-busy'), value => value === 'true');
  await reportFeedback.getByText('正在读取任务资料…', { exact: true }).waitFor();
  await captureReport('task-report-loading.png');
  change('running');
  await until(() => taskInstructions.textContent(), text => text.includes(instructions));
  await until(() => reportFeedback.count(), count => count === 0);
  change('queued', false, 'unavailable');
  await reportFeedback.getByText('任务资料暂时无法更新，以下为上次读取的内容。', { exact: true }).waitFor();
  assert.ok((await taskInstructions.textContent()).includes(instructions));
  assert.equal(await detail.getAttribute('data-status'), 'queued', 'a cached report cannot rewind live status');
  await captureReport('task-report-stale.png');
  change('queued');
  await reportFeedback.getByRole('button', { name: '重试', exact: true }).click();
  await until(() => reportFeedback.count(), count => count === 0);
  assert.equal(readTurns(), turnsBeforeReportRetry, 'reading or retrying task information never opens a model turn');
  const botName = (await parent.innerText()).trim();
  const dimensions = [];
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const status of states) {
    const historical = ['paused', 'cancelled'].includes(status);
    const needsUser = ['waiting_user', 'result_ready'].includes(status);
    const lane = ({ running: 'doing', waiting_user: 'needsYou', result_ready: 'needsYou', accepted: 'delivered',
      failed: 'needsYou', queued: 'todo' })[status];
    change(status);
    await until(() => detail.getAttribute('data-status'), value => value === status);
    await parent.click();
    await detail.waitFor({ state: 'hidden' });
    const boardRow = await taskEntry(page, task);
    if (historical) {
      await boardRow.waitFor({ state: 'detached' });
    } else {
      await boardRow.waitFor();
      assert.equal(await boardRow.evaluate(node => node.closest('[data-lane]').dataset.lane), lane);
      assert.equal(await boardRow.getAttribute('data-needs-user'), String(needsUser));
    }
    const source = historical || status === 'failed' ? 'history' : needsUser ? 'active' : 'board';
    const row = source === 'board' ? boardRow : await taskEntry(page, task, { source });
    await row.click();
    await until(() => detail.getAttribute('data-status'), value => value === status);
    assert.equal(await inspector.count(), 0, 'task selection starts with the inspector closed');
    assert.equal(await page.getByRole('button', { name: '任务详情', exact: true }).getAttribute('aria-expanded'), 'false');
    const scene = detail.locator('.bot-task-conversation-stage .bot-inline-scene');
    assert.equal(await scene.isVisible(), true, 'full worker conversation is available before inspecting details');
    assert.doesNotMatch(await detail.innerText(), /核验结果|下一步由|继续追问|任务信息|创建于|internal-|list_files|write_file/);
    if (['running', 'waiting_user', 'accepted', 'failed'].includes(status)) await page.screenshot({
      animations: 'disabled', path: path.join(captureDirectory, `task-detail-${status}.png`),
    });
    await openTaskInspector(page);
    const visible = await detail.innerText();
    if (status === 'waiting_user' || status === 'result_ready') {
      assert.match(await detail.locator('.bot-task-status-pill').innerText(), status === 'waiting_user' ? /等待跟进/ : /结果待确认/);
      assert.doesNotMatch(visible, /需要你处理|查看并处理/);
    }
    assert.doesNotMatch(visible, /internal-source-message-id|internal-execution-model-id|tool-result:\/\/|冻结的模型|锚点|打开现场/);
    const ended = status === 'accepted' || status === 'cancelled';
    if (ended) {
      assert.match(visible, /继续追问[\s\S]*询问结果[\s\S]*由你确认发送/);
      assert.ok(!visible.includes(`下一步由 ${botName} 跟进`));
    } else {
      assert.ok(visible.includes(`下一步由 ${botName} 跟进`));
      assert.match(visible, /提出具体问题[\s\S]*由你确认发送/);
    }
    assert.ok(visible.includes(noteHeadline));
    const preview = inspector.locator('.bot-task-update-preview');
    const previewSize = await preview.evaluate(node => ({ height: node.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(node).lineHeight) }));
    assert.ok(previewSize.height <= previewSize.lineHeight * 3 + 1, 'a long multi-paragraph Markdown reply stays a three-line preview');
    assert.equal(await preview.locator('button').count(), 0, 'the preview never creates hidden Markdown actions');
    assert.equal(await scope.getAttribute('aria-selected'), 'false');
  }
  const beforeEndedFollowUp = readTurns();
  await detail.getByRole('button', { name: `向 ${botName} 追问`, exact: true }).click();
  const endedComposer = page.locator('.bot-composer textarea');
  await until(() => endedComposer.inputValue(), text => text.includes('结果和判断依据'));
  assert.doesNotMatch(await endedComposer.inputValue(), /卡住|下一步/);
  assert.equal(readTurns(), beforeEndedFollowUp, 'following up on an ended task prepares a result question without execution');
  await endedComposer.fill('');
  await page.getByRole('button', { name: '取消引用', exact: true }).click();
  await open('history');
  change('failed', true);
  await until(() => detail.getAttribute('data-status'), value => value === 'unavailable');
  assert.match(await detail.locator('.bot-task-status-pill').innerText(), /状态暂不可用/);
  change('waiting_user'); await until(() => detail.getAttribute('data-status'), value => value === 'waiting_user');
  await until(() => taskInstructions.textContent(), text => text.includes(instructions));
  await scope.focus(); await page.keyboard.press('Enter');
  assert.equal(await scope.getAttribute('aria-selected'), 'true');
  assert.match(await inspector.innerText(), /internal-source-message-id|tool-result:\/\/actual-record/);
  await brief.focus(); await page.keyboard.press('Enter');
  assert.equal(await scope.getAttribute('aria-selected'), 'false');
  const scene = detail.locator('.bot-task-conversation-stage .bot-inline-scene');
  const sceneIdentity = await scene.elementHandle();
  assert.equal(await scene.getAttribute('role'), null, 'the worker conversation is part of the nonmodal workspace');
  assert.equal(await scene.evaluate(node => Boolean(node.closest('.bot-task-workspace')) && !node.closest('.bot-drawer-dock')), true);
  await page.setViewportSize({ width: 760, height: 900 });
  await inspector.locator('.bot-inspector-head button').focus(); await page.keyboard.press('Escape');
  await inspector.waitFor({ state: 'hidden' });
  assert.equal(await scene.evaluate((node, previous) => node === previous && node.isConnected, sceneIdentity), true,
    'closing the inspector keeps the open worker conversation and task');
  await openTaskInspector(page);
  assert.equal(await scene.evaluate((node, previous) => node === previous, sceneIdentity), true);
  assert.equal(await scene.count(), 1, 'reopening task details does not duplicate the worker conversation');
  await sceneIdentity.dispose();
  task.title = '逐条核对本项目跨月份的历史 AI 任务、交付结果与验证依据，并整理可追溯的完成情况';
  change('waiting_user'); await until(() => detail.getByRole('heading', { name: task.title, exact: true }).innerText(), title => title === task.title);
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 900 });
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
      await until(() => detail.evaluate(node => node.getBoundingClientRect().right <= innerWidth), Boolean);
      assert.equal(await detail.evaluate(node => node.scrollWidth <= node.clientWidth), true);
      const size = await detail.evaluate(node => ({ width: node.clientWidth, backWidth: node.closest('.bot-main-thread').querySelector('.bot-crumb-parent').getBoundingClientRect().width }));
      assert.ok(size.backWidth < size.width / 2);
      dimensions.push({ viewportWidth: width, appearance, ...size });
      await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `task-detail-${width}-${appearance}.png`) });
    }
  }
  await page.setViewportSize(viewport); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  const beforeNavigation = readTurns();
  await detail.getByRole('button', { name: '查看对话中的完整说明', exact: true }).click();
  await until(() => detail.count(), count => count === 0);
  const noteRow = page.locator('#bot-msg-rc-task-note'); await noteRow.waitFor();
  await until(() => noteRow.evaluate(node => document.activeElement === node), Boolean);
  await until(() => detail.count(), count => count === 0);
  assert.equal(await noteRow.isVisible(), true);
  assert.equal(await noteRow.locator('.markdown-content').getAttribute('data-selection-source'), note.content, 'the full related reply remains available in the main conversation');
  assert.equal(readTurns(), beforeNavigation, 'reading the related bot note does not execute anything');
  await openWorkPanel(page);
  const workRows = page.locator('.bot-work-panel-session');
  assert.ok(await workRows.count(), 'default work rows are visible beside the main note');
  assert.doesNotMatch((await workRows.allTextContents()).join(' '), /waiting_user|internal-execution-model-id/);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'task-main-note.png') });
  await open('active');
  const composer = page.locator('.bot-composer textarea');
  await detail.getByRole('button', { name: `询问 ${botName} 进展`, exact: true }).click();
  await until(() => composer.inputValue(), text => text.includes(task.title));
  assert.equal(await composer.evaluate(node => document.activeElement === node), true);
  assert.equal(readTurns(), beforeNavigation, 'follow-up is a draft, never automatically submitted');
  assert.match(await page.locator('.bot-composer').innerText(), /逐条核对本项目/);
  await until(() => detail.count(), count => count === 0);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'task-follow-up-draft.png') });
  await page.getByRole('button', { name: '取消引用', exact: true }).click();
  await composer.fill('保留我正在写的消息');
  await open('active'); await detail.getByRole('button', { name: `询问 ${botName} 进展`, exact: true }).click();
  assert.equal(await composer.inputValue(), '保留我正在写的消息');
  assert.equal(await page.getByRole('button', { name: '取消引用', exact: true }).count(), 0, 'existing draft is not silently associated with another task');
  await composer.fill('');
  const quoteRemove = page.getByRole('button', { name: '取消引用', exact: true });
  if (await quoteRemove.count()) await quoteRemove.click();
  conversationMessages = [note, question]; change('waiting_user');
  const boardQuestion = await taskEntry(page, task);
  await until(() => boardQuestion.innerText(), text => text.includes(question.cards[0].content));
  await boardQuestion.focus(); await page.keyboard.press('Enter');
  const answer = page.locator('#bot-msg-rc-task-question .bot-question button').first();
  await until(() => answer.evaluate(node => document.activeElement === node), Boolean);
  assert.equal(readTurns(), beforeNavigation, 'the matter board opens the question without answering it');
  await open('active');
  await until(() => detail.locator('.bot-task-question').innerText(), text => text === question.cards[0].content);
  assert.equal(await detail.getByRole('button', { name: `询问 ${botName} 进展`, exact: true }).count(), 0);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'task-decision.png') });
  await detail.getByRole('button', { name: '在对话中回答', exact: true }).focus(); await page.keyboard.press('Enter');
  await until(() => answer.evaluate(node => document.activeElement === node), Boolean);
  await until(() => detail.count(), count => count === 0);
  assert.equal(await answer.isVisible(), true);
  const answerFocus = await answer.evaluate(node => {
    const style = getComputedStyle(node);
    return { visible: node.matches(':focus-visible'), width: style.outlineWidth, offset: style.outlineOffset };
  });
  assert.deepEqual(answerFocus, { visible: true, width: '2px', offset: '-2px' },
    'keyboard focus remains inside the clipped question card');
  assert.equal(readTurns(), beforeNavigation, 'locating a decision does not answer, confirm or resume the task');
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'task-main-question.png') });
  conversationMessages = [note, { ...question, cards: question.cards.map(card => ({ ...card, resolvedState: 'resolved' })) }];
  change('waiting_user'); await open('active');
  await until(() => detail.locator('.bot-task-question').count(), count => count === 0);
  await parent.click();
  writeFileSync(commandFile + '.next', JSON.stringify({ ...initial, seq: ++seq, conversationMessages })); renameSync(commandFile + '.next', commandFile);
  report.taskDetails = { states: [...states, 'unavailable'], dimensions, reportFromDetail: true, metadataCollapsed: true,
    reportReadFailureExplained: true, reportLoadingVisible: true, staleReportPreserved: true, reportRetryRecovers: true,
    nestedEscapeRetainsTask: true,
    primaryActionReturnsToBot: true, listClassification: true, internalInstructionsHidden: true, relatedNoteLocated: true,
    followUpDraftFocused: true, existingDraftPreserved: true, concreteQuestionLocated: true, noAutomaticExecution: true,
    scope: 'Production renderer and IPC with isolated session and main-conversation fixtures; no real model or task approval' };
}
