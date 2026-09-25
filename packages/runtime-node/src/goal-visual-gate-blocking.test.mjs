import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateVerificationGate } from './goal-runner.mjs';

// 完成门契约（criterion 2）：plan 被标记为需要视觉验证（uiDeliveryRequired）
// 且尚无 passed 视觉判定（authority 缺失 / 判定元数据残缺）时，gate 不通过 ——
// unmet 必须出现 ui_delivery（fail-closed）。机械缺口（任务证据 / 验收命令）
// 优先浮现，机械全绿后 ui_delivery 缺口仍会阻塞。
// “passed 判定后解除”的三元组语义由 desktop 的 authority/visual-verifier
// 测试覆盖（@peer-agent/protocol evaluateUiDelivery）。

const plan = {
  planId: 'plan-blocked-1',
  status: 'executing',
  successCriteria: [{ id: 'c1', kind: 'command', command: 'node --test x.test.mjs' }],
  tasks: [
    { taskId: 't1', title: '实现', status: 'completed', evidenceRefs: ['ev-1'] },
    { taskId: 't2', title: '验证', status: 'completed', evidenceRefs: ['ev-2'] },
  ],
};

function unmetKinds(result) {
  return (result?.unmet ?? []).map((item) => item.kind);
}

test('visual-gate-blocking/required且authority缺失时fail-closed', () => {
  const result = evaluateVerificationGate(plan, { uiDeliveryRequired: true, uiDelivery: null });
  assert.equal(result.passed, false);
  assert.ok(unmetKinds(result).includes('ui_delivery'), JSON.stringify(result));
  assert.ok(result.unmet.some((item) => item.reason === 'ui_delivery_authority_missing'));
});

test('visual-gate-blocking/required且判定元数据残缺时fail-closed', () => {
  const result = evaluateVerificationGate(plan, {
    uiDeliveryRequired: true,
    uiDelivery: { requirements: null, observations: [], judgments: [] },
  });
  assert.equal(result.passed, false);
  assert.ok(unmetKinds(result).includes('ui_delivery'), JSON.stringify(result));
});

test('visual-gate-blocking/不required时无ui_delivery阻塞', () => {
  const result = evaluateVerificationGate(plan, { uiDeliveryRequired: false });
  assert.ok(!unmetKinds(result).includes('ui_delivery'), JSON.stringify(result));
});

test('visual-gate-blocking/机械缺口优先且不被视觉门掩盖', () => {
  const result = evaluateVerificationGate(plan, { uiDeliveryRequired: false });
  // c1 的验收命令未在 criterionResults 里验证 → 机械缺口必须可见。
  assert.ok(result.unmet.some((item) => item.kind === 'command' && item.reason === 'criterion_unverified'), JSON.stringify(result));
});
