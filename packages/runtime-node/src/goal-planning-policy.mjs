

const INSPECT_EXPLORER_MAX_TOOL_CALLS = 4;

const INSPECT_EXPLORER_MAX_DURATION_MS = 120000;

export function collectLeafTasks(plan) {
  const out = [];
  const stack = Array.isArray(plan?.tasks) ? [...plan.tasks] : [];
  while (stack.length > 0) {
    const task = stack.shift();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      for (const child of subtasks) stack.push(child);
      continue;
    }
    out.push(task);
  }
  return out;
}

function collectStringSet(values) {
  const refs = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value === 'string' && value.trim()) refs.add(value.trim());
  }
  return refs;
}

function collectKnownInvolvedFiles(plan, leafTasks = collectLeafTasks(plan)) {
  const files = collectStringSet(plan?.involvedFiles);
  for (const task of leafTasks) {
    for (const file of collectStringSet(task?.involvedFiles)) files.add(file);
  }
  return Array.from(files);
}

function hasCompletedExplorerReport(plan) {
  return (Array.isArray(plan?.runner?.explorers) ? plan.runner.explorers : [])
    .some((run) => run?.status === 'completed' && run.report);
}

function collectAutoSuccessCriteria(plan) {
  return (Array.isArray(plan?.successCriteria) ? plan.successCriteria : [])
    .filter((criterion) => (
      criterion &&
      typeof criterion === 'object' &&
      typeof criterion.kind === 'string' &&
      criterion.kind !== 'manual'
    ));
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function buildInspectScope(plan, knownFiles) {
  const include = [];
  if (typeof plan?.targetWorkspacePath === 'string' && plan.targetWorkspacePath.trim()) {
    include.push(plan.targetWorkspacePath.trim());
  }
  for (const item of collectStringSet(plan?.boundaries?.inScope)) include.push(item);
  for (const file of knownFiles) include.push(file);

  const exclude = Array.from(collectStringSet(plan?.boundaries?.outOfScope));
  return {
    ...(include.length > 0 ? { include: Array.from(new Set(include)).slice(0, 12) } : {}),
    ...(exclude.length > 0 ? { exclude: Array.from(new Set(exclude)).slice(0, 12) } : {}),
  };
}

export function createDeterministicExplorePlan(plan, { generatedAt = new Date().toISOString() } = {}) {
  const leafTasks = collectLeafTasks(plan);
  const knownFiles = collectKnownInvolvedFiles(plan, leafTasks);
  const autoCriteria = collectAutoSuccessCriteria(plan);
  const hasTargetWorkspace =
    typeof plan?.targetWorkspacePath === 'string' && plan.targetWorkspacePath.trim().length > 0;
  const hasCompletedExplorer = hasCompletedExplorerReport(plan);
  const missingTaskFileScope =
    leafTasks.length > 0 && leafTasks.some((task) => !Array.isArray(task.involvedFiles) || task.involvedFiles.length === 0);
  const complexEnoughForDeterministicInspect =
    hasTargetWorkspace || autoCriteria.length > 0 || leafTasks.length >= 4;
  const questions = [];

  if (!hasCompletedExplorer && complexEnoughForDeterministicInspect && missingTaskFileScope) {
    const scope = buildInspectScope(plan, knownFiles);
    const target = firstNonEmptyString(plan?.targetWorkspacePath, plan?.title, plan?.goal, 'the target workspace');
    questions.push({
      question: `Identify the primary files, modules, and existing implementation paths needed before acting on: ${target}`,
      reason: 'Deterministic inspect requires repository context and task-to-file grounding before act.',
      ...(Object.keys(scope).length > 0 ? { scope } : {}),
      budget: {
        maxToolCalls: INSPECT_EXPLORER_MAX_TOOL_CALLS,
        maxDurationMs: INSPECT_EXPLORER_MAX_DURATION_MS,
      },
    });
  }

  if (!hasCompletedExplorer && autoCriteria.length > 0 && knownFiles.length === 0) {
    const scope = buildInspectScope(plan, knownFiles);
    questions.push({
      question: 'Identify the read-only verification path for the automatic success criteria before acting.',
      reason: 'Deterministic inspect requires a verifiable test/check path before act.',
      ...(Object.keys(scope).length > 0 ? { scope } : {}),
      budget: {
        maxToolCalls: INSPECT_EXPLORER_MAX_TOOL_CALLS,
        maxDurationMs: INSPECT_EXPLORER_MAX_DURATION_MS,
      },
    });
  }

  return {
    requiredBeforeAct: questions.length > 0,
    questions,
    exitCriteria: [
      'primary modules/files identified or an Explorer report explains why they cannot be identified yet',
      'automatic verification path identified when automatic success criteria exist',
      'remaining unknowns are explicit and acceptable before act',
    ],
    generatedAt,
  };
}

// ── 防偏航系统（见 goal-mode-ultrathink-workflow 设计文档第六、八章）──────────────
//
// Goal 模式允许 Agent 自主执行,但不允许自主改目标。以下为纯函数护栏,便于单测:
// - re-anchor:周期性重申原始目标+成功标准,频率自适应任务规模(设计文档开放问题6拍板)。
// - drift 检测:范围/文件/任务膨胀超阈值即判定漂移,交由 pump 暂停问人。
// - verification gate:完成前要求所有叶子任务已完成且带 Evidence,阻断"无证据的口头完成"。

export const REANCHOR_MIN_INTERVAL = 2;

const REANCHOR_MAX_INTERVAL = 6;

/** 任务/文件相对基线的膨胀比阈值(超过即视为范围漂移)。 */
const DRIFT_INFLATION_RATIO = 2;

/** 允许的绝对增量下限(小规模计划避免比值误报:未超过该增量不算漂移)。 */
const DRIFT_MIN_ABSOLUTE_DELTA = 3;

/**
 * re-anchor 间隔:clamp(ceil(taskCount/3), 2, 6)。
 * 小任务不浪费、大任务防漂移(设计文档开放问题6)。
 */
export function computeReanchorInterval(taskCount) {
  const n = Number.isFinite(taskCount) ? Math.max(0, Math.trunc(taskCount)) : 0;
  const base = Math.ceil(n / 3);
  return Math.min(REANCHOR_MAX_INTERVAL, Math.max(REANCHOR_MIN_INTERVAL, base || REANCHOR_MIN_INTERVAL));
}

/**
 * 是否应在本轮 re-anchor。forced=true(如计划修订后、长 Explorer 批次返回后)立即触发;
 * 否则每 interval 轮触发一次(turnNumber 从 1 起)。
 */
export function shouldReanchor(turnNumber, interval, forced = false) {
  if (forced) return true;
  const t = Number.isFinite(turnNumber) ? Math.trunc(turnNumber) : 0;
  const step = Number.isFinite(interval) && interval > 0 ? Math.trunc(interval) : REANCHOR_MIN_INTERVAL;
  if (t <= 0) return false;
  return t % step === 0;
}

/** 计划范围快照:任务总数(含嵌套)+ 去重后的 involvedFiles 数。用于 drift 基线与比较。 */
export function computePlanScopeSnapshot(plan) {
  const roots = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const files = new Set();
  let taskCount = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task || typeof task !== 'object') continue;
    taskCount += 1;
    if (Array.isArray(task.involvedFiles)) {
      for (const f of task.involvedFiles) if (typeof f === 'string' && f.trim()) files.add(f.trim());
    }
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    for (const child of subtasks) stack.push(child);
  }
  return { taskCount, fileCount: files.size };
}

/**
 * 范围漂移检测:相对基线,任务数或文件数膨胀既超过比值阈值(×DRIFT_INFLATION_RATIO)
 * 又超过绝对增量下限(+DRIFT_MIN_ABSOLUTE_DELTA)时判定漂移。两个条件同时满足才报,
 * 避免小规模计划因比值敏感而误报。
 */
export function detectPlanDrift(baseline, current) {
  const reasons = [];
  if (!baseline || !current) return { drifted: false, reasons };
  const check = (label, base, cur) => {
    const b = Number.isFinite(base) ? base : 0;
    const c = Number.isFinite(cur) ? cur : 0;
    const delta = c - b;
    if (delta >= DRIFT_MIN_ABSOLUTE_DELTA && c >= b * DRIFT_INFLATION_RATIO && b >= 1) {
      reasons.push(`${label} inflated from ${b} to ${c}`);
    }
  };
  check('task count', baseline.taskCount, current.taskCount);
  check('involved files', baseline.fileCount, current.fileCount);
  return { drifted: reasons.length > 0, reasons };
}
