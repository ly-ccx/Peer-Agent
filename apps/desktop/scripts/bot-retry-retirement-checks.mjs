import assert from 'node:assert/strict';
import path from 'node:path';
import { writeStreamingCommand } from '../../../scripts/rc-response-interaction-smoke.mjs';
import { openReplyDetails, closeReplyDetails } from './bot-reply-details-checks.mjs';

/** Real Runner and retry IPC, with two controlled failures followed by a canonical reply. */
export async function checkRetryRetirement({ page, until, report, captureDirectory, commandFile, readFixtureTurns }) {
  const scenario = 'RC_STREAM_FAIL_AGAIN';
  writeStreamingCommand(commandFile, scenario, 3);
  const composer = page.locator('.bot-composer textarea');
  await composer.fill(scenario); await composer.press('Enter');
  const failed = page.locator('.bot-system, .bot-continuous-reply').filter({ has: page.locator('.bot-unavailable-reply:not(.is-resolved)') }).last();
  await failed.waitFor();
  const firstId = await failed.getAttribute('id');
  const first = page.locator(`#${firstId}`);
  await first.getByRole('button', { name: '继续尝试', exact: true }).click();
  await until(() => readFixtureTurns().filter(turn => turn.kind === 'repeated-failure-ended' && turn.scenario === scenario).length, count => count === 1);
  const latest = page.locator('.bot-system, .bot-continuous-reply').filter({ has: page.locator('.bot-unavailable-reply:not(.is-resolved)') }).last();
  await latest.getByRole('button', { name: '继续尝试', exact: true }).waitFor();
  await until(() => first.locator('.bot-recovery-history, .bot-card[aria-busy="false"].is-resolved').count(), count => count > 0);
  assert.equal(await first.getByRole('alert').count(), 0, 'failed receipt cannot outlive its superseded interruption');
  const completed = page.locator('.bot-reply:not(.bot-live-reply)').filter({ hasText: '项目概况看清楚了' });
  const priorReplies = await completed.count();
  const secondId = await latest.getAttribute('id');
  await latest.getByRole('button', { name: '继续尝试', exact: true }).click();
  const second = page.locator(`#${secondId}`);
  await first.locator('.bot-recovery-history').waitFor();
  await second.locator('.bot-recovery-history').waitFor();
  await until(() => completed.count(), count => count === priorReplies + 1);
  await until(() => page.locator('.bot-stop-response').count(), count => count === 0);
  assert.equal(await first.getByRole('button', { name: '继续尝试', exact: true }).count(), 0);
  assert.equal(await second.getByRole('alert').count(), 0);
  assert.equal(await first.locator('.bot-recovery-history').evaluate(node => node.open), false);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    await first.scrollIntoViewIfNeeded();
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `retry-history-${width}-${appearance}.png`) });
  }
  const summary = first.locator('.bot-recovery-history > summary');
  await summary.focus(); await summary.press('Enter');
  await until(() => first.locator('.bot-recovery-history').evaluate(node => node.open), Boolean);
  await openReplyDetails(page, first);
  await until(() => page.locator('.bot-context-error pre').textContent(), text => text.includes('受控连接失败'));
  await closeReplyDetails(page);
  assert.equal(await first.locator('.bot-recovery-history button').evaluate(node => node === document.activeElement), true);
  const traces = readFixtureTurns().filter(turn => turn.scenario === scenario);
  assert.equal(traces.filter(turn => turn.role === 'project_agent').length, 3);
  assert.equal(traces.filter(turn => turn.kind === 'streaming-read-dispatch').length, 1);
  await page.setViewportSize(viewport);
  await page.evaluate(value => { if (value === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = value; }, theme);
  report.retryRetirement = { passed: true, realRetryIPC: true, realCheckpointPort: true, controlledCognition: true,
    failedReceiptRetired: true, historyCollapsed: true, keyboard: true, diagnosticsRetained: true, noReadReplay: true, canonicalReplyDelivered: true };
}
