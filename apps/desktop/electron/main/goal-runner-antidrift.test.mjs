import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeReanchorInterval,
  shouldReanchor,
  computePlanScopeSnapshot,
  detectPlanDrift,
  evaluateVerificationGate,
} from './goal-runner.mjs';

// 防偏航系统纯函数单测（见 goal-mode-ultrathink-workflow 设计文档第六、八章）。
// 覆盖:re-anchor 自适应间隔与触发、drift 检测（膨胀/误报边界）、verification gate 阻断无证据完成。

describe('computeReanchorInterval', () => {
  it('clamps to [2, 6] with ceil(taskCount/3)', () => {
    assert.equal(computeReanchorInterval(0), 2); // 空计划取下界
    assert.equal(computeReanchorInterval(1), 2); // ceil(1/3)=1 → clamp 到 2
    assert.equal(computeReanchorInterval(6), 2); // ceil(6/3)=2
    assert.equal(computeReanchorInterval(9), 3); // ceil(9/3)=3
    assert.equal(computeReanchorInterval(18), 6); // ceil(18/3)=6
    assert.equal(computeReanchorInterval(100), 6); // 超上界收敛到 6
  });

  it('is defensive against non-finite input', () => {
    assert.equal(computeReanchorInterval(undefined), 2);
    assert.equal(computeReanchorInterval(NaN), 2);
    assert.equal(computeReanchorInterval(-5), 2);
  });
});

describe('shouldReanchor', () => {
  it('triggers every interval turns (turnNumber from 1)', () => {
    assert.equal(shouldReanchor(1, 3), false);
    assert.equal(shouldReanchor(2, 3), false);
    assert.equal(shouldReanchor(3, 3), true);
    assert.equal(shouldReanchor(6, 3), true);
    assert.equal(shouldReanchor(4, 3), false);
  });

  it('forced=true triggers immediately regardless of turn', () => {
    assert.equal(shouldReanchor(1, 5, true), true);
    assert.equal(shouldReanchor(0, 5, true), true);
  });

  it('does not trigger at turn 0 without forced', () => {
    assert.equal(shouldReanchor(0, 3), false);
  });
});

describe('computePlanScopeSnapshot', () => {
  it('counts nested tasks and de-duplicates involved files', () => {
    const plan = {
      tasks: [
        { taskId: 'a', involvedFiles: ['x.ts', 'y.ts'], subtasks: [
          { taskId: 'a1', involvedFiles: ['x.ts', 'z.ts'] },
        ] },
        { taskId: 'b', involvedFiles: ['y.ts'] },
      ],
    };
    const snap = computePlanScopeSnapshot(plan);
    assert.equal(snap.taskCount, 3); // a, a1, b
    assert.equal(snap.fileCount, 3); // x.ts, y.ts, z.ts (去重)
  });

  it('handles empty/malformed plans', () => {
    assert.deepEqual(computePlanScopeSnapshot(null), { taskCount: 0, fileCount: 0 });
    assert.deepEqual(computePlanScopeSnapshot({ tasks: [] }), { taskCount: 0, fileCount: 0 });
  });
});

describe('detectPlanDrift', () => {
  it('flags task-count inflation beyond ratio AND absolute delta', () => {
    const baseline = { taskCount: 4, fileCount: 2 };
    const current = { taskCount: 9, fileCount: 2 }; // 9 ≥ 4×2 且 +5 ≥ 3
    const r = detectPlanDrift(baseline, current);
    assert.equal(r.drifted, true);
    assert.match(r.reasons.join(' '), /task count/);
  });

  it('flags involved-files inflation', () => {
    const baseline = { taskCount: 3, fileCount: 2 };
    const current = { taskCount: 3, fileCount: 6 }; // 6 ≥ 2×2 且 +4 ≥ 3
    const r = detectPlanDrift(baseline, current);
    assert.equal(r.drifted, true);
    assert.match(r.reasons.join(' '), /involved files/);
  });

  it('does not false-positive on small absolute growth even if ratio doubles', () => {
    // 1 → 2:比值达到 ×2,但绝对增量仅 +1 < 3,不判漂移(避免小规模误报)。
    const r = detectPlanDrift({ taskCount: 1, fileCount: 1 }, { taskCount: 2, fileCount: 2 });
    assert.equal(r.drifted, false);
  });

  it('does not flag steady or shrinking scope', () => {
    assert.equal(detectPlanDrift({ taskCount: 5, fileCount: 5 }, { taskCount: 5, fileCount: 5 }).drifted, false);
    assert.equal(detectPlanDrift({ taskCount: 8, fileCount: 8 }, { taskCount: 4, fileCount: 4 }).drifted, false);
  });

  it('is defensive against missing snapshots', () => {
    assert.equal(detectPlanDrift(null, { taskCount: 9, fileCount: 9 }).drifted, false);
    assert.equal(detectPlanDrift({ taskCount: 1, fileCount: 1 }, null).drifted, false);
  });
});

describe('evaluateVerificationGate', () => {
  it('passes only when every leaf is completed with evidence', () => {
    const plan = {
      tasks: [
        { taskId: 'a', status: 'completed', evidenceRefs: ['ref://1'] },
        { taskId: 'b', subtasks: [
          { taskId: 'b1', status: 'completed', evidenceRefs: ['ref://2'] },
        ] },
      ],
    };
    const gate = evaluateVerificationGate(plan);
    assert.equal(gate.passed, true);
    assert.equal(gate.unmet.length, 0);
  });

  it('blocks when a leaf is completed but has no evidence', () => {
    const plan = {
      tasks: [
        { taskId: 'a', status: 'completed', evidenceRefs: ['ref://1'] },
        { taskId: 'b', status: 'completed', evidenceRefs: [] },
      ],
    };
    const gate = evaluateVerificationGate(plan);
    assert.equal(gate.passed, false);
    assert.equal(gate.unmet.length, 1);
    assert.equal(gate.unmet[0].taskId, 'b');
    assert.equal(gate.unmet[0].reason, 'missing_evidence');
  });

  it('blocks when a leaf is not completed', () => {
    const plan = {
      tasks: [
        { taskId: 'a', status: 'running', evidenceRefs: ['ref://1'] },
      ],
    };
    const gate = evaluateVerificationGate(plan);
    assert.equal(gate.passed, false);
    assert.equal(gate.unmet[0].reason, 'not_completed');
  });

  it('does not pass an empty plan (no verifiable evidence)', () => {
    const gate = evaluateVerificationGate({ tasks: [] });
    assert.equal(gate.passed, false);
    assert.equal(gate.reason, 'no_leaf_tasks');
  });
});
