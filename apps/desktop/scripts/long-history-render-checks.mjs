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
  const latest = page.getByRole('button', { name: '回到最新消息', exact: true });
  if (await latest.count()) await latest.click();
  await page.evaluate(() => {
    globalThis.rcFrameGaps = [];
    globalThis.rcFrameMarks = {};
    let last = performance.now();
    const tick = (now) => {
      globalThis.rcFrameGaps.push({ gap: Math.round((now - last) * 10) / 10, at: now });
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const mark = name => page.evaluate(name => { globalThis.rcFrameMarks[name] = performance.now(); }, name);
  const composer = page.locator('.bot-composer textarea');
  const chunks = 40;
  const chunkIntervalMs = 50;
  const keyDelayMs = 16;
  const draft = '测'.repeat(40);
  await composer.click();
  await mark('operationStart');
  await composer.pressSequentially('RC_STREAM_LONG');
  assert.equal(await composer.inputValue(), 'RC_STREAM_LONG');
  writeStreamingCommand(commandFile, 'RC_STREAM_LONG', 0, { chunks });
  await composer.press('Enter');
  await until(() => composer.inputValue(), value => value === '', 10000);
  const typingStarted = Date.now();
  let inputWallMs = 0;
  const typing = composer.pressSequentially(draft, { delay: keyDelayMs }).then(() => { inputWallMs = Date.now() - typingStarted; });
  const chunkStarted = Date.now();
  for (let index = 1; index <= chunks; index += 1) {
    const stepStarted = Date.now();
    writeStreamingCommand(commandFile, 'RC_STREAM_LONG', index, { chunks });
    const token = `〔${String(index).padStart(2, '0')}〕`;
    await page.locator('.bot-thread').getByText(token, { exact: false }).first().waitFor({ timeout: 10000 });
    const remaining = chunkIntervalMs - (Date.now() - stepStarted);
    if (remaining > 0) await page.waitForTimeout(remaining);
  }
  const chunkWallMs = Date.now() - chunkStarted;
  await typing;
  await page.locator('.bot-thread').getByText('〔40〕', { exact: false }).first().waitFor();
  await mark('operationEnd');
  await page.waitForTimeout(500);
  await mark('paintEnd');
  const tail = await page.locator('.bot-thread').evaluate(node => ({
    rows: node.querySelectorAll('[data-conversation-row]').length,
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    fromBottom: node.scrollHeight - node.clientHeight - node.scrollTop,
    text: node.innerText,
  }));
  const frames = await page.evaluate(() => ({ gaps: globalThis.rcFrameGaps, marks: globalThis.rcFrameMarks }));
  const between = (start, end) => frames.gaps.filter(sample => sample.at >= start && sample.at < end).map(sample => sample.gap);
  const during = between(frames.marks.operationStart, frames.marks.operationEnd);
  const after = between(frames.marks.operationEnd, frames.marks.paintEnd);
  const stats = samples => {
    const sorted = [...samples].sort((left, right) => left - right);
    const pick = ratio => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))] : 0;
    return { count: samples.length, p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) ?? 0,
      over50: samples.filter(gap => gap > 50).length, over100: samples.filter(gap => gap > 100).length };
  };
  assert.equal(await composer.inputValue(), draft, 'draft typed during the stream must stay unsent');
  for (let index = 1; index <= chunks; index += 1) assert.equal(tail.text.includes(`〔${String(index).padStart(2, '0')}〕`), true, `missing chunk ${index}`);
  assert.ok(tail.rows >= 1 && tail.rows <= 80, `visible rows ${tail.rows}`);
  assert.ok(tail.scrollHeight > tail.clientHeight);
  assert.ok(tail.fromBottom < 80, `not following the tail: ${tail.fromBottom}`);
  report.longHistoryRender = {
    geometry,
    chunks,
    chunkIntervalMs,
    chunkWallMs,
    draftChars: draft.length,
    keyDelayMs,
    scheduledKeyDelayMs: (draft.length - 1) * keyDelayMs,
    inputWallMs,
    inputWallIncludesScheduledDelay: true,
    during: stats(during),
    afterPaint: stats(after),
    tail: { rows: tail.rows, scrollTop: tail.scrollTop, scrollHeight: tail.scrollHeight, clientHeight: tail.clientHeight, fromBottom: tail.fromBottom },
    blocked,
    ime: 'not-covered',
  };
  report.checks.push('synthetic long history stays inside the 80-row window; typing does not send; scripted chunks stay local');
  assert.equal(blocked.length, 0, `outbound requests were attempted: ${blocked.join(' ')}`);
}
