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
      actions: [{ id: 'answer', channel: 'project-agent:submit-input', payload: { text: '只核对可读取的记录', answerTo: 'card:question:reply:rc-task-question' } }] }] };
  let conversationMessages = [note];
  const states = ['running', 'waiting_user', 'result_ready', 'accepted', 'failed', 'queued', 'paused', 'cancelled'];
  const change = (status, unavailable = false, reportReadMode = 'ready') => {
    const command = { ...initial, seq: ++seq, unavailable, reportReadMode, sessions: [{ ...task, status, statusLabel: '' }], conversationMessages,
      detailReports: { [task.sessionId]: { summary: instructions, evidenceRefs: ['tool-result://actual-record'] } } };
    writeFileSync(commandFile + '.next', JSON.stringify(command)); renameSync(commandFile + '.next', commandFile);
  };
  const open = async (reset = false) => {
    await page.locator('.bot-profile').click();
    await page.getByRole('tab', { name: '任务', exact: true }).click();
    if (reset && await page.locator('.bot-task-detail').count()) await page.getByRole('button', { name: '任务列表', exact: true }).click();
    if (!await page.locator('.bot-task-detail').count()) await page.locator('.bot-task-row').filter({ hasText: task.title }).click();
    const pendingQuestion = conversationMessages.at(-1).cards?.find(card => card.kind === 'question' && card.resolvedState !== 'resolved');
    if (pendingQuestion) await until(() => page.locator('.bot-task-question').innerText(), text => text === pendingQuestion.content);
    else await until(() => page.locator('.bot-task-update-preview').innerText(), text => text.includes(noteHeadline));
  };
  change('running', false, 'unavailable'); await open(true);
  const detail = page.locator('.bot-task-detail');
  const reportFeedback = detail.locator('.bot-task-report-read');
  const reportInfo = detail.locator('.bot-task-information');
  const captureReport = async name => {
    await reportFeedback.scrollIntoViewIfNeeded();
    assert.equal(await reportInfo.getAttribute('open'), '', 'report feedback remains expanded before capture');
    // A tall element capture can resize the native viewport and remount the
    // responsive drawer. Capture the real window without changing its layout.
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, name) });
    assert.equal(await reportInfo.getAttribute('open'), '', 'capture never changes the report disclosure');
  };
  await reportInfo.locator(':scope > summary').click();
  await reportFeedback.getByText('任务资料暂时无法读取，请重试。', { exact: true }).waitFor();
  await captureReport('task-report-unavailable.png');
  const turnsBeforeReportRetry = readTurns();
  change('running', false, 'waiting');
  await reportFeedback.getByRole('button', { name: '重试', exact: true }).click();
  await until(() => reportFeedback.getAttribute('aria-busy'), value => value === 'true');
  await reportFeedback.getByText('正在读取任务资料…', { exact: true }).waitFor();
  await captureReport('task-report-loading.png');
  change('running');
  await until(() => detail.locator('.bot-task-instructions').textContent(), text => text.includes(instructions));
  await until(() => reportFeedback.locator('p').count(), count => count === 0);
  change('queued', false, 'unavailable');
  await reportFeedback.getByText('任务资料暂时无法更新，以下为上次读取的内容。', { exact: true }).waitFor();
  assert.ok((await detail.locator('.bot-task-instructions').textContent()).includes(instructions));
  assert.equal(await detail.getAttribute('data-status'), 'queued', 'a cached report cannot rewind live status');
  await captureReport('task-report-stale.png');
  change('queued');
  await reportFeedback.getByRole('button', { name: '重试', exact: true }).click();
  await until(() => reportFeedback.locator('p').count(), count => count === 0);
  assert.equal(readTurns(), turnsBeforeReportRetry, 'reading or retrying task information never opens a model turn');
  await reportInfo.locator(':scope > summary').click();
  change('running');
  await until(() => detail.getAttribute('data-status'), value => value === 'running');
  const botName = await page.locator('.bot-convo-header .bot-convo-title').count()
    ? await page.locator('.bot-convo-header .bot-convo-title').innerText() : await page.locator('.bot-message-author span').last().innerText();
  const dimensions = [];
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const status of states) {
    change(status);
    await until(() => detail.getAttribute('data-status'), value => value === status);
    const expectedGroup = status === 'waiting_user' || status === 'result_ready' ? '需要你'
      : status === 'running' ? '进行中' : status === 'queued' ? '排队'
      : status === 'paused' ? '已暂停' : '已结束';
    await detail.getByRole('button', { name: '任务列表', exact: true }).click();
    assert.equal(await page.locator('.bot-tasks-section').filter({ has: page.locator('.bot-task-row').filter({ hasText: task.title }) })
      .locator('.bot-tasks-heading h2').innerText(), expectedGroup, `task classification: ${status}`);
    await page.locator('.bot-task-row').filter({ hasText: task.title }).click();
    await until(() => detail.locator('.bot-task-instructions').textContent(), text => text.includes(instructions));
    const visible = await detail.innerText();
    if (status === 'waiting_user' || status === 'result_ready') {
      assert.match(await detail.locator('.bot-task-status').innerText(), status === 'waiting_user' ? /等待跟进/ : /结果待确认/);
      assert.doesNotMatch(visible, /需要你处理|查看并处理/);
    }
    assert.doesNotMatch(visible, /internal-source-message-id|internal-execution-model-id|tool-result:\/\/|冻结的模型|锚点|打开现场|list_files|write_file|internal-branch/);
    const ended = status === 'accepted' || status === 'cancelled';
    if (ended) {
      assert.match(visible, /继续追问[\s\S]*询问结果[\s\S]*由你确认发送/);
      assert.ok(!visible.includes(`下一步由 ${botName} 跟进`));
    } else {
      assert.ok(visible.includes(`下一步由 ${botName} 跟进`));
      assert.match(visible, /提出具体问题[\s\S]*由你确认发送/);
    }
    assert.ok(visible.includes(noteHeadline));
    const previewSize = await detail.locator('.bot-task-update-preview').evaluate(node => ({ height: node.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(node).lineHeight) }));
    assert.ok(previewSize.height <= previewSize.lineHeight * 3 + 1, 'a long multi-paragraph Markdown reply stays a three-line preview');
    assert.equal(await detail.locator('.bot-task-update-preview button').count(), 0, 'the preview never creates hidden Markdown actions');
    assert.equal(await detail.locator('.bot-task-information').getAttribute('open'), null);
    if (['running', 'waiting_user', 'accepted', 'failed'].includes(status)) await detail.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `task-detail-${status}.png`) });
  }
  const beforeEndedFollowUp = readTurns();
  await detail.getByRole('button', { name: `向 ${botName} 追问`, exact: true }).click();
  const endedComposer = page.locator('.bot-composer textarea');
  await until(() => endedComposer.inputValue(), text => text.includes('结果和判断依据'));
  assert.doesNotMatch(await endedComposer.inputValue(), /卡住|下一步/);
  assert.equal(readTurns(), beforeEndedFollowUp, 'following up on an ended task prepares a result question without execution');
  await endedComposer.fill('');
  await page.getByRole('button', { name: '取消引用', exact: true }).click();
  await open();
  change('failed', true);
  await until(() => detail.getAttribute('data-status'), value => value === 'unavailable');
  assert.match(await detail.locator('.bot-task-status').innerText(), /状态暂不可用/);
  change('waiting_user'); await until(() => detail.getAttribute('data-status'), value => value === 'waiting_user');
  const information = detail.locator('.bot-task-information');
  await until(() => information.textContent(), text => text.includes(instructions));
  await information.locator('summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await information.getAttribute('open'), '');
  // The open attribute precedes the animated details content becoming readable.
  await until(() => information.innerText(), text => text.replace(/\s+/g, ' ').includes(instructions.replace(/\s+/g, ' ')));
  assert.match(await information.innerText(), /internal-source-message-id|tool-result:\/\/actual-record/);
  assert.equal(await information.locator('summary svg').count(), 1);
  await page.keyboard.press('Enter'); assert.equal(await information.getAttribute('open'), null);
  await information.locator(':scope > summary').click();
  await detail.locator('.bot-task-scene').click();
  const nestedScene = page.locator('.conversation-chat-drawer--nested');
  await nestedScene.waitFor();
  await page.keyboard.press('Escape');
  await nestedScene.waitFor({ state: 'detached' });
  assert.equal(await detail.isVisible(), true, 'Escape dismisses the nested scene and keeps the task detail open');
  await information.locator(':scope > summary').click();
  task.title = '逐条核对本项目跨月份的历史 AI 任务、交付结果与验证依据，并整理可追溯的完成情况';
  change('waiting_user'); await until(() => detail.locator('h2').innerText(), title => title === task.title);
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 900 });
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
      await until(() => detail.evaluate(node => node.getBoundingClientRect().right <= innerWidth), Boolean);
      assert.equal(await detail.evaluate(node => node.scrollWidth <= node.clientWidth), true);
      const size = await detail.evaluate(node => ({ width: node.clientWidth, backWidth: node.querySelector('.bot-task-back').getBoundingClientRect().width }));
      assert.ok(size.backWidth < size.width / 2);
      dimensions.push({ viewportWidth: width, appearance, ...size });
      await detail.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `task-detail-${width}-${appearance}.png`) });
    }
  }
  await page.setViewportSize(viewport); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  const beforeNavigation = readTurns();
  await detail.getByRole('button', { name: '查看对话中的完整说明', exact: true }).click();
  await until(() => page.locator('.bot-drawer-dock.is-open').count(), count => count === 0);
  const noteRow = page.locator('#bot-msg-rc-task-note'); await noteRow.waitFor();
  await until(() => noteRow.evaluate(node => document.activeElement === node), Boolean);
  await until(() => page.locator('.bot-drawer-dock').count(), count => count === 0);
  assert.equal(await noteRow.isVisible(), true);
  assert.equal(await noteRow.locator('.markdown-content').getAttribute('data-selection-source'), note.content, 'the full related reply remains available in the main conversation');
  assert.equal(readTurns(), beforeNavigation, 'reading the related bot note does not execute anything');
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'task-main-note.png') });
  await open();
  const composer = page.locator('.bot-composer textarea');
  await detail.getByRole('button', { name: `询问 ${botName} 进展`, exact: true }).click();
  await until(() => composer.inputValue(), text => text.includes(task.title));
  assert.equal(await composer.evaluate(node => document.activeElement === node), true);
  assert.equal(readTurns(), beforeNavigation, 'follow-up is a draft, never automatically submitted');
  assert.match(await page.locator('.bot-composer').innerText(), /逐条核对本项目/);
  await until(() => page.locator('.bot-drawer-dock').count(), count => count === 0);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'task-follow-up-draft.png') });
  await page.getByRole('button', { name: '取消引用', exact: true }).click();
  await composer.fill('保留我正在写的消息');
  await open(); await detail.getByRole('button', { name: `询问 ${botName} 进展`, exact: true }).click();
  assert.equal(await composer.inputValue(), '保留我正在写的消息');
  assert.equal(await page.getByRole('button', { name: '取消引用', exact: true }).count(), 0, 'existing draft is not silently associated with another task');
  await composer.fill('');
  const quoteRemove = page.getByRole('button', { name: '取消引用', exact: true });
  if (await quoteRemove.count()) await quoteRemove.click();
  conversationMessages = [note, question]; change('waiting_user'); await open();
  await until(() => detail.locator('.bot-task-question').innerText(), text => text === question.cards[0].content);
  assert.equal(await detail.getByRole('button', { name: `询问 ${botName} 进展`, exact: true }).count(), 0);
  await detail.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'task-decision.png') });
  await detail.getByRole('button', { name: '在对话中回答', exact: true }).focus(); await page.keyboard.press('Enter');
  const answer = page.locator('#bot-msg-rc-task-question .bot-question button').first();
  await until(() => answer.evaluate(node => document.activeElement === node), Boolean);
  await until(() => page.locator('.bot-drawer-dock').count(), count => count === 0);
  assert.equal(await answer.isVisible(), true);
  assert.equal(readTurns(), beforeNavigation, 'locating a decision does not answer, confirm or resume the task');
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'task-main-question.png') });
  conversationMessages = [note, { ...question, cards: question.cards.map(card => ({ ...card, resolvedState: 'resolved' })) }];
  change('waiting_user'); await page.locator('.bot-profile').click();
  await until(() => detail.locator('.bot-task-question').count(), count => count === 0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  writeFileSync(commandFile + '.next', JSON.stringify({ ...initial, seq: ++seq, conversationMessages })); renameSync(commandFile + '.next', commandFile);
  report.taskDetails = { states: [...states, 'unavailable'], dimensions, reportFromDetail: true, metadataCollapsed: true,
    reportReadFailureExplained: true, reportLoadingVisible: true, staleReportPreserved: true, reportRetryRecovers: true,
    nestedEscapeRetainsTask: true,
    primaryActionReturnsToBot: true, listClassification: true, internalInstructionsHidden: true, relatedNoteLocated: true,
    followUpDraftFocused: true, existingDraftPreserved: true, concreteQuestionLocated: true, noAutomaticExecution: true,
    scope: 'Production renderer and IPC with isolated session and main-conversation fixtures; no real model or task approval' };
}
