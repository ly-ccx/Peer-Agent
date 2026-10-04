import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
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
      if (text === 'RC_DETAIL_QUESTION') {
        const send = (channel, payload) => input.webContents.send(channel, { streamId: input.streamId, ...payload });
        send('chat:stream:tool-call', { tool: 'list_sessions', toolCallId: 'sessions', args: {} });
        send('chat:stream:tool-result', { toolCallId: 'sessions', result: JSON.stringify({ ok: true, sessions: [] }) });
        send('chat:stream:tool-call', { tool: 'post_reply', toolCallId: 'question', args: {
          text: '你希望统计哪类记录？', replyTo: input.turnProfile.context.inputAnchors.map(anchor => anchor.messageId),
          question: { options: ['这个应用里的历史聊天', '其它工具里的工作记录'] },
        } });
        send('chat:stream:tool-result', { toolCallId: 'question', result: JSON.stringify({ ok: true }) });
        return { terminalStatus: 'done' };
      }
      if (!text.includes('RC_STREAM_')) {
        await new Promise(resolve => setTimeout(resolve, 120));
        return { terminalStatus: 'done', text: 'RC scripted reply: ' + text };
      }
      const attempt = (attempts.get(text) || 0) + 1; attempts.set(text, attempt);
      const turn = { aborted: false }; active.set(input.streamId, turn);
      const sink = input.webContents, streamId = input.streamId;
      const send = (channel, payload) => { if (!turn.aborted) sink.send(channel, { streamId, ...payload }); };
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
      const aborted = () => ({ terminalStatus: 'aborted', text: '首段文字已经到达。', toolCalls: [] });
      try {
        send('chat:stream:thinking', { content: 'PRIVATE_REASONING_MUST_NOT_RENDER' });
        if (!await wait(1)) return aborted();
        send('chat:stream:delta', { content: '首段文字已经到达。' });
        if (!await wait(2)) return aborted();
        send('chat:stream:tool-call', { tool: 'read_file', toolCallId: 'read', args: { path: 'PRIVATE_PATH' } });
        send('chat:stream:tool-result', { toolCallId: 'read', result: JSON.stringify({ ok: true, output: 'PRIVATE_RESULT' }) });
        const progress = {}, args = { text: '**流式回复**正在逐步生成。\n\n- 保留 Markdown\n- 完成后只有一条正式回复', replyTo: input.turnProfile.context.inputAnchors.map(anchor => anchor.messageId) };
        emitToolArgProgress(progress, { webContents: sink, streamId, toolCallId: 'reply', toolName: 'post_reply', argsJson: '{"text":"**流式回复**正在' });
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

export async function checkResponseInteraction({ page, until, report, captureDirectory, commandFile }) {
  const checks = report.streamingInteraction = [];
  const command = (scenario, phase) => writeFileSync(commandFile, JSON.stringify({ scenario, phase }));
  const composer = page.locator('.bot-composer textarea'), live = page.locator('.bot-live-reply');
  const start = async scenario => {
    command(scenario, 0); await composer.fill(scenario); await composer.press('Enter');
    await live.waitFor(); await live.getByText('思考中…', { exact: true }).waitFor();
  };
  await start('RC_STREAM_TEXT');
  const user = page.locator('.bot-user').filter({ hasText: 'RC_STREAM_TEXT' });
  const layout = await user.evaluate(node => ({ content: node.querySelector('.bot-user-content').getBoundingClientRect().bottom, receipt: node.querySelector('.bot-user-marks').getBoundingClientRect().top }));
  assert.ok(layout.receipt >= layout.content);
  assert.equal(await live.locator('.bot-reply-bar svg').count(), 2);
  await page.screenshot({ path: path.join(captureDirectory, 'stream-waiting.png') });
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.setViewportSize({ width: 760, height: 780 });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.equal(await page.locator('.bot-convo').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await page.locator('.bot-stop-response svg').count(), 1);
    assert.equal(await live.locator('.bot-reply-bar').evaluate(node => getComputedStyle(node).boxShadow), 'none');
    await page.screenshot({ path: path.join(captureDirectory, `stream-narrow-${theme}.png`) });
  }
  await page.evaluate(theme => { if (theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; }, originalTheme);
  await page.setViewportSize(viewport);
  checks.push('receipt below user body; anchored waiting state and SVG stop control');
  command('RC_STREAM_TEXT', 1);
  await live.getByText('首段文字已经到达。', { exact: true }).waitFor();
  assert.equal(await page.locator('.bot-stop-response').count(), 1);
  assert.equal(await page.locator('.bot-reply:not(.bot-live-reply)').filter({ hasText: '流式回复正在' }).count(), 0);
  await page.screenshot({ path: path.join(captureDirectory, 'stream-first-chunk.png') });
  checks.push('real delta visible while controlled provider remains pending, before canonical reply');
  // Return from another bot through read-conversation's live snapshot.
  await page.locator('.bot-search').fill('project-001');
  await page.locator('.bot-row').first().click(); await live.waitFor({ state: 'detached' });
  await page.locator('.bot-search').fill('project-000');
  await page.locator('.bot-row').first().click();
  await live.getByText('首段文字已经到达。', { exact: true }).waitFor();
  checks.push('switching bots hides the other stream and restores the active snapshot');
  // Reading history holds its position while the draft grows.
  await page.locator('.bot-thread').evaluate(node => { node.scrollTop = Math.max(1, node.scrollTop - 350); });
  await page.locator('.bot-thread-latest').waitFor();
  const readingTop = await page.locator('.bot-thread').evaluate(node => node.scrollTop);
  command('RC_STREAM_TEXT', 2);
  await until(() => live.textContent(), text => text.includes('流式回复正在'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(Math.abs((await page.locator('.bot-thread').evaluate(node => node.scrollTop)) - readingTop) < 2, 'new chunks must preserve the reading position');
  await page.locator('.bot-thread-latest').click();
  await live.getByText('文件读取已结束', { exact: true }).waitFor();
  await live.getByText('流式回复正在', { exact: true }).waitFor();
  assert.doesNotMatch(await live.textContent(), /PRIVATE_/);
  await page.screenshot({ path: path.join(captureDirectory, 'stream-tool-and-draft.png') });
  checks.push('root post_reply text streams via shared parser; tools use compact SVG; no reasoning, arguments or results leak; history holds');
  command('RC_STREAM_TEXT', 3); await live.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.bot-reply').filter({ hasText: '完成后只有一条正式回复' }).count(), 1);
  await until(() => page.locator('.bot-thread').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop), gap => gap < 2);
  await page.screenshot({ path: path.join(captureDirectory, 'stream-complete.png') });
  checks.push('completion replaces preview once, preserves Markdown and follows latest');
  await start('RC_STREAM_STOP'); command('RC_STREAM_STOP', 1);
  await live.getByText('首段文字已经到达。', { exact: true }).waitFor();
  await composer.fill('停止之后继续保留我的草稿');
  const stop = page.getByRole('button', { name: '停止生成', exact: true });
  await stop.focus();
  assert.equal(await stop.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
  await stop.press('Enter');
  await page.getByText('生成已停止，以上内容未完成', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), '停止之后继续保留我的草稿');
  assert.equal(await page.locator('.bot-stop-response').count(), 0);
  await page.screenshot({ path: path.join(captureDirectory, 'stream-stopped.png') });
  const stoppedProcess = page.locator('.bot-system').filter({ has: page.locator('.bot-stopped-reply') }).getByRole('button', { name: '查看过程', exact: true });
  await stoppedProcess.click(); await page.locator('.bot-process').waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await composer.fill(''); command('RC_STREAM_STOP', 3);
  await page.locator('.bot-stopped-reply').getByRole('button', { name: '重发', exact: true }).click();
  await until(() => page.locator('.bot-reply').filter({ hasText: '完成后只有一条正式回复' }).count(), count => count === 2);
  checks.push('stop preserves incomplete text, exact-turn process and draft; explicit retry creates one new reply');
  await start('RC_STREAM_FAIL'); command('RC_STREAM_FAIL', 2);
  await live.getByText('流式回复正在', { exact: true }).waitFor();
  command('RC_STREAM_FAIL', 3); await live.waitFor({ state: 'detached' });
  const failed = page.locator('.bot-card').filter({ hasText: '受控连接失败' });
  await failed.waitFor(); await failed.getByRole('button', { name: '重发', exact: true }).click();
  await until(() => page.locator('.bot-reply').filter({ hasText: '完成后只有一条正式回复' }).count(), count => count === 3);
  checks.push('failure retracts unaccepted preview and offers explicit retry without duplicate replies');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = spawnSync(process.execPath, ['apps/desktop/scripts/bot-shell-electron-smoke.mjs', '--streaming', ...process.argv.slice(2)], { cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))), stdio: 'inherit', env: process.env });
  process.exitCode = result.status ?? 1;
}
