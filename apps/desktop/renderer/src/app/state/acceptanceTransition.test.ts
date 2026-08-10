import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACCEPTANCE_CELEBRATION_MS,
  ACCEPTANCE_EXIT_MS,
  runAcceptanceTransition,
  type AcceptancePhase,
} from './acceptanceTransition.ts';

/** 收集 schedule 回调，手动推进时钟，避免测试依赖真实定时器。 */
function createManualScheduler() {
  const queue: { readonly callback: () => void; readonly delayMs: number }[] = [];
  return {
    schedule: (callback: () => void, delayMs: number) => {
      queue.push({ callback, delayMs });
    },
    /** 依次执行下一个待跑定时器，返回它注册时声明的延迟。 */
    tick(): number {
      const next = queue.shift();
      assert.ok(next, 'expected a scheduled acceptance timer');
      next.callback();
      return next.delayMs;
    },
    get pending(): number {
      return queue.length;
    },
  };
}

describe('runAcceptanceTransition', () => {
  it('runs submitting -> celebrating -> exiting -> settled with the shared durations', async () => {
    const phases: (AcceptancePhase | null)[] = [];
    const clock = createManualScheduler();
    let settled = 0;

    await runAcceptanceTransition({
      submit: () => {},
      onPhase: (phase) => phases.push(phase),
      schedule: clock.schedule,
      onSettled: () => {
        settled += 1;
      },
    });

    // 提交完成后先进入庆祝态，退场必须等庆祝时长走完。
    assert.deepEqual(phases, ['submitting', 'celebrating']);
    assert.equal(settled, 0);

    assert.equal(clock.tick(), ACCEPTANCE_CELEBRATION_MS);
    assert.deepEqual(phases, ['submitting', 'celebrating', 'exiting']);
    assert.equal(settled, 0);

    assert.equal(clock.tick(), ACCEPTANCE_EXIT_MS);
    assert.deepEqual(phases, ['submitting', 'celebrating', 'exiting', null]);
    assert.equal(settled, 1, 'settled once the exit animation finished');
    assert.equal(clock.pending, 0);
  });

  it('keeps the workbench durations aligned between home cards and the result drawer', () => {
    assert.equal(ACCEPTANCE_CELEBRATION_MS, 980);
    assert.equal(ACCEPTANCE_EXIT_MS, 420);
  });

  it('awaits the submit promise before celebrating', async () => {
    const phases: (AcceptancePhase | null)[] = [];
    const clock = createManualScheduler();
    let resolveSubmit: (() => void) | undefined;

    const running = runAcceptanceTransition({
      submit: () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
      onPhase: (phase) => phases.push(phase),
      schedule: clock.schedule,
    });

    await Promise.resolve();
    assert.deepEqual(phases, ['submitting'], 'stays in submitting while the request is in flight');

    assert.ok(resolveSubmit, 'submit promise should expose its resolver');
    resolveSubmit();
    await running;
    assert.deepEqual(phases, ['submitting', 'celebrating']);
  });

  it('rolls back to a retryable state and reports the error when submit fails', async () => {
    const phases: (AcceptancePhase | null)[] = [];
    const clock = createManualScheduler();
    const failure = new Error('accept failed');
    let seen: unknown = null;
    let settled = 0;

    await runAcceptanceTransition({
      submit: () => {
        throw failure;
      },
      onPhase: (phase) => phases.push(phase),
      schedule: clock.schedule,
      onSettled: () => {
        settled += 1;
      },
      onFailed: (error) => {
        seen = error;
      },
    });

    assert.deepEqual(phases, ['submitting', null], 'no celebration or exit on failure');
    assert.equal(seen, failure);
    assert.equal(settled, 0, 'a failed acceptance must not close the result view');
    assert.equal(clock.pending, 0);
  });
});
