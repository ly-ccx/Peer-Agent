// Goal 验收报告写入器（desktop host 侧）。
//
// 作用：plan 完成迁移时（goal-plan-store onPlanCompleted seam）把验收报告
// markdown 落盘到 `~/.peer-agent/goal-reports/<planId>.md`。事实全部来自
// store 的证据索引与 runner.verifierRuns，报告是证据视图而非新证据。
// 写盘失败只记日志，绝不影响已完成的 plan 状态。

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildGoalAcceptanceReport, getDataHome } from '@peer-agent/runtime-node';

export function createGoalAcceptanceReportWriter({
  goalPlanStore,
  reportsDir,
  now = () => new Date().toISOString(),
  log = (message) => console.warn(message),
} = {}) {
  const dir = reportsDir ?? path.join(getDataHome(), 'goal-reports');

  function listPlanEvidence(planId) {
    const listAll = goalPlanStore?.listEvidenceIndex;
    if (typeof listAll !== 'function') return [];
    try {
      return listAll().filter((record) => record?.planId === planId);
    } catch (error) {
      log(`[goal-report] evidence index read failed for ${planId}: ${error?.message || error}`);
      return [];
    }
  }

  /**
   * 为已完成 plan 生成并写入验收报告。
   * @returns {{ path: string, screenshots: number, warnings: string[] } | null}
   */
  function writeForPlan(plan) {
    if (!plan?.planId || plan.status !== 'completed') return null;
    const evidenceRecords = listPlanEvidence(plan.planId);
    const verifierRuns = Array.isArray(plan?.runner?.verifierRuns) ? plan.runner.verifierRuns : [];
    let visualGateArmed = false;
    if (typeof goalPlanStore?.isUiDeliveryRequired === 'function') {
      try {
        visualGateArmed = goalPlanStore.isUiDeliveryRequired(plan) === true;
      } catch { /* 读取失败按未武装 */ }
    }
    const filePath = path.join(dir, `${plan.planId}.md`);
    const report = buildGoalAcceptanceReport({
      plan,
      evidenceRecords,
      verifierRuns,
      visualGateArmed,
      reportPath: filePath,
      generatedAt: now(),
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, report.markdown, 'utf8');
    log(`[goal-report] acceptance report written: ${filePath} screenshots=${report.screenshots.length} warnings=${report.warnings.join(',') || 'none'}`);
    return { path: filePath, screenshots: report.screenshots.length, warnings: report.warnings };
  }

  return { writeForPlan, reportsDir: dir };
}
