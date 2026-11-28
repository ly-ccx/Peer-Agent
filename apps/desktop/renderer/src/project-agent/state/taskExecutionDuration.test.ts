import assert from 'node:assert/strict';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import { processDuration } from './processDuration.ts';
import { readDrawerSession } from './drawerState.ts';
import { isExecutionTicking, taskExecutionLabel, taskExecutionTitle } from './taskExecutionDuration.ts';

const zh = createI18n('zh-CN');
const en = createI18n('en-US');
const running = { status: 'running', spawnedAt: '2026-11-26T00:00:00Z', startedAt: '2026-11-26T00:02:00Z' };
const sinceStart = (seconds: number) => Date.parse(running.startedAt) + seconds * 1000;

test('the running stopwatch and coarse sidebar count from worker start, not spawn', () => {
  for (const [seconds, header, sidebar] of [[0, '00:00', '<1m'], [42, '00:42', '<1m'],
    [60, '01:00', '1m'], [204, '03:24', '3m'], [3912, '1:05:12', '1h 05m']] as const) {
    assert.equal(taskExecutionLabel(running, 'header', sinceStart(seconds), zh), header);
    assert.equal(taskExecutionLabel(running, 'sidebar', sinceStart(seconds), zh), sidebar);
  }
});

test('natural duration is localized and fixed at the first end; sidebar hides finished tasks', () => {
  for (const [seconds, zhText, enText] of [[0.25, '少于 1 秒', 'Less than 1s'], [42, '42 秒', '42s'],
    [204, '3 分 24 秒', '3m 24s'], [3912, '1 小时 05 分', '1h 5m']] as const) {
    assert.equal(processDuration(seconds, zh), zhText);
    assert.equal(processDuration(seconds, en), enText);
    for (const status of ['result_ready', 'accepted', 'completed', 'failed', 'cancelled', 'verification_failed']) {
      const finished = { ...running, status, endedAt: new Date(sinceStart(seconds)).toISOString() };
      assert.equal(taskExecutionLabel(finished, 'header', sinceStart(5000), zh), zhText);
      assert.equal(taskExecutionLabel(finished, 'sidebar', sinceStart(5000), zh), null);
      assert.equal(isExecutionTicking(finished), false);
    }
  }
});

test('queue, missing and invalid timestamps do not create fake or negative durations', () => {
  const legacy = readDrawerSession({ sessionId: 'legacy', status: 'running', spawnedAt: running.spawnedAt });
  assert.ok(legacy);
  assert.equal(Object.hasOwn(legacy, 'startedAt'), false);
  for (const timing of [legacy, { ...running, status: 'queued' }, { ...running, status: 'starting' },
    { ...running, status: 'accepted' }, { ...running, startedAt: 'invalid' },
    { ...running, endedAt: running.spawnedAt }, { ...running, endedAt: 'invalid' }]) {
    for (const surface of ['header', 'sidebar'] as const) {
      assert.equal(taskExecutionLabel(timing, surface, sinceStart(10), zh), null);
    }
    assert.equal(isExecutionTicking(timing), false);
  }
  assert.equal(taskExecutionLabel(running, 'header', sinceStart(-1), zh), null);
});

test('tooltip includes valid timestamps and meaningful queue wait, without inferring missing facts', () => {
  const endedAt = new Date(sinceStart(42)).toISOString();
  const timing = readDrawerSession({ ...running, sessionId: 'timed', status: 'result_ready', endedAt });
  assert.ok(timing);
  assert.equal(timing.startedAt, running.startedAt);
  assert.equal(timing.endedAt, endedAt);
  const format = new Intl.DateTimeFormat(zh.locale, { dateStyle: 'medium', timeStyle: 'medium' });
  assert.equal(taskExecutionTitle(timing, zh), [
    `发起：${format.format(Date.parse(running.spawnedAt))}`,
    `实际开跑：${format.format(Date.parse(running.startedAt))}`,
    `结束：${format.format(Date.parse(endedAt))}`,
    '排队等待：2 分 0 秒',
  ].join('\n'));
  assert.match(taskExecutionTitle({ status: 'queued', spawnedAt: running.spawnedAt }, zh) ?? '', /^发起：[^\n]+$/);
  assert.equal(taskExecutionTitle({ status: 'running', spawnedAt: 'invalid' }, zh), undefined);
});
