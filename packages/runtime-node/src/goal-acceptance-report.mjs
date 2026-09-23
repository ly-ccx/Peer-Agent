// Goal 验收报告构建器（纯函数，无 I/O）。
//
// 作用：plan 到达 completed 时，把「目标、任务完成情况、验收命令结果、
// 视觉判定结论、截图工件引用、证据索引」汇总成一份可追溯、可分享的
// markdown 验收报告。desktop host 负责落盘（goal-acceptance-report-writer）。
//
// 治理：本模块只做汇总渲染，不做执行、不落盘、不判定；所有事实来自
// Tool Result / Evidence / VerifierRun，报告本身是证据的视图，不是新证据。
// 无视觉判定 / 无截图时明确降级标注（而不是静默省略），让「验收可追溯」
// 的缺口可见。

const DESKTOP_PREVIEW_CAPABILITY = 'desktop_preview';
const SCREENSHOT_ARTIFACT_PREFIX = 'local-desktop-preview-artifact://';

const TASK_STATUS_MARKS = {
  completed: '✅',
  failed: '❌',
  cancelled: '⛔',
  executing: '🔄',
  running: '🔄',
  pending: '⏳',
  waiting_user: '⏸',
  awaiting_approval: '⏸',
};

function safeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function taskMark(status) {
  return TASK_STATUS_MARKS[status] ?? '·';
}

function renderTasksSection(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return ['## 任务完成情况', '', '（本计划没有子任务）'];
  const lines = ['## 任务完成情况', ''];
  for (const task of list) {
    const title = safeText(task?.title) || safeText(task?.taskId) || '（未命名任务）';
    const evidenceCount = Array.isArray(task?.evidenceRefs) ? task.evidenceRefs.length : 0;
    const note = task?.failureReason ? ` —— ${task.failureReason}` : '';
    lines.push(`- ${taskMark(task?.status)} ${title}（${task?.status ?? 'unknown'}${evidenceCount ? `，证据 ${evidenceCount} 条` : ''}）${note}`);
  }
  return lines;
}

function renderCriteriaSection(plan) {
  const criteria = Array.isArray(plan?.successCriteria) ? plan.successCriteria : [];
  if (criteria.length === 0) return null;
  const results = plan?.criterionResults ?? plan?.runner?.criterionResults ?? {};
  const byId = results && typeof results === 'object' ? results : {};
  const lines = ['## 验收命令结果', ''];
  for (const criterion of criteria) {
    const id = safeText(criterion?.id) || safeText(criterion?.criterionId);
    const result = id ? byId[id] ?? byId[criterion.criterionId] : undefined;
    const kind = safeText(criterion?.kind) || 'manual';
    const passed = result ? result.passed === true : null;
    const verdict = passed === null ? '未回写结果' : passed ? '通过' : '未通过';
    const description = safeText(criterion?.description) || safeText(criterion?.path) || id || '（未命名标准）';
    const command = safeText(criterion?.command);
    lines.push(`- ${passed === true ? '✅' : passed === false ? '❌' : '⏳'} [${kind}] ${description} —— ${verdict}${command ? `\n  - 命令：\`${command}\`` : ''}`);
  }
  return lines;
}

function pickLatestVisualReview(verifierRuns) {
  const runs = Array.isArray(verifierRuns) ? verifierRuns : [];
  const terminal = runs.filter((run) => run?.status === 'passed' || run?.status === 'failed');
  if (terminal.length === 0) return null;
  return terminal.reduce((latest, run) => (
    String(run.updatedAt || run.completedAt || '').localeCompare(String(latest.updatedAt || latest.completedAt || '')) >= 0
      ? run
      : latest
  ));
}

function renderVisualSection({ latestReview, visualGateArmed }) {
  const lines = ['## 视觉判定', ''];
  if (latestReview) {
    const passed = latestReview.status === 'passed';
    lines.push(`- 结论：${passed ? '✅ 通过' : '❌ 未通过'}（verifierRun ${safeText(latestReview.verifierRunId) || '未知'}）`);
    if (safeText(latestReview.summary)) lines.push(`- 摘要：${latestReview.summary}`);
    if (safeText(latestReview.failureReason)) lines.push(`- 失败原因：${latestReview.failureReason}`);
    if (passed) {
      const refs = Array.isArray(latestReview.evidenceRefs) ? latestReview.evidenceRefs : [];
      if (refs.length > 0) lines.push(`- 证据：${refs.map((ref) => `\`${ref}\``).join('、')}`);
    }
    return lines;
  }
  lines.push(visualGateArmed
    ? '- ⚠️ 本计划按 UI 交付武装了视觉验证门，但没有留下独立的视觉判定记录。完成门曾因此阻塞，当前 completed 状态缺乏视觉验收支撑，建议复核。'
    : '- 本计划没有独立的视觉判定记录（非 UI 交付或未触发视觉验证）。');
  return lines;
}

function collectScreenshotRecords(evidenceRecords) {
  const records = Array.isArray(evidenceRecords) ? evidenceRecords : [];
  return records.filter((record) => record?.capabilityId === DESKTOP_PREVIEW_CAPABILITY
    && Array.isArray(record?.artifactRefs)
    && record.artifactRefs.some((ref) => typeof ref === 'string' && ref.startsWith(SCREENSHOT_ARTIFACT_PREFIX)));
}

function renderScreenshotSection(screenshotRecords) {
  const lines = ['## 截图工件', ''];
  if (screenshotRecords.length === 0) {
    lines.push('- ⚠️ 没有桌面预览截图工件（`local-desktop-preview-artifact://`）。UI 交付缺少像素证据，无法回看视觉验收依据。');
    return lines;
  }
  for (const record of screenshotRecords) {
    const artifacts = (record.artifactRefs ?? []).filter((ref) => ref.startsWith(SCREENSHOT_ARTIFACT_PREFIX));
    for (const ref of artifacts) {
      lines.push(`![验收截图](${ref})`);
      lines.push('');
      lines.push(`- 来源证据：\`${record.evidenceRef ?? '未知'}\``);
    }
  }
  return lines;
}

function renderEvidenceSection(evidenceRecords, screenshotRecords) {
  const records = Array.isArray(evidenceRecords) ? evidenceRecords : [];
  const others = records.filter((record) => !screenshotRecords.includes(record));
  const lines = ['## 证据索引', ''];
  if (records.length === 0) {
    lines.push('- （没有已登记的证据记录）');
    return lines;
  }
  lines.push('| 证据 | 来源 | 工件 | 时间 |', '| --- | --- | --- | --- |');
  for (const record of records) {
    const source = safeText(record.toolName) || safeText(record.capabilityId) || 'unknown';
    const artifactCount = Array.isArray(record.artifactRefs) ? record.artifactRefs.length : 0;
    const marker = screenshotRecords.includes(record) ? ' 📷' : '';
    lines.push(`| \`${safeText(record.evidenceRef) || '未知'}\`${marker} | ${source} | ${artifactCount} 项 | ${safeText(record.createdAt) || '未知'} |`);
  }
  if (others.length === 0 && screenshotRecords.length > 0) {
    lines.push('', '> 本计划的证据全部为截图工件。');
  }
  return lines;
}

/**
 * 构建验收报告。
 *
 * @param {object} input
 * @param {object} input.plan 已完成的 plan（normalizePlan 形状）
 * @param {Array}  [input.evidenceRecords] 证据索引中该 plan 的记录（normalizeEvidenceIndexRecord 形状）
 * @param {Array}  [input.verifierRuns] plan.runner?.verifierRuns
 * @param {boolean}[input.visualGateArmed] 完成门是否曾按 UI 交付武装
 * @param {string} [input.reportPath] 报告落盘路径（写进报告尾部，便于回指）
 * @param {string} [input.generatedAt] 生成时间 ISO
 * @returns {{ markdown: string, screenshots: string[], warnings: string[] }}
 */
export function buildGoalAcceptanceReport(input = {}) {
  const plan = input.plan ?? {};
  const evidenceRecords = Array.isArray(input.evidenceRecords) ? input.evidenceRecords : [];
  const generatedAt = safeText(input.generatedAt) || new Date().toISOString();
  const screenshotRecords = collectScreenshotRecords(evidenceRecords);
  const screenshotRefs = screenshotRecords.flatMap((record) => (record.artifactRefs ?? []).filter((ref) => ref.startsWith(SCREENSHOT_ARTIFACT_PREFIX)));
  const latestReview = pickLatestVisualReview(input.verifierRuns);

  const warnings = [];
  if (screenshotRefs.length === 0) warnings.push('no-screenshot-artifacts');
  if (!latestReview) warnings.push(input.visualGateArmed ? 'armed-but-no-visual-review' : 'no-visual-review');
  if (plan?.status !== 'completed') warnings.push(`plan-status-${plan?.status ?? 'unknown'}`);

  const title = safeText(plan.title) || safeText(plan.goal) || '（未命名目标）';
  const lines = [
    `# Goal 验收报告：${title}`,
    '',
    `- 计划：\`${safeText(plan.planId) || '未知'}\``,
    `- 状态：${safeText(plan.status) || 'unknown'}`,
    `- 生成时间：${generatedAt}`,
  ];
  if (safeText(plan.conversationId)) lines.push(`- 会话：\`${plan.conversationId}\``);
  if (safeText(input.reportPath)) lines.push(`- 报告文件：\`${input.reportPath}\``);
  const goalText = safeText(plan.goal);
  lines.push('', '## 目标', '', goalText || '（无目标描述）');
  lines.push('', ...renderTasksSection(plan.tasks));

  const criteriaLines = renderCriteriaSection(plan);
  if (criteriaLines) lines.push('', ...criteriaLines);

  lines.push('', ...renderVisualSection({ latestReview, visualGateArmed: input.visualGateArmed === true }));
  lines.push('', ...renderScreenshotSection(screenshotRecords));
  lines.push('', ...renderEvidenceSection(evidenceRecords, screenshotRecords));
  lines.push('', '---', '', '*本报告由 Peer Agent 在 goal 完成时自动汇总生成；所有事实来自 Evidence / VerifierRun，报告是证据视图而非新证据。*');

  return { markdown: `${lines.join('\n')}\n`, screenshots: screenshotRefs, warnings };
}
