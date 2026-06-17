// 单一 mode 文案源（single source of truth）。
// 历史上 mode-source.mjs 与 runtime-reminder-source.mjs 各自维护了一份重复的 MODE_COPY，
// 新增模式文案时两处都要改，存在「改一处漏一处」的漂移风险（详见 docs/proposals/0002-goal-mode.md §5）。
// 现已收敛到本模块：两个 source 均从此处 import，新增/修改模式文案只改这一处。
export const MODE_COPY = {
  chat: [
    'Mode: chat.',
    'Answer the user directly, and use tools only through structured tool calls when local evidence or local changes are needed.',
  ],
  compact: [
    'Mode: compact.',
    'Create or preserve continuity summaries only. Do not execute tools from compaction context.',
  ],
  goal: [
    'Mode: goal.',
    'Plan-before-execute. First co-author a structured implementation plan with the user, then execute only after the user approves it.',
    'The plan must cover: goal (definition of done), success criteria, the path/steps, in-scope vs out-of-scope boundaries, exception handling, involved files, and a breakdown into trackable subtasks (nesting allowed).',
    'While drafting or revising the plan, do not run tools that have side effects; read-only inspection to inform the plan is allowed.',
    'A subtask may only be marked completed when backed by Evidence from an actual tool result. Never mark a subtask done from assertion alone.',
    'After the user approves, execute subtasks respecting their dependsOn order, write each completion back as Evidence, and surface failures/blocked subtasks instead of silently skipping them.',
  ],
};
