import { openReplyDetails, closeReplyDetails } from './bot-reply-details-checks.mjs';
import { checkBotEvidence } from './bot-evidence-checks.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

/** Disposable main-side session facts, delivered through the production read and notification IPC. */
export async function checkBotWorkSurfaces({ page, until, report, captureDirectory, commandFile }) {
  const checks = report.workSurfaces = [];
  const reply = page.locator('#bot-msg-rc-message-9999');
  await reply.scrollIntoViewIfNeeded();
  await reply.locator('.bot-reply-body').click();
  const context = page.locator('.bot-reply-details');
  assert.equal(await reply.locator('.bot-reply-context > button').innerText(), '查看详情');
  assert.equal(await reply.locator('.bot-work-row, .bot-evidence-list').count(), 0);
  assert.equal(await reply.locator('.bot-reply-marks > button').count(), 0);
  await openReplyDetails(page, reply);
  const work = context.locator('.bot-work-row');
  await work.waitFor({ state: 'attached' });
  const backgroundSummary = page.locator('.bot-background-work > summary');
  assert.match(await backgroundSummary.textContent(), /核查历史任务完成情况[\s\S]*正在运行中/);
  assert.equal(await backgroundSummary.isVisible(), true);
  assert.equal(await page.locator('.bot-background-work').getAttribute('open'), null);
  assert.equal(await backgroundSummary.locator('.is-running').evaluate(node => getComputedStyle(node).animationName), 'motion-shimmer');
  checks.push('collapsed background summary exposes named running work before any expansion');
  await closeReplyDetails(page);
  await checkBackgroundWorkAlignment({ page, report, captureDirectory });
  await openReplyDetails(page, reply);
  assert.match(await work.locator(':scope > summary').textContent(), /核查历史任务完成情况.*正在运行中/);
  assert.equal(await work.locator('.is-running').evaluate(node => getComputedStyle(node).animationName), 'motion-shimmer');
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
  assert.doesNotMatch(await reply.locator('.bot-reply-bar').innerText(), /rc-message-/);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'work-running.png') });
  checks.push('named running work scans visibly and expands by keyboard to its actual progress');

  const initial = JSON.parse(readFileSync(commandFile, 'utf8'));
  let seq = initial.seq;
  const change = (sessions, unavailable = false) => {
    writeFileSync(commandFile + '.next', JSON.stringify({ ...initial, seq: ++seq, sessions, unavailable }));
    renameSync(commandFile + '.next', commandFile);
  };
  change([{ ...initial.sessions[0], status: 'verifying', report: { summary: '已完成' } }]);
  await until(() => work.getAttribute('data-status'), value => value === 'verifying');
  assert.match(await work.locator(':scope > summary').innerText(), /核验中/);
  assert.equal(await work.locator('.bot-work-detail > p').first().innerText(), '正在核对执行结果，结束后会在对话中告诉你。');
  assert.doesNotMatch(await work.innerText(), /已完成/);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'work-verifying.png') });
  report.verificationPresentation = { currentPhaseWins: true };
  change([{ ...initial.sessions[0], status: 'waiting_user', report: { summary: '需要确认是否只使用可读取的历史记录。' } }]);
  await until(() => work.getAttribute('data-status'), value => value === 'waiting_user');
  assert.doesNotMatch(await work.innerText(), /正在核对执行结果/);
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
  await backgroundSummary.focus(); await page.keyboard.press('Enter');
  const backgroundWork = page.locator('.bot-background-work .bot-work-row');
  const nestedSummary = backgroundWork.locator(':scope > summary');
  await until(() => nestedSummary.evaluate(node => node.checkVisibility()), Boolean);
  await nestedSummary.focus();
  assert.equal(await nestedSummary.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  await until(() => backgroundWork.innerText(), text => /等待跟进[\s\S]*主对话/.test(text));
  assert.match(await backgroundWork.innerText(), /等待跟进[\s\S]*主对话/);
  assert.doesNotMatch(await backgroundWork.innerText(), /需要你处理|查看并处理/);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'work-waiting.png') });
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
  await page.locator('.bot-task-detail').waitFor();
  await page.getByRole('button', { name: '查看对话中的完整说明', exact: true }).click();
  await until(() => page.locator('.bot-drawer-dock.is-open').count(), count => count === 0);
  assert.equal(await page.locator('.bot-composer textarea').isVisible(), true);
  checks.push('waiting work stays a factual status in reply and background; named main bot owns follow-up, optional detail returns to main dialogue');
  report.delegatedWorkHandoff = { reply: true, background: true, noDirectHandling: true, detailReturnsToBot: true, hintChecks };
  // The detail visit remembers Tasks; restore Overview for the following evidence-return case.
  await page.locator('.bot-profile').click();
  await page.getByRole('tab', { name: '概况', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await openReplyDetails(page, reply);
  change([{ ...initial.sessions[0], status: 'result_ready' }]);
  await until(() => work.getAttribute('data-status'), value => value === 'result_ready');
  assert.match(await work.locator(':scope > summary').innerText(), /结果待确认/);
  assert.doesNotMatch(await work.innerText(), /查看并处理/);
  assert.match(await work.locator('.bot-work-hint').innerText(), /主对话/);
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
  await page.locator('.bot-profile').click();
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
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  checks.push('memory starts with saved content, keeps settings and provenance on demand and contains no process view');
  checks.push('memory filter controls fit their columns with visible spacing at 1280px and 760px in both themes');

  await openReplyDetails(page, reply);
  await context.waitFor();
  assert.equal(await page.locator('.bot-memory-tab, .bot-overview-tab').count(), 0);
  await closeReplyDetails(page);
  await page.locator('.bot-profile').click();
  await page.getByRole('tab', { name: '概况', exact: true }).click();
  await page.locator('.bot-overview-identity').waitFor();
  assert.equal(await page.getByRole('tab', { name: '概况', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.bot-turn-process').count(), 0);
  await until(() => page.locator('.bot-drawer-dock').evaluate(node =>
    node.classList.contains('is-open') && node.getBoundingClientRect().width >=
      parseFloat(getComputedStyle(node).getPropertyValue('--pa-drawer-width'))), Boolean);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.bot-drawer-body').waitFor({ state: 'hidden' });
  checks.push('reply detail sidebar isolates process from bot profile; the Archive entry opens bot overview');

  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.setViewportSize({ width: 760, height: 780 });
  await reply.scrollIntoViewIfNeeded();
  for (const value of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, value);
    assert.equal(await reply.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `work-narrow-${value}.png`) });
  }
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  await page.setViewportSize(viewport);
  if (await page.getByRole('button', { name: '关闭', exact: true }).isVisible()) await closeReplyDetails(page);
  checks.push('classified reply and delegated work fit a 760px viewport in both themes');
}

async function checkBackgroundWorkAlignment({ page, report, captureDirectory }) {
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const background = page.locator('.bot-background-work');
  const summary = background.locator(':scope > summary');
  const cases = report.backgroundWorkLayout = [];
  try {
    for (const width of [1600, 1280, 760]) {
      await page.setViewportSize({ width, height: 860 });
      for (const appearance of ['dark', 'light']) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
        for (const expanded of [false, true]) {
          if ((await background.getAttribute('open') !== null) !== expanded) {
            await summary.focus();
            await page.keyboard.press('Enter');
          }
          const bounds = await background.evaluate(node => {
            const region = node.getBoundingClientRect();
            const composer = document.querySelector('.bot-composer').getBoundingClientRect();
            const content = node.querySelector(':scope > summary').getBoundingClientRect();
            const child = node.querySelector('.bot-delegated-work').getBoundingClientRect();
            const reply = document.querySelector('#bot-msg-rc-message-9999').closest('.bot-thread-row');
            const replyBounds = reply.getBoundingClientRect();
            const author = reply.querySelector('.bot-message-author').getBoundingClientRect();
            return { left: region.left, right: region.right, composerLeft: composer.left, composerRight: composer.right,
              replyLeft: replyBounds.left, replyRight: replyBounds.right, authorLeft: author.left,
              contentFits: content.left >= region.left - 1 && content.right <= region.right + 1,
              expandedFits: !node.open || (child.left >= region.left - 1 && child.right <= region.right + 1) };
          });
          assert.ok(Math.abs(bounds.left - bounds.composerLeft) <= 1 && Math.abs(bounds.right - bounds.composerRight) <= 1,
            `background task and composer edges must align: ${width}/${appearance}/${expanded}: ${JSON.stringify(bounds)}`);
          assert.ok(bounds.contentFits && bounds.expandedFits, 'background task contents must fit the shared column');
          assert.ok(Math.abs(bounds.replyLeft - bounds.composerLeft) <= 1 && Math.abs(bounds.authorLeft - bounds.composerLeft) <= 1
            && Math.abs(bounds.replyRight - bounds.composerRight) <= 1,
            `completed reply, task and composer must share a column: ${width}/${appearance}/${expanded}: ${JSON.stringify(bounds)}`);
          cases.push({ width, appearance, expanded, ...bounds, aligned: true });
          if ((width === 1600 && appearance === 'dark' && !expanded) || (width === 760 && appearance === 'light' && expanded)) {
            const region = await background.boundingBox();
            const composer = await page.locator('.bot-composer').boundingBox();
            await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `background-work-${width}-${appearance}.png`),
              clip: { x: region.x - 16, y: region.y - 8, width: region.width + 32,
                height: composer.y + composer.height - region.y + 16 } });
          }
        }
      }
    }
  } finally {
    if (await background.getAttribute('open') !== null) await summary.click();
    await page.setViewportSize(viewport);
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  }
  report.workSurfaces.push('background task and composer share both edges when collapsed and expanded at 1600/1280/760px in both themes');
}
