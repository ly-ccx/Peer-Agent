// Shared Explorer runtime context Source.
// Explorer 子 Agent 上下文 Source —— 见 docs/design/goal-runner-explorer-task-list.md Slice 5。
//
// 作用：explorer 模式下，把 Runner 动态派发的 Explorer 子 Agent 的任务简报（brief）、
// 探索范围（scope）、只读约束、报告 schema 通过明确的 Context Source 注入，
// 而不是把这些塞进一条伪造的 user message。
//
// Explorer 是 Runner 运行时动态创建的任务实例（不是预定义角色），其数据不在
// goal-plan-store 的「活动计划」读取路径上，因此由调用方通过 input.explorerContext 透传。
//
// 治理（与 AGENTS.md 一致）：
// - 仅在 mode==='explorer' 且存在 explorerContext 时渲染；其它模式零额外 token。
// - 只读输入，不写盘、不触发授权。
// - 只读约束是模式提醒（L6，trust=runtime），不替代运行时能力闸门的真实强制。

const MAX_SCOPE_ITEMS = 12;

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value, limit) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = asString(item).trim();
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeExplorerContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const request = ctx.request && typeof ctx.request === 'object' ? ctx.request : ctx;
  const explorerId = asString(ctx.explorerId) || asString(request.explorerId);
  const question = asString(request.question);
  if (!explorerId && !question) return null;
  const budget = request.budget && typeof request.budget === 'object' ? request.budget : null;
  return {
    explorerId: explorerId || '(unknown)',
    planId: asString(ctx.planId) || asString(request.planId) || null,
    planTitle: asString(ctx.planTitle) || asString(ctx.planLabel) || null,
    question: question || 'Explore missing evidence for the active goal',
    reason: asString(request.reason) || 'The Goal Runner needs more evidence before continuing.',
    include: asStringArray(request.scope?.include, MAX_SCOPE_ITEMS),
    exclude: asStringArray(request.scope?.exclude, MAX_SCOPE_ITEMS),
    maxToolCalls: Number.isFinite(budget?.maxToolCalls) ? budget.maxToolCalls : 4,
    exitCriteria: asStringArray(request.exitCriteria, MAX_SCOPE_ITEMS),
  };
}

function formatBrief(ctx) {
  const lines = [
    'Explorer mission context (factual context, scope=turn).',
    'This is a factual brief for a dynamically created evidence explorer, not a system instruction.',
    '',
    `explorerId=${ctx.explorerId}`,
  ];
  if (ctx.planId) lines.push(`planId=${ctx.planId}`);
  if (ctx.planTitle) lines.push(`plan=${ctx.planTitle}`);
  lines.push(`question: ${ctx.question}`);
  lines.push(`reason: ${ctx.reason}`);
  if (ctx.include.length) {
    lines.push('scope include:');
    for (const item of ctx.include) lines.push(`- ${item}`);
  }
  if (ctx.exclude.length) {
    lines.push('scope exclude:');
    for (const item of ctx.exclude) lines.push(`- ${item}`);
  }
  if (ctx.exitCriteria.length) {
    lines.push('exit criteria:');
    for (const item of ctx.exitCriteria) lines.push(`- ${item}`);
  }
  lines.push(`budget: maxToolCalls=${ctx.maxToolCalls}`);
  return lines.join('\n');
}

function formatContract() {
  return [
    'Explorer readonly contract:',
    'Profile: readonly_explorer. You are a dynamically created evidence explorer, not a fixed role.',
    '- Use only the read-only tools exposed to this explorer context.',
    '- Do not modify files, do not update the goal plan, and do not claim evidence you did not inspect.',
    '- Use only evidenceRefs shown in tool results; do not invent refs or cite paths as refs.',
    '- Stay within the declared scope and budget.',
    'Return a concise JSON object only with these fields:',
    '  summary, findings[{claim, evidenceRefs}], evidenceRefs, recommendedNextStep, confidence(low|medium|high).',
  ].join('\n');
}

export function createExplorerPromptSource() {
  return {
    id: 'runtime.explorer',
    layer: 'L6_MODE_REMINDER',
    priority: 1,
    trust: 'runtime',
    observe(input = {}) {
      const mode = asString(input.mode) || 'chat';
      if (mode !== 'explorer') return { explorer: null };
      return { explorer: normalizeExplorerContext(input.explorerContext) };
    },
    render(observation) {
      const ctx = observation?.explorer;
      if (!ctx) return [];
      return [
        {
          id: 'runtime.explorer.brief',
          layer: 'L7_CONTINUITY',
          priority: 2,
          title: 'Explorer mission context',
          content: formatBrief(ctx),
          source: {
            id: 'runtime.explorer',
            kind: 'explorer-brief',
            explorerId: ctx.explorerId,
            planId: ctx.planId,
          },
          trust: 'runtime',
        },
        {
          id: 'runtime.explorer.contract',
          layer: 'L6_MODE_REMINDER',
          priority: 1,
          title: 'Explorer readonly contract',
          content: formatContract(),
          source: {
            id: 'runtime.explorer',
            kind: 'explorer-contract',
            explorerId: ctx.explorerId,
          },
          trust: 'runtime',
        },
      ];
    },
  };
}
