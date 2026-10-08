import { openReplyDetails, closeReplyDetails } from '../apps/desktop/scripts/bot-reply-details-checks.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { emitToolArgProgress } from '../packages/runtime-node/dist/index.js';

/** Controlled cognition only: exercises the actual executor, host, IPC and UI. */
export function createStreamingFixture({ commandFile, record, resolveGoalRole }) {
  const active = new Map(), attempts = new Map();
  return {
    resolveGoalRole,
    abort(streamId) { const turn = active.get(streamId); if (turn) turn.aborted = true; },
    async sendMessage(input) {
      const text = input.messages?.findLast(message => message.role === 'user')?.content || '';
      record('turns', { role: input.turnProfile?.role, workspaceId: input.turnProfile?.workspaceId });
      const interactive = input.turnProfile?.role === 'project_agent';
      if (interactive && input.plan?.kind === 'wake' && input.plan.events.some(event => event.eventId === 'rc-manual-retry-event')) {
        const turn = { aborted: false }; active.set(input.streamId, turn);
        const send = (channel, payload) => input.webContents.send(channel, { streamId: input.streamId, ...payload });
        try {
          const deadline = Date.now() + 30000;
          send('chat:stream:thinking', { content: 'PRIVATE_RETRY_THINKING' });
          send('chat:stream:delta', { content: '正在重试，我会接着核对已有进展。' });
          while (!turn.aborted && Date.now() < deadline) {
            const command = JSON.parse(readFileSync(commandFile, 'utf8'));
            if (command.scenario === 'RC_MANUAL_WAKE_RETRY' && command.phase >= 2) {
              send('chat:stream:tool-call', { tool: 'post_reply', toolCallId: 'wake-reply', args: { text: '重试完成，已有进展已保留。', replyTo: [] } });
              send('chat:stream:tool-result', { toolCallId: 'wake-reply', result: JSON.stringify({ ok: true }) });
              return { terminalStatus: 'done' };
            }
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          return { terminalStatus: 'aborted' };
        } finally { active.delete(input.streamId); }
      }
      if (interactive && text === 'RC_DETAIL_QUESTION') {
        const send = (channel, payload) => input.webContents.send(channel, { streamId: input.streamId, ...payload });
        const startedAtMs = Date.now();
        send('chat:stream:tool-call', { tool: 'list_sessions', toolCallId: 'sessions', args: {}, startedAtMs });
        send('chat:stream:tool-result', { toolCallId: 'sessions', startedAtMs, endedAtMs: startedAtMs + 240, result: JSON.stringify({ ok: true, sessions: [] }) });
        send('chat:stream:tool-call', { tool: 'read_file', toolCallId: 'timed-read', args: { path: 'README.md' }, startedAtMs });
        send('chat:stream:tool-result', { toolCallId: 'timed-read', startedAtMs, endedAtMs: startedAtMs + 2250, result: JSON.stringify({ ok: true, output: 'Known fixture duration' }) });
        send('chat:stream:tool-call', { tool: 'get_session', toolCallId: 'legacy-time', args: { sessionId: 'legacy' } });
        send('chat:stream:tool-result', { toolCallId: 'legacy-time', result: JSON.stringify({ ok: true, status: 'completed' }) });
        send('chat:stream:tool-call', { tool: 'post_reply', toolCallId: 'question', args: {
          text: '你希望统计哪类记录？', replyTo: input.turnProfile.context.inputAnchors.map(anchor => anchor.messageId),
          question: { options: ['这个应用里的历史聊天', '其它工具里的工作记录'] },
        } });
        send('chat:stream:tool-result', { toolCallId: 'question', result: JSON.stringify({ ok: true }) });
        return { terminalStatus: 'done' };
      }
      if (!interactive || !text.includes('RC_STREAM_')) {
        await new Promise(resolve => setTimeout(resolve, 120));
        return { terminalStatus: 'done', text: 'RC scripted reply: ' + text };
      }
      const attempt = (attempts.get(text) || 0) + 1; attempts.set(text, attempt);
      const turn = { aborted: false, text: '' }; active.set(input.streamId, turn);
      const sink = input.webContents, streamId = input.streamId;
      const send = (channel, payload) => { if (!turn.aborted) {
        if (channel === 'chat:stream:delta') turn.text += payload.content;
        sink.send(channel, { streamId, ...payload });
      } };
      const wait = async phase => {
        const deadline = Date.now() + 30000;
        while (!turn.aborted && Date.now() < deadline) {
          const command = JSON.parse(readFileSync(commandFile, 'utf8'));
          if (command.scenario === text && command.phase >= phase) return true;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (!turn.aborted) throw Error('Controlled stream was not advanced');
        return false;
      };
      const aborted = () => ({ terminalStatus: 'aborted', text: turn.text, toolCalls: [] });
      try {
        send('chat:stream:thinking', { content: 'PRIVATE_REASONING_MUST_NOT_RENDER' });
        if (!await wait(1)) return aborted();
        send('chat:stream:delta', { content: '我先看看项目的整体情况，整理好后告诉你重点。' });
        if (!await wait(1.5)) return aborted();
        send('chat:stream:delta', { content: '\n\n项目把界面和本地执行分开了，我再确认它们如何连接。' });
        if (!await wait(2)) return aborted();
        send('chat:stream:tool-call', { tool: 'read_file', toolCallId: 'read', args: { path: 'README.md', token: 'PRIVATE_PARAMETER_SECRET' } });
        if (!await wait(2.5)) return aborted();
        send('chat:stream:tool-result', { toolCallId: 'read', result: JSON.stringify({ ok: true, output: '# README fixture content\nThe desktop owns local execution; the interface presents its results. Changes are governed by project rules.', secret: 'PRIVATE_RESULT_SECRET' }) });
        send('chat:stream:delta', { content: '本地执行的结果会交回界面。修改前还需要遵循项目里的开发规则。' });
        const progress = {}, args = { text: '**项目概况**看清楚了。\n\n- 界面展示结果，本地负责执行能力。\n- 开始修改前，先核对项目规则。', replyTo: input.turnProfile.context.inputAnchors.map(anchor => anchor.messageId) };
        emitToolArgProgress(progress, { webContents: sink, streamId, toolCallId: 'reply', toolName: 'post_reply', argsJson: '{"text":"**项目概况**看' });
        if (!await wait(3)) return aborted();
        if (text.includes('FAIL') && attempt === 1) {
          send('chat:stream:error', { error: '受控连接失败' });
          return { terminalStatus: 'error', error: '受控连接失败' };
        }
        send('chat:stream:tool-call', { tool: 'post_reply', toolCallId: 'reply', args });
        send('chat:stream:tool-result', { toolCallId: 'reply', result: JSON.stringify({ ok: true }) });
        return { terminalStatus: 'done' };
      } finally { active.delete(streamId); }
    },
  };
}

export async function checkResponseInteraction({ page, until, report, captureDirectory, commandFile, workCommandFile = null }) {
  const checks = report.streamingInteraction = [];
  const command = (scenario, phase) => writeFileSync(commandFile, JSON.stringify({ scenario, phase }));
  const composer = page.locator('.bot-composer textarea'), live = page.locator('.bot-live-reply');
  const detail = page.locator('.bot-reply-details');
  const openDetails = target => openReplyDetails(page, target);
  const start = async scenario => {
    command(scenario, 0); await composer.fill(scenario); await composer.press('Enter');
    await live.waitFor(); await live.locator('.bot-context-running').waitFor();
  };
  await start('RC_STREAM_TEXT');
  // A pending reply has no bubble yet; the author and status still share the
  // composer column, including while a detail drawer narrows the conversation.
  const pendingViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const pendingTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  report.pendingReplyLayout = [];
  for (const width of [1600, 1280, 760]) {
    await page.setViewportSize({ width, height: 860 });
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
      for (const docked of width === 1280 ? [false, true] : [false]) {
        if (docked) {
          await openDetails(live);
          await until(() => page.locator('.bot-drawer-dock').evaluate(node =>
            node.classList.contains('is-open') && node.getBoundingClientRect().width >=
              parseFloat(getComputedStyle(node).getPropertyValue('--pa-drawer-width'))), Boolean);
        }
        const bounds = await live.evaluate(node => {
          const row = node.closest('.bot-thread-row');
          const box = element => { const { left, right } = element.getBoundingClientRect(); return { left, right }; };
          return { row: box(row), author: box(row.querySelector('.bot-message-author')),
            status: box(node.querySelector('.bot-reply-context')),
            composer: box(document.querySelector('.bot-composer')) };
        });
        assert.ok([bounds.row, bounds.author, bounds.status].every(box => Math.abs(box.left - bounds.composer.left) <= 1)
          && Math.abs(bounds.row.right - bounds.composer.right) <= 1,
          `pending reply and composer must share a column: ${JSON.stringify({ width, appearance, docked, ...bounds })}`);
        report.pendingReplyLayout.push({ width, appearance, docked, aligned: true, ...bounds });
        if ((width === 1600 && appearance === 'dark') || (width === 760 && appearance === 'light')
          || (width === 1280 && appearance === 'light' && docked)) {
          await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory,
            `pending-reply-${docked ? 'docked' : width}-${appearance}.png`) });
        }
        if (docked) await closeReplyDetails(page);
      }
    }
  }
  await page.setViewportSize(pendingViewport);
  await page.evaluate(value => { document.documentElement.dataset.theme = value; }, pendingTheme);
  const setDelegatedWork = status => {
    if (!workCommandFile) return;
    const snapshot = JSON.parse(readFileSync(workCommandFile, 'utf8'));
    writeFileSync(workCommandFile + '.next', JSON.stringify({ ...snapshot, seq: snapshot.seq + 1, sessions: [
      ...snapshot.sessions.filter(item => item.sessionId !== 'rc-work-stream'),
      {sessionId:'rc-work-stream',title:'核对项目说明',status,origin:{anchorMessageId:delegatedAnchor},report:{summary:'核对项目说明中的功能和当前实现。'}},
    ] }));
    renameSync(workCommandFile + '.next', workCommandFile);
  };
  let delegatedAnchor = '';
  if (workCommandFile) {
    delegatedAnchor = await page.locator('.bot-user').filter({ hasText: 'RC_STREAM_TEXT' }).getAttribute('id');
    delegatedAnchor = delegatedAnchor.slice('bot-msg-'.length);
    setDelegatedWork('running');
    await openDetails(live);
    const delegated = detail.locator('.bot-work-row'); await delegated.waitFor({ state: 'attached' });
    await delegated.locator(':scope > summary').click();
    assert.equal(await delegated.evaluate(node => node.open), true);
  }

  const user = page.locator('.bot-user').filter({ hasText: 'RC_STREAM_TEXT' });
  const layout = await user.evaluate(node => ({ content: node.querySelector('.bot-user-content').getBoundingClientRect().bottom, receipt: node.querySelector('.bot-user-marks').getBoundingClientRect().top }));
  assert.ok(layout.receipt >= layout.content);
  assert.equal(await live.locator('.bot-reply-bar').count(), 0);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'stream-waiting.png') });
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.setViewportSize({ width: 760, height: 780 });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.equal(await page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await page.locator('.bot-stop-response svg').count(), 1);
    assert.equal(await user.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    assert.equal(await user.evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
    assert.equal(await live.locator('.bot-reply-bar').count(), 0);
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `stream-narrow-${theme}.png`) });
  }
  await page.evaluate(theme => { if (theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; }, originalTheme);
  await page.setViewportSize(viewport);
  checks.push('receipt below user body with no outer frame; ordinary pending reply has no repeated quote; SVG stop control');
  command('RC_STREAM_TEXT', 1);
  await live.getByText('我先看看项目的整体情况，整理好后告诉你重点。', { exact: true }).waitFor();
  assert.equal(await page.locator('.bot-stop-response').count(), 1);
  assert.equal(await page.locator('.bot-reply:not(.bot-live-reply)').filter({ hasText: '项目概况看' }).count(), 0);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'stream-first-chunk.png') });
  checks.push('real delta visible while controlled provider remains pending, before canonical reply');
  const firstParagraph = live.locator('.bot-narration p').first();
  await firstParagraph.evaluate(node => { node.dataset.rcParagraphIdentity = 'first'; });
  await page.waitForTimeout(180);
  command('RC_STREAM_TEXT', 1.5);
  const secondParagraph = live.locator('.bot-narration p').filter({ hasText: '项目把界面和本地执行分开了，我再确认它们如何连接。' });
  await secondParagraph.waitFor();
  assert.equal(await firstParagraph.getAttribute('data-rc-paragraph-identity'), 'first');
  assert.equal(await secondParagraph.evaluate(node => getComputedStyle(node).animationName), 'motion-enter-fade');
  assert.equal(await firstParagraph.evaluate(node => node.getAnimations()[0]?.playState), 'finished');
  assert.equal(await live.locator('.bot-narration').evaluate(node => Boolean(node.closest('details'))), false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await secondParagraph.evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const footer = live.locator('.bot-reply-context');
  if (await detail.isVisible()) await closeReplyDetails(page);
  const bubbleChecks = [];
  for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width: 760, height: 780 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.equal(await live.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    const bubbles = await live.locator('.bot-narration p').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect(), container = node.closest('.bot-reply').getBoundingClientRect(), style = getComputedStyle(node);
      const range = document.createRange(); range.selectNodeContents(node);
      const text = [...range.getClientRects()];
      return { background: style.backgroundColor, radius: parseFloat(style.borderRadius),
        fits: rect.left >= container.left && rect.right <= container.right && text.every(item => item.left >= rect.left && item.right <= rect.right),
        padding: parseFloat(style.paddingLeft), bottom: rect.bottom };
    }));
    assert.equal(bubbles.length, 2);
    assert.ok(bubbles.every(item => item.background !== 'rgba(0, 0, 0, 0)' && item.radius >= 12 && item.padding >= 12 && item.fits));
    assert.equal(await detail.locator('.bot-turn-process > summary').isVisible(), false);
    assert.equal(await footer.locator(':scope > button').evaluate(node => node.getBoundingClientRect().top >= Math.max(...[...node.closest('.bot-reply').querySelectorAll('.bot-narration p')].map(p => p.getBoundingClientRect().bottom))), true);
    assert.equal(await footer.textContent(), '正在回复查看详情');
    assert.equal(await footer.locator(':scope > button').evaluate(node => parseFloat(getComputedStyle(node).fontSize)), 11);
    bubbleChecks.push({ theme, bubbles });
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `conversation-updates-${theme}.png`) });
  }
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, originalTheme);
  await page.setViewportSize(viewport);
  checks.push('second public paragraph arrives before completion, outside process; first DOM node and finished animation stay intact; reduced motion disables entry');
  // Return from another bot through read-conversation's live snapshot.
  await page.locator('.bot-search').fill('project-001');
  await page.locator('.bot-row').first().click(); await live.waitFor({ state: 'detached' });
  await page.locator('.bot-search').fill('project-000');
  await page.locator('.bot-row').first().click();
  await live.getByText('我先看看项目的整体情况，整理好后告诉你重点。', { exact: true }).waitFor();
  checks.push('switching bots hides the other stream and restores the active snapshot');
  if (workCommandFile) {
    await openDetails(live);
    const delegated = detail.locator('.bot-work-row'); await delegated.waitFor({ state: 'attached' });
    if (!(await delegated.evaluate(node => node.open))) await delegated.locator(':scope > summary').click();
  }
  // Reading history holds its position while the draft grows.
  await page.locator('.bot-thread').evaluate(node => { node.scrollTop = Math.max(1, node.scrollTop - 350); });
  await page.locator('.bot-thread-latest').waitFor();
  let readingTop = await page.locator('.bot-thread').evaluate(node => node.scrollTop);
  command('RC_STREAM_TEXT', 2);
  await openDetails(live);
  if (!(await detail.locator('.bot-turn-process').evaluate(node => node.open))) await detail.locator('.bot-turn-process > summary').click();
  const readingStep = detail.locator('.bot-tool-step[data-status="running"]');
  await readingStep.waitFor();
  const shine = readingStep.locator('.bot-tool-step-label');
  assert.equal(await shine.evaluate(node => getComputedStyle(node).animationName), 'motion-shimmer');
  const position = await shine.evaluate(node => getComputedStyle(node).backgroundPosition);
  await page.waitForTimeout(200);
  assert.notEqual(await shine.evaluate(node => getComputedStyle(node).backgroundPosition), position);
  await readingStep.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  await readingStep.locator('.bot-tool-preview > summary').click();
  await readingStep.getByText('调用正在进行，返回内容到达后会显示在这里。', { exact: true }).waitFor();
  assert.match(await readingStep.locator('pre').textContent(), /README.md/);
  assert.equal(await readingStep.locator('.bot-tool-preview > summary > svg').count(), 1);
  assert.equal(await readingStep.locator('.bot-tool-preview > summary').evaluate(node => getComputedStyle(node, '::before').content), 'none');
  assert.doesNotMatch(await readingStep.textContent(), /PRIVATE_/);
  await live.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'stream-tool-running-expanded.png') });
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'conversation-details.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await shine.evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.notEqual(await shine.evaluate(node => getComputedStyle(node).opacity), '0');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  checks.push('running tool scans over actual target; keyboard opens step and parameters before result; reduced motion remains readable');
  if (await page.locator('.bot-thread-latest').count()) await page.locator('.bot-thread-latest').click();
  // Keyboard focus may leave us near the end (within the follow threshold),
  // without a latest button. Scroll to the actual end before testing history.
  if (await page.locator('.bot-thread').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop) >= 2) {
    await page.locator('.bot-thread').hover(); await page.mouse.wheel(0, 1000);
  }
  await until(() => page.locator('.bot-thread').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop), gap => gap < 2);
  await page.locator('.bot-thread').evaluate(node => {
    // Exercise a real DOM scroll whose event has not reached React when the delta arrives.
    const hold = event => event.stopImmediatePropagation();
    node.addEventListener('scroll', hold, true);
    globalThis.rcReleaseReadingScroll = () => node.removeEventListener('scroll', hold, true);
    node.scrollTop = Math.max(1, node.scrollTop - 350);
  });
  readingTop = await page.locator('.bot-thread').evaluate(node => node.scrollTop);
  command('RC_STREAM_TEXT', 2.5);
  await until(() => live.textContent(), text => text.includes('项目概况看'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const readingAfter = await page.locator('.bot-thread').evaluate(node => node.scrollTop);
  report.readingPosition = { before: readingTop, after: readingAfter, eventDeliveryDelayed: true };
  await page.evaluate(() => { globalThis.rcReleaseReadingScroll?.(); delete globalThis.rcReleaseReadingScroll; });
  assert.ok(Math.abs(readingAfter - readingTop) < 2, 'new chunks must preserve the reading position');
  await page.locator('.bot-thread-latest').click();
  await detail.locator('.bot-tool-step[data-status="done"]').waitFor();
  await detail.locator('.bot-tool-preview > summary').filter({ hasText: '返回内容' }).click();
  assert.match(await detail.locator('.bot-tool-step').textContent(), /README fixture content/);
  await live.getByText('项目概况看', { exact: true }).waitFor();
  assert.doesNotMatch(await live.textContent(), /PRIVATE_/);
  await detail.locator('.bot-tool-metadata > summary').click();
  assert.equal(await detail.locator('.bot-tool-metadata').evaluate(node => node.open), true);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'stream-tool-and-draft.png') });
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 760, height: 780 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.equal(await live.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `stream-expanded-narrow-${theme}.png`) });
  }
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, originalTheme);
  await page.setViewportSize(viewport);

  checks.push('root post_reply text streams; actual result expands after arrival; hidden reasoning and credentials stay redacted; history holds');
  if (workCommandFile) {
    setDelegatedWork('accepted');
    await until(() => detail.locator('.bot-work-row').getAttribute('data-status'), status => status === 'accepted');
  }
  command('RC_STREAM_TEXT', 3); await live.waitFor({ state: 'detached' });
  const completed = page.locator('.bot-reply').filter({ hasText: '开始修改前，先核对项目规则。' });
  assert.equal(await detail.locator('.bot-turn-process').evaluate(node => node.open), true);
  assert.equal(await detail.locator('.bot-tool-step').evaluate(node => node.open), true);
  assert.equal(await detail.locator('.bot-tool-preview').first().evaluate(node => node.open), true);
  assert.equal(await detail.locator('.bot-tool-metadata').evaluate(node => node.open), true);
  assert.equal(await completed.locator('.is-running').count(), 0);
  assert.equal(await completed.locator('.bot-reply-bar').count(), 0);
  assert.deepEqual(await completed.locator('.bot-narration p').allTextContents(), [
    '我先看看项目的整体情况，整理好后告诉你重点。',
    '项目把界面和本地执行分开了，我再确认它们如何连接。',
    '本地执行的结果会交回界面。修改前还需要遵循项目里的开发规则。',
  ]);
  assert.equal(await completed.locator('.bot-narration-segment').count(), 2);
  assert.doesNotMatch(await completed.textContent(), /PRIVATE_/);
  if (workCommandFile) {
    assert.equal(await detail.locator('.bot-work-row').evaluate(node => node.open), true);
    checks.push('delegated work retains its expanded progress when the streamed reply becomes canonical');
  }
  checks.push('completion preserves expanded process, step and parameters without continuing animation');
  assert.equal(await page.locator('.bot-reply').filter({ hasText: '开始修改前，先核对项目规则。' }).count(), 1);
  await until(() => page.locator('.bot-thread').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop), gap => gap < 2);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'stream-complete.png') });
  await closeReplyDetails(page);
  await page.waitForTimeout(180);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'conversation-complete.png') });
  assert.equal(await completed.locator('.bot-turn-process').count(), 0);
  assert.equal(await completed.locator('.bot-reply-context > button').innerText(), '查看详情');
  const finalBubble = await completed.locator(':scope > .bot-reply-body').evaluate(node => ({ background: getComputedStyle(node).backgroundColor, padding: getComputedStyle(node).padding, text: node.innerText }));
  assert.notEqual(finalBubble.background, 'rgba(0, 0, 0, 0)');
  assert.match(finalBubble.text, /界面展示结果，本地负责执行能力/);
  assert.equal(await completed.locator('.bot-reply-body ul li').count(), 2);
  const completedTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  // Yield outside the inspector Promise so Electron can advance native frames.
  await page.waitForTimeout(180);
  await until(() => page.locator('.bot-shell').evaluate(node => node.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running'
      && animation.effect?.getComputedTiming().iterations !== Infinity
      && animation.effect?.target?.checkVisibility()).length), count => count === 0, 5000);
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'conversation-complete-light.png') });
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, completedTheme);
  const readingAnchor = () => page.locator('.bot-thread').evaluate(node => {
    const top = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll('[data-conversation-row]')].find(item => item.getBoundingClientRect().bottom > top);
    return { id: row?.dataset.conversationRow, delta: row?.getBoundingClientRect().top - top };
  });
  const beforeDrawer = await readingAnchor();
  await openDetails(completed);
  checks.push('completion replaces preview once, preserves Markdown and follows latest');
  await closeReplyDetails(page);
  const afterDrawer = await readingAnchor();
  assert.equal(afterDrawer.id, beforeDrawer.id, 'drawer round trip keeps the same reading row');
  assert.ok(Math.abs(afterDrawer.delta - beforeDrawer.delta) < 2, 'drawer round trip restores the reading offset');
  report.replyDrawerReading = { before: beforeDrawer, after: afterDrawer };

  await start('RC_STREAM_STOP');
  assert.equal(await completed.locator('.bot-narration p').count(), 3);
  assert.equal(await completed.locator('.bot-narration').getAttribute('data-live'), 'false');
  report.conversationFlow = { incrementalParagraphs: true, stableParagraphs: true, narrationOutsideProcess: true,
    retainedAfterCompletion: true, retainedFromHistory: true, separateToolUpdates: true, noPrivateThinking: true, reducedMotion: true,
    messageBubbles: true, detailsAtEnd: true, detailsCollapsed: true, detailsKeyboard: true, detailsInDrawer: true, detailsFocusRestored: true, detailsReadingPosition: true, bubbleChecks };
  await openDetails(completed);
  assert.equal(await detail.locator('.bot-turn-process').evaluate(node => node.open), true);
  assert.equal(await detail.locator('.bot-tool-step').evaluate(node => node.open), true);
  assert.match(await detail.locator('.bot-tool-step').textContent(), /README fixture content/);
  assert.doesNotMatch(await detail.locator('.bot-turn-process').textContent(), /PRIVATE_/);
  if (workCommandFile) assert.equal(await detail.locator('.bot-work-row').evaluate(node => node.open), true);
  assert.equal(await completed.locator('.bot-reply-bar').count(), 0);
  checks.push('next turn hands completed process to persisted history with disclosure, bounded redacted details and no automatic quote');
  await closeReplyDetails(page);
  command('RC_STREAM_STOP', 2);
  await live.getByText('我先看看项目的整体情况，整理好后告诉你重点。', { exact: true }).waitFor();
  await composer.fill('停止之后继续保留我的草稿');
  const stop = page.getByRole('button', { name: '停止生成', exact: true });
  await stop.focus();
  assert.equal(await stop.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
  await stop.press('Enter');
  await page.getByText('生成已停止，以上内容未完成', { exact: true }).waitFor();
  assert.equal(await page.locator('.bot-system').filter({ has: page.locator('.bot-stopped-reply') }).locator('.bot-reply-bar').count(), 0);
  assert.equal(await composer.inputValue(), '停止之后继续保留我的草稿');
  assert.equal(await page.locator('.bot-stop-response').count(), 0);
  const stoppedMessage = page.locator('.bot-system').filter({ has: page.locator('.bot-stopped-reply') });
  await openDetails(stoppedMessage);
  await detail.locator('.bot-tool-step[data-status="stopped"]').waitFor({ state: 'attached' });
  await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, 'stream-stopped.png') });
  await closeReplyDetails(page);
  await composer.fill(''); command('RC_STREAM_STOP', 3);
  await page.locator('.bot-stopped-reply').getByRole('button', { name: '重发', exact: true }).click();
  await until(() => page.locator('.bot-reply').filter({ hasText: '开始修改前，先核对项目规则。' }).count(), count => count === 2);
  checks.push('stop preserves incomplete text, stopped running tool, exact-turn process and draft; explicit retry creates one new reply');
  await start('RC_STREAM_FAIL'); command('RC_STREAM_FAIL', 2.5);
  await live.getByText('项目概况看', { exact: true }).waitFor();
  command('RC_STREAM_FAIL', 3); await live.waitFor({ state: 'detached' });
  const failedMessage = page.locator('.bot-system').filter({ has: page.locator('.bot-unavailable-reply') }).last();
  const failed = failedMessage.locator('.bot-unavailable-reply');
  await failed.waitFor();
  assert.equal(await failedMessage.locator('.bot-context-error').isVisible(), false);
  assert.equal(await failed.locator(':scope > p').innerText(), '暂时无法完成回复。');
  assert.equal(await failedMessage.locator('.bot-reply-bar').count(), 0);
  await openDetails(failedMessage);
  await detail.getByText('受控连接失败', { exact: false }).waitFor();
  await detail.locator('.bot-tool-step[data-status="done"]').waitFor({ state: 'attached' });
  await closeReplyDetails(page);
  await failed.getByRole('button', { name: '重发', exact: true }).click();
  await until(() => page.locator('.bot-reply').filter({ hasText: '开始修改前，先核对项目规则。' }).count(), count => count === 3);
  checks.push('failure retracts unaccepted preview, folds provider diagnostics and offers visible explicit retry without duplicate replies');
  command('RC_MANUAL_WAKE_RETRY', 0);
  await page.locator('.bot-search').fill('project-001');
  await page.locator('.bot-row').first().click();
  const wakeFailure = page.locator('.bot-unavailable-reply').last();
  await wakeFailure.getByRole('button', { name: '重发', exact: true }).click();
  await live.waitFor();
  await live.getByText('正在重试，我会接着核对已有进展。', { exact: true }).waitFor();
  assert.equal(await page.locator('.bot-stop-response').count(), 1);
  assert.doesNotMatch(await live.innerText(), /PRIVATE_RETRY_THINKING/);
  for (const [width, theme] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await live.scrollIntoViewIfNeeded();
    assert.equal(await live.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    // Finish theme transitions before the still image; interaction animation is checked separately.
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `manual-wake-retry-${theme}.png`) });
  }
  command('RC_MANUAL_WAKE_RETRY', 2);
  await live.waitFor({ state: 'detached' });
  const wakeReply = page.locator('.bot-reply').filter({ hasText: '重试完成，已有进展已保留。' });
  await wakeReply.waitFor();
  assert.equal(await wakeReply.locator('.bot-narration p').first().textContent(), '正在重试，我会接着核对已有进展。');
  await until(() => page.locator('.bot-stop-response').count(), count => count === 0);
  await until(() => wakeFailure.getByRole('button', { name: '重发', exact: true }).count(), count => count === 0);
  report.manualWakeRetry = { progressBeforeCompletion: true, stopVisible: true, completed: true, narrationRetained: true, noPrivateThinking: true, narrowFits: true };
  await page.setViewportSize(viewport);
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, originalTheme);
  await page.locator('.bot-search').fill('project-000'); await page.locator('.bot-row').first().click();
  checks.push('manual retry of persisted wake shows progress while pending, ends in one reply and retains public paragraphs');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = spawnSync(process.execPath, ['apps/desktop/scripts/bot-shell-electron-smoke.mjs', '--streaming', ...process.argv.slice(2)], { cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))), stdio: 'inherit', env: process.env });
  process.exitCode = result.status ?? 1;
}
