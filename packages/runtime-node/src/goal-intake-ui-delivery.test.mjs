import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyUiDeliveryIntake } from './goal-intake-ui-delivery.mjs';
import { createGoalPlanStore } from './goal-plan-store.mjs';

// ── 纯函数判定 ────────────────────────────────────────────────────────────

test('intake-ui/命中-会话95d2e647同款空状态栏目标', () => {
  const verdict = classifyUiDeliveryIntake({
    goal: '没有内容的时候，这一栏不用显示，与“没有数据”空状态保持一致',
    tasks: [{ title: '隐藏空态下的筛选栏' }],
  });
  assert.equal(verdict.required, true);
  assert.ok(verdict.reasons.some((reason) => reason.startsWith('ui-surface:')));
});

test('intake-ui/命中-英文组件样式修改', () => {
  const verdict = classifyUiDeliveryIntake({
    goal: 'Adjust the header button spacing and hover state in the settings modal',
  });
  assert.equal(verdict.required, true);
  assert.equal(verdict.confidence, 'high');
});

test('intake-ui/不命中-纯测试目标', () => {
  const verdict = classifyUiDeliveryIntake({
    goal: '为 goal-plan-store 的取消链路补单元测试',
    tasks: [{ title: '新增回归测试' }],
  });
  assert.equal(verdict.required, false);
});

test('intake-ui/不命中-元目标-截图验证机制本身', () => {
  const verdict = classifyUiDeliveryIntake({
    goal: '实现自动截图验证：goal 建立时武装视觉验证门与完成门',
    tasks: [{ title: 'runtime-node 判定模块 + 单测' }],
  });
  assert.equal(verdict.required, false);
});

test('intake-ui/不命中-纯后端目标', () => {
  const verdict = classifyUiDeliveryIntake({
    goal: '数据库迁移脚本：把 usage 表按天聚合，后端 CLI 导出',
  });
  assert.equal(verdict.required, false);
});

test('intake-ui/命中-验证机制词汇与UI词汇共现时不误判为元目标', () => {
  const verdict = classifyUiDeliveryIntake({
    goal: '修一下设置页按钮的截图验证：按钮在暗色主题下描边丢失',
  });
  assert.equal(verdict.required, true);
});

test('intake-ui/判定为纯函数-同输入同输出', () => {
  const input = { title: '样式调整', goal: '主题颜色' };
  assert.deepEqual(classifyUiDeliveryIntake(input), classifyUiDeliveryIntake(input));
});

// ── store 接线：契约建立/修订/intake 升级时武装回调 ───────────────────────

function withTempStore(extraOptions = {}) {
  const storeDir = mkdtempSync(path.join(os.tmpdir(), 'peer-intake-ui-'));
  const store = createGoalPlanStore({ storeDir, ...extraOptions });
  return { store, cleanup: () => rmSync(storeDir, { recursive: true, force: true }) };
}

test('intake-ui/store-createGoalContract命中则回调武装', () => {
  const armed = [];
  const { store, cleanup } = withTempStore({
    onUiDeliveryRequired: (plan, verdict, meta) => armed.push({ planId: plan.planId, verdict, meta }),
  });
  try {
    const plan = store.createGoalContract({ goal: '调整弹窗样式：圆角与阴影对齐设计稿', conversationId: 'conv-ui' });
    assert.equal(armed.length, 1);
    assert.equal(armed[0].planId, plan.planId);
    assert.equal(armed[0].meta.phase, 'goal-created');
    assert.equal(armed[0].verdict.required, true);
  } finally {
    cleanup();
  }
});

test('intake-ui/store-非UI目标不回调', () => {
  const armed = [];
  const { store, cleanup } = withTempStore({
    onUiDeliveryRequired: (plan) => armed.push(plan.planId),
  });
  try {
    store.createGoalContract({ goal: '整理导出脚本的命令行参数解析', conversationId: 'conv-cli' });
    assert.equal(armed.length, 0);
  } finally {
    cleanup();
  }
});

test('intake-ui/store-intake契约不武装-升级后才武装', () => {
  const armed = [];
  const { store, cleanup } = withTempStore({
    onUiDeliveryRequired: (plan, _verdict, meta) => armed.push({ planId: plan.planId, meta }),
  });
  try {
    const intake = store.createIntakeContract({ goal: '改一下首页导航栏', conversationId: 'conv-intake' });
    assert.equal(armed.length, 0);
    const promoted = store.promoteIntakeToGoal(intake.planId, {});
    assert.equal(armed.length, 1);
    assert.equal(armed[0].planId, promoted.planId);
    assert.equal(armed[0].meta.phase, 'intake-promoted');
  } finally {
    cleanup();
  }
});

test('intake-ui/store-计划修订新增UI信号时补武装', () => {
  const armed = [];
  const { store, cleanup } = withTempStore({
    onUiDeliveryRequired: (plan) => armed.push(plan.planId),
  });
  try {
    store.createGoalContract({ goal: '给导出流程补齐重试与超时处理', conversationId: 'conv-revise' });
    assert.equal(armed.length, 0);
    store.upsertGoalContract('conv-revise', {
      goal: '给导出流程补齐重试与超时处理，并修复结果页空状态样式',
      status: 'accepted',
    });
    assert.equal(armed.length, 1);
  } finally {
    cleanup();
  }
});

test('intake-ui/store-无回调宿主时完全no-op', () => {
  const { store, cleanup } = withTempStore();
  try {
    const plan = store.createGoalContract({ goal: '按钮颜色改成主题色', conversationId: 'conv-noop' });
    assert.ok(plan?.planId);
  } finally {
    cleanup();
  }
});
