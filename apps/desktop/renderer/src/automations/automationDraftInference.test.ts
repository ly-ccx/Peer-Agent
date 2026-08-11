import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canInferAutomationDraft,
  inferAutomationDraftFromPrompt,
  parseLlmAutomationDetectionText,
  buildAutomationDetectionPrompt,
  inferAutomationName,
  inferAutomationSchedule,
} from './automationDraftInference.ts';

test('infers a clean name from a Chinese task description', () => {
  assert.equal(
    inferAutomationName('每个工作日 9:00 检查仓库健康并汇总失败项'),
    '检查仓库健康并汇总失败项',
  );
});

test('infers weekday morning schedule from Chinese prompt', () => {
  const schedule = inferAutomationSchedule('每个工作日 9:30 检查 CI');
  assert.equal(schedule.scheduleKind, 'weekdays');
  assert.equal(schedule.hour, 9);
  assert.equal(schedule.minute, 30);
  assert.equal(schedule.detectedSchedule, true);
});

test('infers hourly schedule and everyHours', () => {
  const schedule = inferAutomationSchedule('每 2 小时同步一次依赖');
  assert.equal(schedule.scheduleKind, 'hourly');
  assert.equal(schedule.everyHours, 2);
});

test('infers once schedule for tomorrow evening', () => {
  const now = new Date('2026-08-05T10:00:00');
  const schedule = inferAutomationSchedule('明天晚上 8 点部署预发', now);
  assert.equal(schedule.scheduleKind, 'once');
  assert.equal(schedule.onceAt.endsWith('T20:00'), true);
});

test('full draft inference returns name and schedule together', () => {
  const draft = inferAutomationDraftFromPrompt('每天 09:00 检查仓库健康');
  assert.equal(draft.name.includes('检查仓库健康'), true);
  assert.equal(draft.scheduleKind, 'daily');
  assert.equal(draft.hour, 9);
  assert.equal(draft.minute, 0);
  assert.equal(canInferAutomationDraft('短'), false);
  assert.equal(canInferAutomationDraft('检查仓库健康状态'), true);
});

test('parseLlmAutomationDetectionText accepts fenced JSON from model output', () => {
  const raw = [
    '```json',
    '{"name":"Daily health check","scheduleKind":"weekdays","hour":9,"minute":30}',
    '```',
  ].join('\n');
  const parsed = parseLlmAutomationDetectionText(raw);
  assert.equal(parsed?.name, 'Daily health check');
  assert.equal(parsed?.scheduleKind, 'weekdays');
  assert.equal(parsed?.hour, 9);
  assert.equal(parsed?.minute, 30);
  assert.equal(parsed?.source, 'llm');
});

test('buildAutomationDetectionPrompt includes the user task text', () => {
  const prompt = buildAutomationDetectionPrompt('每天检查仓库健康', 'zh');
  assert.match(prompt, /每天检查仓库健康/);
  assert.match(prompt, /scheduleKind/);
});
