import { checkWorkPanelLayout, checkParallelPanelTasks, openWorkPanel } from './bot-work-panel-checks.mjs';
import { openFullTask, BOT_DETAIL_SURFACE, BOT_DETAIL_CLOSE } from './bot-detail-surface-selectors.mjs';
import { openReplyDetails, closeReplyDetails, scrollToBotMessage } from './bot-reply-details-checks.mjs';
import { checkBotEvidence } from './bot-evidence-checks.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { projectWorkSession } from '@peer-agent/protocol';

/** Disposable main-side session facts, delivered through the production read and notification IPC. */
export async function checkBotWorkSurfaces({ page, until, report, captureDirectory, commandFile }) {
  const checks = report.workSurfaces = [];
  const reply = page.locator('#bot-msg-rc-message-9999');
  await scrollToBotMessage(page, reply);
  await reply.locator('.bot-reply-body').click();

  const taskReference = reply.locator('.bot-reply-task-references button[data-session-id]');
  assert.equal(await taskReference.count(), 1);
  await taskReference.getByText('核查历史任务完成情况', { exact: true }).waitFor();
  assert.match(await taskReference.innerText(), /核查历史任务完成情况[\s\S]*回复时：正在运行中/);
  const referenceSessionId = await taskReference.getAttribute('data-session-id');
  const draftBeforeReference = await page.locator('.bot-composer textarea').inputValue();
  await taskReference.focus(); await page.keyboard.press('Enter');
  const referencedDetail = page.locator(BOT_DETAIL_SURFACE).locator('.bot-task-detail');
  await referencedDetail.waitFor({ state: 'visible' });
  assert.equal(await referencedDetail.locator('h2').innerText(), '核查历史任务完成情况');
  assert.equal(await referencedDetail.getAttribute('data-status'), 'running');
  assert.equal(await referencedDetail.locator('.bot-task-full').isVisible(), false);
  assert.equal(await referencedDetail.locator('.bot-task-full-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await referencedDetail.locator('.bot-task-scene').isVisible(), true);
  assert.match(await referencedDetail.innerText(), /打开完整会话/);
  assert.doesNotMatch(await referencedDetail.innerText(), /取消任务|创建于|核验结果/);
  await page.locator(BOT_DETAIL_CLOSE).click();
  await referencedDetail.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.bot-composer textarea').inputValue(), draftBeforeReference);
  await scrollToBotMessage(page, reply);
  report.replyTaskReferences = { sessionId: referenceSessionId, originalTaskOpened: true, recordedStateLabeled: true,
    defaultDetailsCollapsed: true, draftPreserved: true };
  checks.push('keyboard reply task reference opens the original task with compact progress and preserves the draft');

  const context = page.locator(BOT_DETAIL_SURFACE).locator('.bot-reply-details');
  assert.equal(await reply.getByRole('button', { name: '回复详情', exact: true }).innerText(), '回复详情');
  assert.equal(await reply.locator('.bot-work-row, .bot-evidence-list').count(), 0);
  assert.equal(await reply.locator('.bot-reply-marks > button').count(), 0);
  await openReplyDetails(page, reply);
  const work = context.locator('.bot-work-row');
  await work.waitFor({ state: 'attached' });
  await closeReplyDetails(page);
  await openWorkPanel(page);
  assert.equal(await page.locator('.bot-work-panel .bot-work-panel-session.is-task').count(), 1);
  assert.equal(await page.locator('.bot-work-panel .bot-work-panel-session.is-agent').count(), 1);
  checks.push('work panel separates the task and Agent views of current structured session facts');
  await checkWorkPanelLayout({ page, report, captureDirectory });
  await openReplyDetails(page, reply);
  assert.match(await work.locator(':scope > summary').textContent(), /核查历史任务完成情况.*正在运行中/);
  assert.equal(await work.locator('.is-running').evaluate(node => getComputedStyle(node).animationName), 'motion-shimmer');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await work.locator('.is-running').evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.notEqual(await work.locator('.is-running').evaluate(node => getComputedStyle(node).webkitTextFillColor), 'rgba(0, 0, 0, 0)');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await work.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  const keyboardFocus = await work.locator(':scope > summary').evaluate(node => {
    const style = getComputedStyle(node);
    return { visible: node.matches(':focus-visible'), width: style.outlineWidth,
      offset: parseFloat(style.outlineOffset), color: style.outlineColor,
      textColor: getComputedStyle(document.documentElement).getPropertyValue('--graphite-base').trim() };
  });
  assert.equal(keyboardFocus.visible, true);
  assert.equal(keyboardFocus.width, '1px');
  assert.ok(keyboardFocus.offset <= -1, 'keyboard outline fits inside the clipped task list');
  checks.push('keyboard work disclosure uses a thin inset focus indicator, without the clipped white frame');
  await until(() => work.innerText(), text => text.includes('逐条核对历史记录'));
  assert.match(await work.innerText(), /逐条核对历史记录/);
  assert.doesNotMatch(await reply.locator('.bot-reply-source').innerText(), /rc-message-/);
  await waitForWorkDisclosure(work, until);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'work-running.png') });
  checks.push('named running work scans visibly and expands by keyboard to its actual progress');

  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  let seq = initial.seq;
  const change = (sessions, unavailable = false) => {
    writeFileSync(commandFile + '.next', JSON.stringify({ ...initial, seq: ++seq, sessions, unavailable }));
    renameSync(commandFile + '.next', commandFile);
  };
  await closeReplyDetails(page);
  await checkParallelPanelTasks({ page, until, report, captureDirectory, change, initial });
  await openReplyDetails(page, reply);
  change([{ ...initial.sessions[0], status: 'verifying', report: { summary: '已完成' } }]);
  await until(() => work.getAttribute('data-status'), value => value === 'verifying');
  assert.match(await work.locator(':scope > summary').innerText(), /核验中/);
  assert.equal(await work.locator('.bot-work-detail > p').first().innerText(), '正在核对执行结果，结束后会在对话中告诉你。');
  assert.doesNotMatch(await work.innerText(), /已完成/);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'work-verifying.png') });
  report.verificationPresentation = { currentPhaseWins: true };
  const technical = projectWorkSession({ planId: 'technical-review', title: initial.sessions[0].title,
    status: 'executing', runnerStatus: 'blocked', blockedReason: 'Verification gate failed: quality:criterion_unverified' },
  { ...initial.sessions[0], origin: { ...initial.sessions[0].origin, phase: 'running' }, acceptance: 'confirm' });
  change([{ ...initial.sessions[0], ...technical, report: { summary: '独立复核未完成，主机器人正在检查原因。' } }]);
  await until(() => work.getAttribute('data-status'), value => value === 'waiting_agent');
  assert.match(await work.innerText(), /由主 Bot 跟进/);
  assert.doesNotMatch(await work.innerText(), /需要你的选择|需要你处理|确认已达成/);
  const repairViewport = page.viewportSize();
  const repairTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const [width, theme] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 860 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await work.scrollIntoViewIfNeeded();
    const statusUsesPrimaryText = await work.locator('.bot-work-status').evaluate(node => {
      const color = getComputedStyle(node).color;
      const reference = document.createElement('span');
      reference.style.color = 'var(--graphite-base)';
      node.parentElement.append(reference);
      try { return color === getComputedStyle(reference).color; }
      finally { reference.remove(); }
    });
    assert.ok(statusUsesPrimaryText, 'Bot-owned repair status uses readable primary text in both themes');
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `work-repair-${width}-${theme}.png`) });
  }
  await page.setViewportSize(repairViewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, repairTheme);
  report.verificationPresentation.technicalOwnedByBot = true;
  change([{ ...initial.sessions[0], status: 'waiting_user', followUp: { owner: 'bot', reason: 'technical_block', inCurrentList: true }, report: { summary: '需要确认是否只使用可读取的历史记录。' } }]);
  await until(() => work.getAttribute('data-status'), value => value === 'waiting_user');
  assert.doesNotMatch(await work.innerText(), /正在核对执行结果/);
  assert.match(await taskReference.innerText(), /回复时：正在运行中/, 'historical reply state must not change with the live task');
  report.replyTaskReferences.recordedStateRetained = true;
  report.verificationPresentation.exitsToFollowUp = true;
  assert.match(await work.locator(':scope > summary').innerText(), /等待跟进/);
  assert.doesNotMatch(await work.innerText(), /需要你处理|查看并处理/);
  assert.equal(await work.locator('.is-running').count(), 0);
  const followUpHint = await work.locator('.bot-work-hint').innerText();
  assert.match(followUpHint, /主对话[\s\S]*需要你决定/);
  const botName = await page.locator('.bot-convo-header .bot-convo-title').count()
    ? await page.locator('.bot-convo-header .bot-convo-title').innerText()
    : await page.locator('.bot-message-author span').last().innerText();
  assert.ok(followUpHint.includes(botName), 'handoff names the main bot responsible for follow-up');
  await closeReplyDetails(page);
  await openWorkPanel(page);
  const panelWork = page.locator('.bot-work-panel .bot-work-panel-session.is-task');
  await until(() => panelWork.innerText(), text => /等待跟进/.test(text));
  assert.doesNotMatch(await panelWork.innerText(), /需要你处理|查看并处理/);
  assert.equal(await panelWork.getAttribute('data-needs-user'), 'false');
  change([{ ...initial.sessions[0], status: 'waiting_user', followUp: { owner: 'user', reason: 'human_request', inCurrentList: true } }]);
  await until(() => panelWork.getAttribute('data-needs-user'), value => value === 'true');
  assert.match(await panelWork.innerText(), /需要你/);
  assert.equal(await page.locator('.bot-work-panel-toggle').getAttribute('data-needs-user'), 'true');
  change([{ ...initial.sessions[0], status: 'waiting_user', followUp: { owner: 'bot', reason: 'technical_block', inCurrentList: true }, report: { summary: '需要确认是否只使用可读取的历史记录。' } }]);
  await until(() => panelWork.getAttribute('data-needs-user'), value => value === 'false');
  report.workPanelOwnership = { hostOwner: true, botFollowUp: true, userRequest: true };
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'work-waiting.png') });
  await openReplyDetails(page, reply);
  const waitingViewport = page.viewportSize();
  const waitingTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const hintChecks = [];
  for (const appearance of ['dark', 'light']) {
    await page.setViewportSize({ width: 760, height: 860 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    await work.scrollIntoViewIfNeeded();
    const readability = await work.locator('.bot-work-hint').evaluate(node => {
      const luminance = rgb => {
        const values = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
      };
      const foreground = luminance(getComputedStyle(node).color);
      const background = luminance(getComputedStyle(node.parentElement).backgroundColor);
      const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      const bounds = node.getBoundingClientRect();
      const container = node.parentElement.getBoundingClientRect();
      return { contrast, fits: bounds.left >= container.left && bounds.right <= container.right,
        hintSize: parseFloat(getComputedStyle(node).fontSize),
        progressSize: parseFloat(getComputedStyle(node.parentElement.querySelector('p')).fontSize) };
    });
    assert.ok(readability.contrast >= 4.5 && readability.fits, 'follow-up explanation stays readable and fits the narrow row');
    assert.ok(readability.hintSize < readability.progressSize, 'explanation stays subordinate to progress');
    hintChecks.push({ appearance, ...readability });
    if (appearance === 'light') await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'work-waiting-760-light.png') });
  }
  await page.setViewportSize(waitingViewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, waitingTheme);
  await work.getByRole('button', { name: '查看任务详情', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.locator(BOT_DETAIL_SURFACE).locator('.bot-task-detail').waitFor();
  await openFullTask(page);
  await page.getByRole('button', { name: '查看对话中的完整说明', exact: true }).click();
  await until(() => page.locator(BOT_DETAIL_SURFACE).count(), count => count === 0);
  assert.equal(await page.locator('.bot-composer textarea').isVisible(), true);
  checks.push('waiting work stays a factual status in reply and the work panel; named main bot owns follow-up, optional detail returns to main dialogue');
  report.delegatedWorkHandoff = { reply: true, workPanel: true, noDirectHandling: true, detailReturnsToBot: true, hintChecks };
  // The detail visit remembers Tasks; restore Overview for the following evidence-return case.
  await page.getByRole('button', { name: '机器人设置', exact: true }).click();
  await page.getByRole('tab', { name: '概况', exact: true }).click();
  await page.locator(BOT_DETAIL_CLOSE).click();
  await openReplyDetails(page, reply);
  change([{ ...initial.sessions[0], status: 'result_ready' }]);
  await until(() => work.getAttribute('data-status'), value => value === 'result_ready');
  assert.match(await work.locator(':scope > summary').innerText(), /结果待确认/);
  assert.doesNotMatch(await work.innerText(), /查看并处理/);
  assert.match(await work.locator('.bot-work-hint').innerText(), /主对话/);
  change([{ ...initial.sessions[0], status: 'accepted' }]);
  await until(() => work.getAttribute('data-status'), value => value === 'accepted');
  assert.match(await work.locator(':scope > summary').textContent(), /已签收/);
  assert.equal(await page.locator('.bot-work-panel .bot-work-panel-session.is-task').count(), 0);
  change([]);
  await until(() => work.getAttribute('data-status'), value => value === 'unavailable');
  assert.match(await work.innerText(), /状态暂不可用/);
  checks.push('main-side notifications update running to waiting, accepted and unavailable; old reply snapshots never revive running');
  change(initial.sessions);
  await until(() => work.getAttribute('data-status'), value => value === 'running');
  change(initial.sessions, true);
  await until(() => work.getAttribute('data-status'), value => value === 'unavailable');
  assert.equal(await work.locator('.is-running').count(), 0);
  await closeReplyDetails(page); await openWorkPanel(page);
  await until(() => page.locator('.bot-work-panel-feedback').innerText(), text => /暂时|不可用/.test(text));
  assert.equal(await page.locator('.bot-work-panel-feedback button').count(), 1);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'work-panel-unavailable.png') });
  await openReplyDetails(page, reply);
  change(initial.sessions);
  await until(() => work.getAttribute('data-status'), value => value === 'running');
  await work.locator(':scope > summary').click();

  await openReplyDetails(page, reply);
  assert.equal(await context.locator('.bot-evidence-list li').count(), 20);
  await checkBotEvidence({page,until,report,captureDirectory,context});
  await context.locator('.bot-evidence-list button').first().click();
  await page.locator('.bot-inspect').waitFor();
  assert.equal(await page.locator('.bot-drawer-body [role=tablist]').count(), 0);
  assert.equal(await page.locator('.bot-drawer-pane').count(), 0);
  assert.equal(await page.locator('.bot-inspect details[open]').count(), 0);
  await page.getByRole('button', { name: '返回回复详情', exact: true }).click();
  await context.waitFor({ state: 'visible' });
  await until(() => context.evaluate(node => node.contains(document.activeElement)), Boolean);
  report.replyEvidenceReturn = { sameReply: true, focusInDetails: true };
  assert.equal(await context.locator('.bot-evidence-list li').count(), 20);
  await closeReplyDetails(page);
  await page.getByRole('button', { name: '机器人设置', exact: true }).click();
  await page.getByRole('tab', { name: '概况', exact: true }).click();
  await page.locator('.bot-overview-identity').waitFor();
  assert.equal(await page.locator('.bot-process').count(), 0);
  assert.match(await page.locator('.bot-overview-identity').innerText(), /负责这个项目的工作协调/);
  await page.locator('.bot-drawer-body').screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'bot-overview.png') });
  checks.push('evidence has its own detail view; returning shows bot identity and responsibility, with no execution log');

  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.locator('.bot-memory-list').waitFor();
  assert.equal(await page.locator('.bot-process, .bot-inspect').count(), 0);
  assert.equal(await page.locator('.bot-memory-controls').getAttribute('open'), null);
  assert.equal(await page.locator('.bot-memory-tab').evaluate(node => node.querySelector('.bot-memory-section').compareDocumentPosition(node.querySelector('.bot-memory-controls')) & Node.DOCUMENT_POSITION_FOLLOWING), 4);
  const provenance = page.locator('.bot-memory-provenance').first();
  for (const summary of [provenance.locator(':scope > summary'), page.locator('.bot-memory-controls > summary')]) {
    assert.equal(await summary.locator('svg').count(), 1);
    assert.equal(await summary.evaluate(node => getComputedStyle(node).listStyleType), 'none');
    assert.equal(await summary.evaluate(node => getComputedStyle(node, '::marker').content), '""');
  }
  assert.equal(await provenance.getAttribute('open'), null);
  await provenance.locator('summary').click();
  assert.equal(await provenance.getAttribute('open'), '');
  await provenance.locator('summary').click();
  const memoryViewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const memoryTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 780 });
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
      await until(() => page.locator('.bot-memory-filters').evaluate(node => node.getBoundingClientRect().right <= innerWidth), Boolean);
      const bounds = await page.locator('.bot-memory-filters').evaluate(node => {
        const region = node.getBoundingClientRect();
        const controls = [...node.querySelectorAll('.pa-dropdown-trigger')].map(control => {
          const rect = control.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        });
        return { left: region.left, right: region.right, controls };
      });
      assert.equal(bounds.controls.length, 3);
      assert.ok(bounds.controls.every(control => control.left >= bounds.left - 1 && control.right <= bounds.right + 1), 'memory filters must fit their own column');
      assert.ok(bounds.controls[2].left - bounds.controls[1].right >= 8, 'adjacent memory filters need visible spacing');
    }
  }
  await page.setViewportSize(memoryViewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, memoryTheme);
  await page.locator('.bot-drawer-body').screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'bot-memory.png') });
  await page.locator(BOT_DETAIL_CLOSE).click();
  checks.push('memory starts with saved content, keeps settings and provenance on demand and contains no process view');
  checks.push('memory filter controls fit their columns with visible spacing at 1280px and 760px in both themes');

  await openReplyDetails(page, reply);
  await context.waitFor();
  assert.equal(await page.locator('.bot-memory-tab, .bot-overview-tab').count(), 0);
  await closeReplyDetails(page);
  await page.getByRole('button', { name: '机器人设置', exact: true }).click();
  await page.getByRole('tab', { name: '概况', exact: true }).click();
  await page.locator('.bot-overview-identity').waitFor();
  assert.equal(await page.getByRole('tab', { name: '概况', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.bot-turn-process').count(), 0);
  await until(() => page.locator(BOT_DETAIL_SURFACE).evaluate(node =>
    node.getBoundingClientRect().width > 0 && !node.getAnimations({ subtree: true }).some(animation =>
      animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime))), Boolean);
  await page.locator(BOT_DETAIL_CLOSE).click();
  await page.locator(BOT_DETAIL_SURFACE).waitFor({ state: 'hidden' });
  checks.push('reply detail sidebar isolates process from bot profile; the Archive entry opens bot overview');

  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.setViewportSize({ width: 760, height: 780 });
  await scrollToBotMessage(page, reply);
  for (const value of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, value);
    assert.equal(await reply.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `work-narrow-${value}.png`) });
  }
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.setViewportSize(viewport);
  if (await page.locator(BOT_DETAIL_CLOSE).isVisible()) await closeReplyDetails(page);
  checks.push('classified reply and delegated work fit a 760px viewport in both themes');
}

async function waitForWorkDisclosure(work, until) {
  // Native details exposes its text before its clipping height has settled.
  await until(() => work.evaluate(node => {
    const style = getComputedStyle(node, '::details-content');
    const detail = node.querySelector('.bot-work-detail').getBoundingClientRect();
    const moving = node.getAnimations({ subtree: true }).some(animation =>
      Number.isFinite(animation.effect?.getComputedTiming().endTime)
      && (animation.playState === 'running' || animation.pending));
    return !moving && style.opacity === '1' && detail.bottom <= node.getBoundingClientRect().bottom + 1;
  }), Boolean);
}
