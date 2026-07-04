// Verifier 子 Agent 上下文 Source —— 见 goal-mode-multi-agent-orchestration-plan.md Slice 5。
//
// Verifier 复用 explorer 模式的只读工具投影，但拥有独立的 verifierContext：
// 它只复核已有任务 Evidence / criterionResults / Explorer reports 是否足以支撑完成声明，
// 不写文件、不更新 GoalPlan，也不替代完成 Evidence。

const MAX_ITEMS = 20;

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value, limit = MAX_ITEMS) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = asString(item).trim();
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeTask(task) {
  if (!task || typeof task !== 'object') return null;
  return {
    taskId: asString(task.taskId) || '(no-id)',
    title: asString(task.title) || '(untitled)',
    status: asString(task.status) || 'pending',
    evidenceRefs: asStringArray(task.evidenceRefs, 8),
  };
}

function normalizeCriterion(criterion, resultById) {
  if (!criterion || typeof criterion !== 'object') return null;
  const id = asString(criterion.id) || '(no-id)';
  const result = resultById.get(id);
  return {
    id,
    kind: asString(criterion.kind) || 'manual',
    description: asString(criterion.description) || asString(criterion.command) || asString(criterion.path) || '(unnamed)',
    passed: result?.passed === true,
    evidenceRef: asString(result?.evidenceRef) || null,
  };
}

function normalizeVerifierContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const plan = ctx.plan && typeof ctx.plan === 'object' ? ctx.plan : {};
  const planId = asString(ctx.planId) || asString(plan.planId);
  if (!planId) return null;
  const criteriaResults = Array.isArray(plan.criterionResults) ? plan.criterionResults : [];
  const resultById = new Map(
    criteriaResults
      .filter((result) => result && typeof result.criterionId === 'string')
      .map((result) => [result.criterionId, result]),
  );
  return {
    verifierRunId: asString(ctx.verifierRunId) || '(pending)',
    planId,
    title: asString(plan.title) || asString(plan.goal) || '(untitled goal)',
    goal: asString(plan.goal),
    tasks: Array.isArray(ctx.tasks)
      ? ctx.tasks.map(normalizeTask).filter(Boolean).slice(0, MAX_ITEMS)
      : [],
    successCriteria: Array.isArray(plan.successCriteria)
      ? plan.successCriteria.map((criterion) => normalizeCriterion(criterion, resultById)).filter(Boolean).slice(0, MAX_ITEMS)
      : [],
    explorerReports: Array.isArray(ctx.explorerReports)
      ? ctx.explorerReports.slice(-MAX_ITEMS).map((report) => ({
          explorerId: asString(report?.explorerId) || '(unknown)',
          evidenceRefs: asStringArray(report?.evidenceRefs, 8),
          confidence: asString(report?.confidence) || 'unknown',
          summary: asString(report?.summary),
        }))
      : [],
  };
}

function formatBrief(ctx) {
  const lines = [
    'Verifier mission context (factual context, scope=turn).',
    'This is a factual brief for a read-only verifier, not a system instruction.',
    '',
    `verifierRunId=${ctx.verifierRunId}`,
    `planId=${ctx.planId}`,
    `plan=${ctx.title}`,
  ];
  if (ctx.goal) lines.push(`goal=${ctx.goal}`);
  if (ctx.tasks.length) {
    lines.push('leaf tasks:');
    for (const task of ctx.tasks) {
      lines.push(`- ${task.taskId} [${task.status}] ${task.title} (evidenceRefs=${task.evidenceRefs.length})`);
    }
  }
  if (ctx.successCriteria.length) {
    lines.push('success criteria:');
    for (const criterion of ctx.successCriteria) {
      lines.push(`- ${criterion.id} (${criterion.kind}) passed=${criterion.passed} evidenceRef=${criterion.evidenceRef || '(none)'} ${criterion.description}`);
    }
  }
  if (ctx.explorerReports.length) {
    lines.push('recent explorer reports:');
    for (const report of ctx.explorerReports) {
      lines.push(`- ${report.explorerId} confidence=${report.confidence} evidenceRefs=${report.evidenceRefs.length} ${report.summary || ''}`.trim());
    }
  }
  return lines.join('\n');
}

function formatContract() {
  return [
    'Verifier readonly contract:',
    '- Use only read-only tools exposed to this verifier context.',
    '- Do not modify files, do not update the goal plan, and do not create completion evidence.',
    '- Check whether existing task evidence, criterion results, and explorer reports support completion.',
    '- If evidence is missing or criteria are not proven, report failure and recommend repair.',
    'Return a concise JSON object only with:',
    '  passed, failedCriteria[{criterionId,reason,evidenceRefs}], missingEvidence[{taskId,reason}], risks[], evidenceRefs[], recommendedNextAction.',
  ].join('\n');
}

export function createVerifierPromptSource() {
  return {
    id: 'runtime.verifier',
    layer: 'L6_MODE_REMINDER',
    priority: 1,
    trust: 'runtime',
    observe(input = {}) {
      const mode = asString(input.mode) || 'chat';
      if (mode !== 'explorer') return { verifier: null };
      return { verifier: normalizeVerifierContext(input.verifierContext) };
    },
    render(observation) {
      const ctx = observation?.verifier;
      if (!ctx) return [];
      return [
        {
          id: 'runtime.verifier.brief',
          layer: 'L7_CONTINUITY',
          priority: 2,
          title: 'Verifier mission context',
          content: formatBrief(ctx),
          source: {
            id: 'runtime.verifier',
            kind: 'verifier-brief',
            verifierRunId: ctx.verifierRunId,
            planId: ctx.planId,
          },
          trust: 'runtime',
        },
        {
          id: 'runtime.verifier.contract',
          layer: 'L6_MODE_REMINDER',
          priority: 1,
          title: 'Verifier readonly contract',
          content: formatContract(),
          source: {
            id: 'runtime.verifier',
            kind: 'verifier-contract',
            verifierRunId: ctx.verifierRunId,
          },
          trust: 'runtime',
        },
      ];
    },
  };
}
