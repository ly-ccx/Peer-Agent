// Goal Runner 上下文 Source —— 见 docs/design/goal-runner-explorer-task-list.md Slice 5。
//
// 作用：goal 模式下，Runner 托管推进 turn 通过明确的 Context Source 注入「续推上下文」，
// 而不是把目标/边界/预算等实质内容塞进一条伪造的 user message。
//
// wire 值迁移后（见 ADR 41 / goal-mode-ultrathink-workflow 设计文档）:plan/goal 执行段合一
// (修订 ADR 41,见 B2-b)。plan 与 goal 批准后共用同一自驱 Runner 托管续推,差异仅在批准前
// 的规划把关粒度。Runner 驱动的 turn 一律以 mode:'goal' 执行,故本 Source 按 mode==='goal'
// 渲染时,对 plan 批准后启动的 Runner 同样注入护栏上下文。
//
// 本 Source 产出两类 section：
// - L7_CONTINUITY（trust=runtime，事实上下文）：活动目标摘要、当前 task、boundaries、
//   successCriteria、Runner 预算用量、叶子 Evidence 计数。这些是事实快照，不是系统指令。
// - L6_MODE_REMINDER（trust=runtime，模式提醒）：Runner 执行契约约束（继续推进、不重规划、
//   完成必须回写 Evidence、不越界、需用户决策时停止）。
//
// 治理（与 AGENTS.md 一致）：
// - 仅在 mode==='goal' 且存在活动计划时渲染；chat / plan 模式零额外 token。
// - 只读 goal-plan-store，不写盘、不触发授权、不伪造 Tool Result/Evidence。
// - 事实与指令分属不同 section，trust 边界清晰。

import { neutralizeToolCallSyntax } from '../../chat-runtime/message-sanitizer.mjs';

const MAX_SCOPE_ITEMS = 12;
const MAX_CRITERIA_ITEMS = 12;
const MAX_TASKS = 40;
const MAX_VERIFIER_RUNS = 5;
const MAX_INSPECT_QUESTIONS = 4;

const ACTIVE_PLAN_STATUSES = new Set([
  'drafting',
  'awaiting_approval',
  'approved',
  'accepted',
  'executing',
  'paused',
  'failed',
]);

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function sanitizeRuntimeText(value) {
  return neutralizeToolCallSyntax(asString(value));
}

function asStringArray(value, limit) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = sanitizeRuntimeText(item).trim();
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

// 可自动验证的成功标准类型（与 goal-plan-store / goal-runner 对齐）。
const AUTO_CRITERION_KINDS_SET = new Set(['command', 'test', 'file-contains', 'file-exists']);

/**
 * 归一成功标准为渲染友好的结构化视图，并关联验证结果，计算每条的 verify 状态：
 * - passed：有 CriterionResult.passed===true
 * - failed：有结果但未通过
 * - pending：可自动验证但还没验证结果
 * - manual：需人工确认（不参与自动完成门）
 * 向后兼容：字符串或缺 kind 的存量标准归一为 manual。
 */
function summarizeCriteria(rawCriteria, rawResults, limit) {
  if (!Array.isArray(rawCriteria)) return [];
  const resultById = new Map(
    (Array.isArray(rawResults) ? rawResults : [])
      .filter((r) => r && typeof r.criterionId === 'string')
      .map((r) => [r.criterionId, r]),
  );
  const out = [];
  for (let i = 0; i < rawCriteria.length; i += 1) {
    const raw = rawCriteria[i];
    let id = null;
    let kind = 'manual';
    let description = '';
    if (typeof raw === 'string') {
      description = sanitizeRuntimeText(raw).trim();
    } else if (raw && typeof raw === 'object') {
      id = asString(raw.id) || null;
      kind = AUTO_CRITERION_KINDS_SET.has(asString(raw.kind)) || asString(raw.kind) === 'manual'
        ? asString(raw.kind)
        : 'manual';
      description = sanitizeRuntimeText(raw.description || raw.command || raw.path).trim();
    }
    if (!description) continue;
    let verify;
    if (AUTO_CRITERION_KINDS_SET.has(kind)) {
      const result = id ? resultById.get(id) : null;
      verify = !result ? 'pending' : result.passed === true ? 'passed' : 'failed';
    } else {
      verify = 'manual';
    }
    out.push({ id, kind, description, verify });
    if (out.length >= limit) break;
  }
  return out;
}

/** 统计叶子任务（无 subtasks）的 Evidence 总数与完成数，作为事实信号。 */
function summarizeTasks(tasks) {
  const leaves = [];
  const stack = Array.isArray(tasks) ? [...tasks] : [];
  while (stack.length > 0) {
    const task = stack.shift();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      for (const child of subtasks) stack.push(child);
      continue;
    }
    leaves.push({
      taskId: asString(task.taskId) || null,
      title: asString(task.title),
      status: asString(task.status) || 'pending',
      evidenceCount: Array.isArray(task.evidenceRefs) ? task.evidenceRefs.length : 0,
    });
  }
  return leaves.slice(0, MAX_TASKS);
}

function pickCurrentTask(leaves, currentTaskId) {
  if (currentTaskId) {
    const match = leaves.find((task) => task.taskId === currentTaskId);
    if (match) return match;
  }
  // 回退：第一个未完成的叶子任务。
  return leaves.find((task) => task.status !== 'completed') ?? null;
}

function summarizeInspectPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const questions = Array.isArray(plan.questions)
    ? plan.questions
        .map((question) => ({
          question: sanitizeRuntimeText(question?.question).trim(),
          reason: sanitizeRuntimeText(question?.reason).trim(),
        }))
        .filter((question) => question.question)
        .slice(0, MAX_INSPECT_QUESTIONS)
    : [];
  const exitCriteria = asStringArray(plan.exitCriteria, MAX_SCOPE_ITEMS);
  if (questions.length === 0 && exitCriteria.length === 0) return null;
  return {
    requiredBeforeAct: Boolean(plan.requiredBeforeAct),
    questions,
    exitCriteria,
    generatedAt: asString(plan.generatedAt) || null,
  };
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const status = asString(plan.status) || null;
  if (status && !ACTIVE_PLAN_STATUSES.has(status)) return null;
  if (!plan.planId) return null;
  const runner = plan.runner && typeof plan.runner === 'object' ? plan.runner : null;
  const leaves = summarizeTasks(plan.tasks);
  return {
    planId: asString(plan.planId),
    title: asString(plan.title),
    goal: asString(plan.goal),
    status: status ?? 'unknown',
    // intake 判别阶段标记：activation.kind==='intake' 表示目标尚未确认，Runner 只做
    // 只读/问答/澄清，prompt 据此注入三分支判别指令（见「方案乙」prompt 步）。
    activationKind: asString(plan.activation?.kind) || null,
    inScope: asStringArray(plan.boundaries?.inScope, MAX_SCOPE_ITEMS),
    outOfScope: asStringArray(plan.boundaries?.outOfScope, MAX_SCOPE_ITEMS),
    successCriteria: summarizeCriteria(
      plan.successCriteria,
      plan.criterionResults,
      MAX_CRITERIA_ITEMS,
    ),
    progress: plan.progress && typeof plan.progress === 'object' ? plan.progress : null,
    leaves,
    currentTask: pickCurrentTask(leaves, asString(runner?.currentTaskId) || null),
    runner: runner
      ? {
          status: asString(runner.status) || 'idle',
          intent: asString(runner.intent) || null,
          phase: asString(runner.phase) || null,
          blockedReason: sanitizeRuntimeText(runner.blockedReason).trim(),
          explorerBatch: runner.explorerBatch && typeof runner.explorerBatch === 'object'
            ? {
                batchId: asString(runner.explorerBatch.batchId) || null,
                total: Number.isFinite(runner.explorerBatch.total) ? runner.explorerBatch.total : 0,
                done: Number.isFinite(runner.explorerBatch.done) ? runner.explorerBatch.done : 0,
              }
            : null,
          inspectPlan: summarizeInspectPlan(runner.inspectPlan),
          blockerAudit: runner.blockerAudit && typeof runner.blockerAudit === 'object'
            ? {
                reason: sanitizeRuntimeText(runner.blockerAudit.reason).trim(),
                occurrences: Number.isFinite(runner.blockerAudit.occurrences)
                  ? runner.blockerAudit.occurrences
                  : 0,
                firstSeenAt: asString(runner.blockerAudit.firstSeenAt),
                lastSeenAt: asString(runner.blockerAudit.lastSeenAt),
              }
            : null,
          verifierRuns: Array.isArray(runner.verifierRuns)
            ? runner.verifierRuns.slice(-MAX_VERIFIER_RUNS).map((run) => ({
                verifierRunId: asString(run?.verifierRunId) || null,
                status: asString(run?.status) || 'queued',
                target: run?.target && typeof run.target === 'object'
                  ? {
                      kind: asString(run.target.kind) || 'plan',
                      taskId: asString(run.target.taskId) || null,
                      criterionId: asString(run.target.criterionId) || null,
                    }
                  : { kind: 'plan', taskId: null, criterionId: null },
                evidenceCount: Array.isArray(run?.evidenceRefs) ? run.evidenceRefs.length : 0,
                summary: sanitizeRuntimeText(run?.summary).trim(),
              }))
            : [],
        }
      : null,
    budget: runner
      ? {
          turnCount: Number.isFinite(runner.turnCount) ? runner.turnCount : 0,
          roundCount: Number.isFinite(runner.roundCount) ? runner.roundCount : 0,
          maxTurns: Number.isFinite(runner.maxTurns) ? runner.maxTurns : null,
          toolCallCount: Number.isFinite(runner.toolCallCount) ? runner.toolCallCount : 0,
          maxToolCalls: Number.isFinite(runner.maxToolCalls) ? runner.maxToolCalls : null,
          explorerCount: Number.isFinite(runner.explorerCount) ? runner.explorerCount : 0,
          maxExplorers: Number.isFinite(runner.maxExplorers) ? runner.maxExplorers : null,
        }
      : null,
  };
}

function formatBudget(budget) {
  if (!budget) return '(not started)';
  const parts = [
    `ticks ${budget.turnCount}${budget.maxTurns != null ? `/${budget.maxTurns}` : ''}`,
    `rounds ${budget.roundCount}`,
    `toolCalls ${budget.toolCallCount}${budget.maxToolCalls != null ? `/${budget.maxToolCalls}` : ''}`,
    `explorers ${budget.explorerCount}${budget.maxExplorers != null ? `/${budget.maxExplorers}` : ''}`,
  ];
  return parts.join('; ');
}

function formatFacts(plan) {
  const lines = [
    'Active goal runner context (factual context, scope=turn).',
    'This is a factual snapshot of the goal the runner is advancing, not a system instruction.',
    'If you fear this snapshot is stale, call goal_get_plan to re-read authoritative state.',
    '',
    `Plan ${plan.planId} — status=${plan.status}`,
  ];
  const title = sanitizeRuntimeText(plan.title);
  const goal = sanitizeRuntimeText(plan.goal);
  if (title) lines.push(`title=${title}`);
  if (goal) lines.push(`goal=${goal}`);
  if (plan.runner) {
    const state = [
      `status=${plan.runner.status}`,
      plan.runner.intent ? `intent=${plan.runner.intent}` : null,
      plan.runner.phase ? `phase=${plan.runner.phase}` : null,
    ].filter(Boolean).join('; ');
    lines.push(`runner state: ${state}`);
    if (plan.runner.blockedReason) {
      lines.push(`runner blocked reason: ${plan.runner.blockedReason}`);
    }
    if (plan.runner.blockerAudit?.reason) {
      const audit = plan.runner.blockerAudit;
      lines.push(
        `runner blocker audit: reason=${audit.reason}; occurrences=${audit.occurrences}; firstSeenAt=${audit.firstSeenAt}; lastSeenAt=${audit.lastSeenAt}`,
      );
    }
    if (plan.runner.explorerBatch?.total > 0) {
      const batch = plan.runner.explorerBatch;
      lines.push(`runner explorer batch: ${batch.done}/${batch.total}${batch.batchId ? ` (${batch.batchId})` : ''}`);
    }
    if (plan.runner.inspectPlan) {
      const inspect = plan.runner.inspectPlan;
      lines.push(`inspect plan: requiredBeforeAct=${inspect.requiredBeforeAct}; questions=${inspect.questions.length}`);
      for (const question of inspect.questions) {
        const reason = question.reason ? ` — ${question.reason}` : '';
        lines.push(`- ${question.question}${reason}`);
      }
      if (inspect.exitCriteria.length > 0) {
        lines.push(`inspect exit criteria: ${inspect.exitCriteria.join('; ')}`);
      }
    }
    if (plan.runner.verifierRuns.length > 0) {
      lines.push('recent verifier runs:');
      for (const run of plan.runner.verifierRuns) {
        const target = run.target.kind === 'task'
          ? `task:${run.target.taskId ?? '?'}`
          : run.target.kind === 'success_criterion'
            ? `criterion:${run.target.criterionId ?? '?'}`
            : 'plan';
        const summary = run.summary ? ` — ${run.summary}` : '';
        lines.push(`- ${run.verifierRunId ?? '(no-id)'} ${target} ${run.status} (evidenceRefs=${run.evidenceCount})${summary}`);
      }
    }
  }
  if (plan.currentTask) {
    const t = plan.currentTask;
    lines.push(
      `current task: ${t.taskId ?? '(no-id)'} — ${t.status} — ${sanitizeRuntimeText(t.title) || '(untitled)'} (evidenceRefs=${t.evidenceCount})`,
    );
  }
  if (plan.inScope.length) {
    lines.push('in scope:');
    for (const item of plan.inScope) lines.push(`- ${item}`);
  }
  if (plan.outOfScope.length) {
    lines.push('out of scope:');
    for (const item of plan.outOfScope) lines.push(`- ${item}`);
  }
  if (plan.successCriteria.length) {
    lines.push('success criteria (Definition of Done):');
    for (const c of plan.successCriteria) {
      // 形如： - [pending] (command) run npm test —— 让模型看到每条 DoD 的验证状态。
      lines.push(`- [${c.verify}] (${c.kind}) ${c.description}`);
    }
    const pendingAuto = plan.successCriteria.filter((c) => c.verify === 'pending');
    const failedAuto = plan.successCriteria.filter((c) => c.verify === 'failed');
    if (failedAuto.length) {
      lines.push(
        `NOTE: ${failedAuto.length} auto-verifiable criterion(s) currently FAILED — fix and re-verify before completing.`,
      );
    }
    if (pendingAuto.length) {
      lines.push(
        `NOTE: ${pendingAuto.length} auto-verifiable criterion(s) not yet verified — after acting, run the check and record the result via goal_update_task so the completion gate can pass.`,
      );
    }
  }
  lines.push(`runner budget: ${formatBudget(plan.budget)}`);
  return lines.join('\n');
}

/**
 * intake 判别阶段指令（方案乙）：goal 模式下用户首发消息先进入判别，Runner 必须先想清楚
 * 「这到底是不是一个要执行的目标」，再三选一收敛——而不是把用户原话直接当目标去执行。
 * 与 write-gate 对齐：intake 阶段禁止一切有副作用能力，只放行只读调查、提问与产出目标计划。
 */
function formatIntakeInstructions() {
  return [
    'Goal intake phase (goal not confirmed yet):',
    '- This is the intake/triage turn. The user\'s message has NOT been accepted as a goal. '
      + 'Do NOT treat the raw message as the goal and do NOT start executing it.',
    '- First understand intent: do only read-only investigation (read files, search, request_explorer) '
      + 'if needed to tell a question apart from an actionable goal. Side-effecting actions '
      + '(write/edit files, shell with effects, MCP mutations) are blocked in this phase.',
    '- Then choose exactly one of three outcomes:',
    '  1) Pure question / consultation: just answer it directly in your reply. Do NOT call '
      + 'goal_create_plan. The intake contract will be removed automatically and the panel stays clean.',
    '  2) Ambiguous / underspecified goal: call request_user_input to ask a focused clarifying '
      + 'question. Keep the intake contract open and wait for the user; do not guess the goal.',
    '  3) Clear, actionable goal: call goal_create_plan to confirm it — write a crisp goal, '
      + 'success criteria, and ordered subtasks. This promotes the intake contract into an accepted '
      + 'goal and normal self-driven execution begins on the next turn.',
    '- Prefer answering (outcome 1) or clarifying (outcome 2) when in doubt. Only promote to a goal '
      + 'when the user clearly wants work executed, not merely an explanation.',
  ].join('\n');
}

function formatContract() {
  return [
    'Goal Runner execution contract:',
    '- Continue advancing the current goal; do not re-plan unrelated goals.',
    '- When uncertain, prefer reading authoritative state via goal_get_plan.',
    '- After completing a subtask, write evidence back through goal_update_task; do not mark completion without evidenceRefs.',
    '- Verify against the Definition of Done: for each auto-verifiable success criterion '
      + '(command/test/file-contains/file-exists), actually run its check after acting, then record '
      + 'the outcome via goal_update_task.criterionResults (criterionId + passed + evidenceRef, '
      + 'using the check\'s Tool Result as evidence). The completion gate blocks until every '
      + 'auto-verifiable criterion has a passed result with evidence.',
    '- Do not self-report a criterion as passed without a real check Tool Result; manual criteria '
      + 'are confirmed once with the user before finishing.',
    '- Do not cross the declared boundaries.',
    '- If you need user input, permission, or evidence is insufficient, call request_user_input (or stop) and explain the blocker instead of pretending completion.',
    '- In Plan workflow, do not use request_user_input to duplicate the plan approve/reject card. In self-driven Goal workflow, do not ask for plan approval; ask only for substantive ambiguity, high-risk decisions, missing permission, or verification conflict.',
    '- Use the existing tools and permission flow; do not fabricate Tool Result or Evidence.',
  ].join('\n');
}

export function createGoalRunnerPromptSource() {
  return {
    id: 'runtime.goal-runner',
    layer: 'L6_MODE_REMINDER',
    priority: 1,
    trust: 'runtime',
    observe(input = {}) {
      const mode = asString(input.mode) || 'chat';
      // 按 turn 的执行模式渲染:Runner 驱动的 turn(含 plan 批准后启动的)一律 mode:'goal',
      // 故仍以 mode==='goal' 为准注入续推上下文;chat 及未托管的 plan turn 零额外 token。
      if (mode !== 'goal') return { plan: null };
      const store = input.goalPlanStore;
      const conversationId = input.conversationId ?? null;
      if (!store || typeof store.getActivePlanByConversation !== 'function') {
        return { plan: null };
      }
      let active = null;
      try {
        active = store.getActivePlanByConversation(conversationId);
      } catch {
        active = null;
      }
      return { plan: normalizePlan(active) };
    },
    render(observation) {
      const plan = observation?.plan;
      if (!plan) return [];
      const isIntake = plan.activationKind === 'intake';
      // intake 判别阶段：注入三分支判别指令，替代执行期契约——避免让「继续推进目标 / 校验 DoD」
      // 这类指令误导模型在目标尚未确认时直接开干（见「方案乙」prompt 步）。
      const modeReminder = isIntake
        ? {
            id: 'runtime.goal-runner.intake',
            layer: 'L6_MODE_REMINDER',
            priority: 1,
            title: 'Goal intake instructions',
            content: formatIntakeInstructions(),
            source: {
              id: 'runtime.goal-runner',
              kind: 'goal-runner-intake',
              planId: plan.planId,
            },
            trust: 'runtime',
          }
        : {
            id: 'runtime.goal-runner.contract',
            layer: 'L6_MODE_REMINDER',
            priority: 1,
            title: 'Goal Runner execution contract',
            content: formatContract(),
            source: {
              id: 'runtime.goal-runner',
              kind: 'goal-runner-contract',
              planId: plan.planId,
            },
            trust: 'runtime',
          };
      return [
        {
          id: 'runtime.goal-runner.facts',
          layer: 'L7_CONTINUITY',
          priority: 2,
          title: 'Active goal runner context',
          content: formatFacts(plan),
          source: {
            id: 'runtime.goal-runner',
            kind: 'goal-runner-facts',
            planId: plan.planId,
            status: plan.status,
          },
          trust: 'runtime',
        },
        modeReminder,
      ];
    },
  };
}
