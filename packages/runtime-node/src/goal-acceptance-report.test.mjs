import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGoalAcceptanceReport } from './goal-acceptance-report.mjs';

const basePlan = {
  planId: 'plan-rpt-1',
  title: '隐藏空态筛选栏',
  goal: '没有内容的时候，这一栏不用显示',
  status: 'completed',
  conversationId: 'conv-1',
  tasks: [
    { taskId: 't1', title: '定位渲染分支', status: 'completed', evidenceRefs: ['ev-1'] },
    { taskId: 't2', title: '补回归测试', status: 'completed', evidenceRefs: ['ev-2'] },
  ],
  successCriteria: [
    { id: 'c1', kind: 'command', command: 'node --test x.test.mjs', description: '回归测试通过' },
  ],
  criterionResults: { c1: { passed: true } },
};

const screenshotRecord = {
  evidenceRef: 'ev-shot-1',
  capabilityId: 'desktop_preview',
  toolName: 'desktop_preview',
  createdAt: '2026-09-23T15:10:00.000Z',
  artifactRefs: ['local-desktop-preview-artifact://shot-abc.png'],
};

const visualRun = {
  verifierRunId: 'vr-1',
  status: 'passed',
  summary: '空态下筛选栏已隐藏，与设计一致',
  evidenceRefs: ['ev-shot-1'],
  updatedAt: '2026-09-23T15:11:00.000Z',
};

test('acceptance-report/完整渲染-含截图引用与视觉判定', () => {
  const report = buildGoalAcceptanceReport({
    plan: basePlan,
    evidenceRecords: [screenshotRecord],
    verifierRuns: [visualRun],
    visualGateArmed: true,
    reportPath: '/tmp/goal-reports/plan-rpt-1.md',
    generatedAt: '2026-09-23T15:12:00.000Z',
  });
  assert.ok(report.markdown.includes('# Goal 验收报告：隐藏空态筛选栏'));
  assert.ok(report.markdown.includes('![验收截图](local-desktop-preview-artifact://shot-abc.png)'));
  assert.ok(report.markdown.includes('✅ 通过'));
  assert.ok(report.markdown.includes('node --test x.test.mjs'));
  assert.ok(report.markdown.includes('—— 通过'));
  assert.deepEqual(report.screenshots, ['local-desktop-preview-artifact://shot-abc.png']);
  assert.deepEqual(report.warnings, []);
});

test('acceptance-report/无视觉判定-武装时降级警告', () => {
  const report = buildGoalAcceptanceReport({
    plan: basePlan,
    evidenceRecords: [screenshotRecord],
    verifierRuns: [],
    visualGateArmed: true,
  });
  assert.ok(report.markdown.includes('完成门曾因此阻塞'));
  assert.ok(report.warnings.includes('armed-but-no-visual-review'));
});

test('acceptance-report/无截图工件-明确标注缺口', () => {
  const report = buildGoalAcceptanceReport({
    plan: basePlan,
    evidenceRecords: [{ evidenceRef: 'ev-1', toolName: 'bash', createdAt: '2026-09-23T15:00:00.000Z', artifactRefs: [] }],
    verifierRuns: [visualRun],
  });
  assert.ok(report.markdown.includes('没有桌面预览截图工件'));
  assert.ok(report.warnings.includes('no-screenshot-artifacts'));
});

test('acceptance-report/空任务空标准边界', () => {
  const report = buildGoalAcceptanceReport({
    plan: { ...basePlan, tasks: [], successCriteria: [], criterionResults: undefined },
    evidenceRecords: [],
    verifierRuns: [],
  });
  assert.ok(report.markdown.includes('（本计划没有子任务）'));
  assert.ok(!report.markdown.includes('## 验收命令结果'));
  assert.ok(report.warnings.includes('no-screenshot-artifacts'));
});

test('acceptance-report/失败视觉判定如实呈现', () => {
  const report = buildGoalAcceptanceReport({
    plan: basePlan,
    evidenceRecords: [screenshotRecord],
    verifierRuns: [{ verifierRunId: 'vr-2', status: 'failed', failureReason: '间距超差', updatedAt: '2026-09-23T15:09:00.000Z' }],
  });
  assert.ok(report.markdown.includes('❌ 未通过'));
  assert.ok(report.markdown.includes('间距超差'));
});

test('acceptance-report/非completed状态标记警告', () => {
  const report = buildGoalAcceptanceReport({ plan: { ...basePlan, status: 'executing' } });
  assert.ok(report.warnings.includes('plan-status-executing'));
});

test('acceptance-report/纯函数-同输入同输出', () => {
  const input = {
    plan: basePlan,
    evidenceRecords: [screenshotRecord],
    verifierRuns: [visualRun],
    generatedAt: '2026-09-23T15:12:00.000Z',
  };
  assert.deepEqual(buildGoalAcceptanceReport(input), buildGoalAcceptanceReport(input));
});
