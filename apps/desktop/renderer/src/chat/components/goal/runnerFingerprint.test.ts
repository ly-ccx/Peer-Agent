import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * 与 GoalPlanPanel.runnerFingerprint 保持同构：双通道等价快照去重契约。
 * 不 import TS 组件（node:test 纯逻辑），避免把 React 渲染拉进单测。
 */
function runnerFingerprint(runner: Record<string, unknown> | null | undefined): string {
  if (!runner) return '';
  return [
    runner.status ?? '',
    runner.phase ?? '',
    runner.enabled === true ? '1' : runner.enabled === false ? '0' : '',
    runner.roundCount ?? '',
    runner.toolCallCount ?? '',
    runner.intent ?? '',
    runner.currentTaskId ?? '',
    runner.lastTickAt ?? '',
    runner.lastError ?? '',
  ].join('|');
}

describe('runnerFingerprint (P1 dual-channel dedupe)', () => {
  it('treats equivalent runner snapshots as equal', () => {
    const a = {
      status: 'running',
      phase: 'act',
      enabled: true,
      roundCount: 3,
      toolCallCount: 7,
      intent: 'execute',
      currentTaskId: 't1',
      lastTickAt: '2026-01-01T00:00:00.000Z',
      lastError: null,
      extraNoise: { foo: 1 },
    };
    const b = {
      ...a,
      extraNoise: { foo: 2 },
      unrelated: true,
    };
    assert.equal(runnerFingerprint(a), runnerFingerprint(b));
  });

  it('changes when progress counters move', () => {
    const base = {
      status: 'running',
      phase: 'act',
      enabled: true,
      roundCount: 1,
      toolCallCount: 1,
    };
    assert.notEqual(
      runnerFingerprint(base),
      runnerFingerprint({ ...base, roundCount: 2 }),
    );
  });
});
