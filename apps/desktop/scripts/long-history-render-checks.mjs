import assert from 'node:assert/strict';
import { writeStreamingCommand } from '../../../scripts/rc-response-interaction-smoke.mjs';

/**
 * 真实 Electron 渲染。输入是合成文字，不按回车。
 * 连续小块走本机脚本认知，不接外部模型。操作系统输入法不在这里。
 */
export async function checkLongHistoryRender({ page, until, report, commandFile }) {
  const blocked = [];
  await page.route(/https?:\/\//, route => {
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.locator('.bot-thread').waitFor();
  await until(() => page.locator('.bot-thread[aria-busy="false"]').count(), count => count === 1, 60000);
  const thread = page.locator('.bot-thread');
  const older = page.locator('.bot-thread-older');
  for (let step = 0; step < 12; step += 1) {
    const height = await thread.evaluate(node => node.scrollHeight);
    if (height > 16000 || await older.count() === 0) break;
    await older.click();
    await until(() => thread.evaluate(node => node.scrollHeight), next => next > height, 10000);
  }
  const geometry = await thread.evaluate(node => {
    const rows = [...node.querySelectorAll('[data-conversation-row]')];
    const spacers = [...node.querySelectorAll('.bot-thread-spacer')].map(spacer => spacer.getBoundingClientRect().height);
    return {
      rows: rows.length,
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      spacers,
    };
  });
  assert.ok(geometry.rows >= 1 && geometry.rows <= 80, `visible rows ${geometry.rows}`);
  assert.ok(geometry.scrollHeight > 8000, `scroll height ${geometry.scrollHeight} does not cover a long history`);
  assert.ok(geometry.spacers.some(height => height > geometry.clientHeight), 'unmounted history keeps its scroll extent');
  await page.evaluate(() => {
    globalThis.rcFrameGaps = [];
    let last = performance.now();
    const tick = (now) => {
      globalThis.rcFrameGaps.push(Math.round((now - last) * 10) / 10);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const composer = page.locator('.bot-composer textarea');
  const rowsBeforeInput = geometry.rows;
  await composer.click();
  const typed = '合成长历史';
  const inputStarted = Date.now();
  await composer.pressSequentially(typed, { delay: 16 });
  const inputMs = Date.now() - inputStarted;
  assert.equal(await composer.inputValue(), typed);
  assert.equal(await page.locator('.bot-thread [data-conversation-row]').count(), rowsBeforeInput, 'typing must not append a message');
  const inputFrames = await page.evaluate(() => globalThis.rcFrameGaps.splice(0));
  const latest = page.getByRole('button', { name: '回到最新消息', exact: true });
  if (await latest.count()) await latest.click();
  await composer.fill('');
  await composer.pressSequentially('RC_STREAM_TEXT');
  assert.equal(await composer.inputValue(), 'RC_STREAM_TEXT');
  writeStreamingCommand(commandFile, 'RC_STREAM_TEXT', 1);
  await composer.press('Enter');
  await page.locator('.bot-thread').getByText('我先看看项目的整体情况', { exact: false }).first().waitFor();
  const chunkFrames = [];
  for (const phase of [1.5]) {
    writeStreamingCommand(commandFile, 'RC_STREAM_TEXT', phase);
    await page.locator('.bot-thread').getByText('我再确认它们如何连接', { exact: false }).first().waitFor();
    const sample = await page.locator('.bot-thread').evaluate(node => ({
      rows: node.querySelectorAll('[data-conversation-row]').length,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      scrollTop: node.scrollTop,
    }));
    const frames = await page.evaluate(() => globalThis.rcFrameGaps.splice(0));
    chunkFrames.push({ phase, ...sample, maxFrameMs: Math.max(0, ...frames) });
    assert.ok(sample.rows <= 80, `chunk rows ${sample.rows}`);
    assert.ok(sample.scrollHeight > sample.clientHeight);
  }
  const maxInputFrame = Math.max(0, ...inputFrames);
  report.longHistoryRender = {
    geometry,
    inputMs,
    typed,
    submittedByTyping: false,
    maxInputFrameMs: maxInputFrame,
    chunks: chunkFrames,
    blocked,
    ime: 'not-covered',
  };
  report.checks.push('synthetic long history stays inside the 80-row window; typing does not send; scripted chunks stay local');
  assert.equal(blocked.length, 0, `outbound requests were attempted: ${blocked.join(' ')}`);
}
