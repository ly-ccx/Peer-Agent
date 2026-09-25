import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from '@peer-agent/runtime-node';
import { createGoalAcceptanceReportWriter } from './goal-acceptance-report-writer.mjs';

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('acceptance-report-writer/completed迁移时落盘报告到临时目录', () => {
  const storeDir = tempDir('peer-report-store-');
  const reportsDir = tempDir('peer-report-out-');
  let completedPlan = null;
  const store = createGoalPlanStore({
    storeDir,
    onPlanCompleted: (plan) => {
      completedPlan = plan;
      writer.writeForPlan(plan);
    },
  });
  const writer = createGoalAcceptanceReportWriter({ goalPlanStore: store, reportsDir });
  try {
    const plan = store.createGoalContract({ goal: '隐藏空态筛选栏，对齐设计稿', conversationId: 'conv-rpt' });
    store.recordEvidenceRefs({
      evidenceRef: 'ev-shot-1',
      planId: plan.planId,
      capabilityId: 'desktop_preview',
      toolName: 'desktop_preview',
      artifactRefs: ['local-desktop-preview-artifact://shot-1.png'],
    });
    const result = store.setPlanStatus(plan.planId, 'completed');
    assert.ok(result?.status === 'completed' || completedPlan, `expected completed transition, got ${result?.status}`);
    assert.ok(completedPlan, 'onPlanCompleted seam should fire');
    const reportPath = path.join(reportsDir, `${plan.planId}.md`);
    assert.ok(existsSync(reportPath), 'report file should exist');
    const markdown = readFileSync(reportPath, 'utf8');
    assert.ok(markdown.includes('# Goal 验收报告'));
    assert.ok(markdown.includes('local-desktop-preview-artifact://shot-1.png'));
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(reportsDir, { recursive: true, force: true });
  }
});

test('acceptance-report-writer/非completed计划拒绝写入', () => {
  const writer = createGoalAcceptanceReportWriter({
    goalPlanStore: { listEvidenceIndex: () => [] },
    reportsDir: tempDir('peer-report-skip-'),
  });
  const result = writer.writeForPlan({ planId: 'plan-x', status: 'executing' });
  assert.equal(result, null);
});

test('acceptance-report-writer/无截图证据时产出降级警告', () => {
  const reportsDir = tempDir('peer-report-warn-');
  const writer = createGoalAcceptanceReportWriter({
    goalPlanStore: { listEvidenceIndex: () => [], isUiDeliveryRequired: () => false },
    reportsDir,
  });
  const result = writer.writeForPlan({
    planId: 'plan-y',
    status: 'completed',
    title: '纯后端目标',
    goal: '整理脚本',
    tasks: [],
  });
  assert.ok(result);
  assert.ok(result.warnings.includes('no-screenshot-artifacts'));
  assert.ok(existsSync(result.path));
  rmSync(reportsDir, { recursive: true, force: true });
});
