import { SHARED_LOCAL_TOOL_CONTRACTS } from '@peer-agent/runtime-core';

/**
 * Plan / Goal 目标追踪工具定义（Manifest）—— 见 Plan 模式设计与 Goal 模式设计。
 *
 * 该工具经正规运行时链路暴露：
 *   Capability Provider(local.goal.update_task) → Manifest(本文件) → Runtime Projection
 *     → Tool Call(goal_update_task) → PermissionGrant → Evidence
 *
 * 用途：Plan 模式用这些工具建立审批前的持久计划；Goal 模式用同一套
 * plan/task/evidence 结构做自驱目标追踪。agent 运行时在完成（或失败/受阻）
 * 某个子任务后，显式调用本工具，把刚产生的 evidenceRefs 回写到对应子任务，由
 * goal-plan-store 落盘并自底向上重算进度。"completed 必须带 evidenceRefs" 的治理
 * 约束在 store 层强制。
 */

export const GOAL_TOOL_NAMES = Object.freeze({
  createPlan: SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.toolName,
  updateTask: SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.toolName,
  getPlan: SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.toolName,
  requestExplorer: SHARED_LOCAL_TOOL_CONTRACTS.requestExplorer.toolName,
});

const GOAL_CREATE_PLAN_PROMPT = [
  'Create a persistent, trackable goal/plan. In Plan mode, call this before side-effecting work',
  'so the user can review and approve the draft plan. In Goal mode, use it to establish',
  'the objective, success criteria, boundaries, and trackable subtasks for autonomous execution;',
  'Goal mode does not require a plan-approval gate before every side-effecting step.',
  'Provide a clear goal and a complete list of ordered subtasks (each subtask: title, optional dependsOn).',
  'Write every subtask title and the goal in plain language the user can skim: lead with what the step',
  'is actually for, keep it to one action per subtask, and prefer everyday words over jargon.',
  'Do not cram multiple points into one title with inline numbering like (1)(2)(3) or ①②③ — split them',
  'into separate subtasks instead. Symbols, file paths, line numbers, function and field names may stay,',
  'but as trailing detail in parentheses, never as the opening of the title. Avoid buzzwords such as',
  '"byte-exact", "contract", "anchor", "invariant" when a plain phrase (e.g. "don\'t break the callers")',
  'says the same thing. The reader should understand the point of each subtask from its first few words.',
  'Always provide a short, human-readable title for the plan itself (a few words) — it is required',
  'and shown verbatim in the plan panel; do not leave it empty.',
  'After the tool succeeds, end the user-facing reply with the available next steps in plain language:',
  'start execution, adjust the plan, or cancel the plan. The plan panel provides the same governed',
  'actions as clickable controls; do not replace these choices with a vague confirmation-only reply.',
].join(' ');

const GOAL_TOOL_PROMPT = [
  'Record execution evidence for a goal/plan subtask (Plan and Goal modes).',
  'Call this after you finish, fail, or get blocked on a subtask during execution.',
  'In Plan mode this usually happens after the approved plan starts running; in Goal mode it',
  'is the normal progress ledger for autonomous work. Mark a subtask "completed" only when',
  'you can supply the evidenceRefs (artifact refs / tool-result refs) that prove it is done —',
  'the store rejects a "completed" status without evidenceRefs. Progress is recomputed bottom-up',
  'from leaf subtasks; do not hand-maintain progress.',
].join(' ');

const GOAL_GET_PLAN_PROMPT = [
  'Read back an existing goal/plan (Plan and Goal modes). Read-only and side-effect free.',
  'Use this to recover the authoritative subtask taskId list and current statuses —',
  'for example after a long conversation or context compaction when you are unsure of',
  'the exact taskId to pass to goal_update_task. Pass planId to fetch one plan; omit',
  'planId to list the active plans for the current conversation. Always trust the',
  'taskId values returned here over any taskId you remember.',
].join(' ');

const REQUEST_EXPLORER_PROMPT = [
  'Request a read-only Explorer sub-agent to investigate a focused question (Plan and Goal modes).',
  'Use this during execution when you need to gather evidence in parallel without',
  'spending your own turn budget — for example mapping where a symbol is used, confirming a',
  'config value, or scanning a subtree. The Explorer is strictly read-only (no writes, shell',
  'side effects, or MCP mutations) and returns findings with evidence refs. Provide a clear',
  '"question" (what to find out) and a short "reason" (why it helps the goal); optionally',
  'scope it with include/exclude path hints. Calling this only registers the request; the',
  'Goal Runner dispatches and runs the Explorer after the turn. There is a hard cap on',
  'concurrent explorers per run, so only request what materially advances the goal.',
].join(' ');

export const GOAL_TOOL_DEFINITIONS = [
  {
    name: GOAL_TOOL_NAMES.createPlan,
    capabilityId: SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.capabilityId,
    // 在 plan 与 goal 模式投影给模型（ADR 35）。plan 用于产出/求批准计划,goal 用于自驱规划;
    // mode 隔离在 Runtime Projection 层强制,不依赖系统提示词或执行层闸门兜底。
    availableInModes: ['plan', 'goal'],
    prompt: () => GOAL_CREATE_PLAN_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-goal-provider',
      executorCapabilityId: SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.capabilityId,
    }),
    permissionPolicy: {
      kind: 'goal-create',
    },
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'Short, human-readable plan title (a few words). Required — do not omit; '
            + 'the plan panel and floating bar surface this verbatim.',
        },
        goal: {
          type: 'string',
          description: 'The concrete goal this plan aims to achieve, in one or two sentences.',
        },
        targetWorkspacePath: {
          type: 'string',
          description:
            'Optional absolute path of the code repository this plan will modify, when it '
            + 'differs from the current conversation workspace (e.g. a knowledge-base workspace '
            + 'driving changes in a separate code repo). If the workspace AGENTS.md documents a '
            + 'linked/associated repository path, extract and pass it here so explorers can locate '
            + 'the target code across repositories. Omit when the goal targets the current workspace.',
        },
        tasks: {
          type: 'array',
          description: 'Ordered list of subtasks that make up the plan.',
          items: {
            type: 'object',
            properties: {
              taskId: {
                type: 'string',
                description: 'Optional stable id for the subtask; generated if omitted.',
              },
              title: {
                type: 'string',
                description:
                  'What this subtask delivers, written in plain language. Lead with the point of the '
                  + 'step in everyday words, keep it to one action, and put any file paths, line '
                  + 'numbers, function or field names as trailing detail in parentheses rather than at '
                  + 'the start. Do not pack several points into one title with ①②③ / (1)(2)(3).',
              },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
                description: 'taskIds this subtask depends on (must run after them).',
              },
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
        successCriteria: {
          type: 'array',
          description:
            'Optional Definition-of-Done for the goal. Each item is a verifiable success '
            + 'criterion. Prefer machine-verifiable kinds (command/test/file-contains/file-exists) '
            + 'so the runtime can auto-verify after acting; use "manual" only when no automated '
            + 'check exists. Plain strings are accepted for backward compatibility and treated as '
            + 'manual criteria. When you can express the goal as executable checks, do so — the '
            + 'completion gate requires non-manual criteria to have a passed verification result '
            + 'with an evidence ref before the plan can complete.',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Optional stable id for this criterion; generated if omitted.',
                  },
                  kind: {
                    type: 'string',
                    enum: ['command', 'test', 'file-contains', 'file-exists', 'manual'],
                    description:
                      'How this criterion is verified. command: run a shell command (exit 0 = pass). '
                      + 'test: run a test command. file-contains: a file must contain expect text. '
                      + 'file-exists: a path must exist. manual: needs human confirmation.',
                  },
                  description: {
                    type: 'string',
                    description: 'Human-readable statement of what "done" means for this criterion.',
                  },
                  command: {
                    type: 'string',
                    description: 'Shell/test command to run (for kind=command/test).',
                  },
                  path: {
                    type: 'string',
                    description: 'Target file path (for kind=file-contains/file-exists).',
                  },
                  expect: {
                    type: 'string',
                    description: 'Expected substring the file must contain (for kind=file-contains).',
                  },
                },
                required: ['kind'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ['title', 'goal', 'tasks'],
      additionalProperties: false,
    },
  },
  {
    name: GOAL_TOOL_NAMES.updateTask,
    capabilityId: SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.capabilityId,
    // 在 plan 与 goal 模式投影给模型（ADR 35）。
    availableInModes: ['plan', 'goal'],
    prompt: () => GOAL_TOOL_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-goal-provider',
      executorCapabilityId: SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.capabilityId,
    }),
    permissionPolicy: {
      kind: 'goal-update',
    },
    inputSchema: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: 'Target goal plan id (planId).',
        },
        taskId: {
          type: 'string',
          description: 'Target subtask id (taskId) within the plan. Must reference a leaf subtask when setting completion.',
        },
        status: {
          type: 'string',
          enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'waiting_user'],
          description: 'New execution status for the subtask. Use "completed" only with evidenceRefs.',
        },
        evidenceRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Artifact refs / tool-result refs that prove the subtask outcome. Required to mark completed.',
        },
        result: {
          type: 'string',
          description: 'Short factual summary of what was produced (optional).',
        },
        failureReason: {
          type: 'string',
          description: 'Why the subtask failed (when status=failed).',
        },
        blockedReason: {
          type: 'string',
          description: 'Why the subtask is blocked / waiting (when status=waiting_user).',
        },
        criterionResults: {
          type: 'array',
          description:
            'Optional verification results for the plan\'s success criteria (DoD-as-Code). '
            + 'After acting, run each auto-verifiable criterion\'s check (command/test/file) and '
            + 'record the outcome here so the completion gate can pass. Each result references a '
            + 'criterion id declared in the plan\'s successCriteria; unknown ids are ignored.',
          items: {
            type: 'object',
            properties: {
              criterionId: {
                type: 'string',
                description: 'The id of the success criterion this result verifies.',
              },
              passed: {
                type: 'boolean',
                description: 'Whether the criterion check passed.',
              },
              evidenceRef: {
                type: 'string',
                description:
                  'Artifact/tool-result ref proving the check outcome (e.g. the shell result ref).',
              },
              detail: {
                type: 'string',
                description: 'Short human-readable detail of what was checked / observed.',
              },
            },
            required: ['criterionId', 'passed'],
            additionalProperties: false,
          },
        },
      },
      required: ['planId', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: GOAL_TOOL_NAMES.getPlan,
    capabilityId: SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.capabilityId,
    // 在 plan 与 goal 模式投影给模型（ADR 35）。
    availableInModes: ['plan', 'goal'],
    prompt: () => GOAL_GET_PLAN_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-goal-provider',
      executorCapabilityId: SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.capabilityId,
    }),
    permissionPolicy: {
      kind: 'goal-read',
    },
    inputSchema: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description:
            'Target goal plan id (planId) to read back. Omit to list the active plans for the current conversation.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: GOAL_TOOL_NAMES.requestExplorer,
    capabilityId: SHARED_LOCAL_TOOL_CONTRACTS.requestExplorer.capabilityId,
    // 仅在 goal 模式投影给模型（ADR 35）。Explorer 是 Runner 编排的只读子 Agent，
    // 登记式：本工具仅把请求记入回合，由 Goal Runner 在回合结束后派发执行。
    availableInModes: ['goal'],
    prompt: () => REQUEST_EXPLORER_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-goal-provider',
      executorCapabilityId: SHARED_LOCAL_TOOL_CONTRACTS.requestExplorer.capabilityId,
    }),
    permissionPolicy: {
      kind: 'goal-explore',
    },
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The focused, read-only question the Explorer should answer (what to find out).',
        },
        reason: {
          type: 'string',
          description: 'Why answering this question helps advance the current goal.',
        },
        scope: {
          type: 'object',
          description: 'Optional path hints to scope the read-only investigation.',
          properties: {
            include: {
              type: 'array',
              items: { type: 'string' },
              description: 'Path globs / directories the Explorer should focus on.',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description: 'Path globs / directories the Explorer should avoid.',
            },
          },
          additionalProperties: false,
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
];
