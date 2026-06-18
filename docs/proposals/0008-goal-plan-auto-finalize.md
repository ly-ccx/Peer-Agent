# 0008 — Goal 计划在所有叶子子任务终态时自动收尾（executing → completed/failed）

状态：提案（A 级变更：触及 **goal 运行时状态机 / 计划整体状态（`GoalPlanStatus`）的派生语义**与 **Evidence 驱动的收尾**。不新增 IPC 契约、不改权限通道、不改 `docs/architecture/*`、不改 renderer）。

> 编号说明：本提案立计划时拟用 0006，但落盘前发现 `0006-goal-plan-taskid-recovery.md`、`0007-compaction-streaming-progress.md` 已被占用，故顺延为 **0008**。

关联：
- `docs/proposals/0002-goal-mode.md`（goal 模式「先规划 → 批准 → 执行」、计划即持久化 Evidence、progress 自底向上聚合）
- `docs/proposals/0004-goal-mode-runtime-gate.md`（goal 运行时闸门；`derivePlanStatus` 的「只前进」由来）
- `AGENTS.md`：「Evidence owns factual accountability」「Do not rely on prompt instructions as the only enforcement」「New Modules must increase Locality or Leverage」
- `apps/desktop/electron/main/goal-plan-store.mjs`（状态机与聚合的唯一实现处）

## 背景 / 现象

用户在 goal 模式下完成了一个计划的全部子任务后，面板顶部仍显示「执行中」徽章，而进度条同时显示「6/6 完成 / 100%」。两者矛盾，用户误以为还有未完成的工作或执行卡住。

实测多个已完成计划（批次 1/2/3：`0a4cf12f` 6/6、`6206c93e` 7/7、`813dafdb` 6/6）均为同一现象：**进度 100%，但顶层 `status` 仍为 `executing`**。

## 根因分析（代码证据）

`goal-plan-store.mjs` 中：

- **进度**由 `aggregateProgress(tasks)`（行 ~84）自底向上聚合**叶子**子任务得出，`percent = completed / total * 100`。这条路径正确，所以显示 100%。
- **顶层状态**由 `derivePlanStatus(currentStatus, tasks)`（行 ~125）派生。它当前**只**实现一种「只前进」规则：

  ```
  PRE_EXECUTION = { 'awaiting_approval', 'approved' }
  若 currentStatus ∈ PRE_EXECUTION 且存在任一活跃/终态叶子 → 'executing'
  否则原样返回 currentStatus
  ```

  其 docstring 明确写道：「**不做任何回退或终态推断**（completed/cancelled/paused/failed/drafting 等仍由显式写路径决定）」。

- `persist(plan)`（行 ~245）是所有写操作（含 `recordTaskEvidence`）的唯一收口点，每次写盘都会 `status: derivePlanStatus(...)` + `progress: aggregateProgress(...)`。

因此：当 `recordTaskEvidence` 把最后一个叶子置为 `completed` 后，`persist` 调 `derivePlanStatus('executing', allLeafTerminal)`——而 `'executing'` 不在 `PRE_EXECUTION` 集合里，函数原样返回 `'executing'`。**没有任何代码把顶层从 `executing` 推进到 `completed`**，这就是「100% 但仍执行中」的根因。

收尾本可由 `setPlanStatus(planId, 'completed')` 显式完成，但当前唯一驱动方（agent 通过 `goal_update_task` 回写子任务 Evidence）**没有暴露「关闭整个计划」的工具**，也没有任何自动收尾路径，于是顶层状态永远停在 `executing`。

## 设计取舍

收尾有两种可能实现：

1. **新增显式「关闭计划」工具/IPC**：让 agent 或面板按钮显式置顶层为 completed。
   - 缺点：新增能力面、新增协议；且「全部子任务完成」本身就是事实，再要一次显式动作是冗余，违反「progress 由事实派生、不可手填」的既有设计哲学（0002 §4）。
2. **扩展 `derivePlanStatus` 的同源「只前进」派生**（本提案选择）：顶层状态与 progress 同源、由叶子事实派生。
   - 与既有 `awaiting_approval → executing` 规则同构、同函数、同收口点（`persist`），**Locality 集中**，无新增能力面。

选定方案 2。新增规则（保持「只前进」「纯函数」「不回退」）：

```
若 currentStatus === 'executing'
   且 存在叶子（total > 0）
   且 所有叶子均为终态（completed | failed）：
     含任一 failed → 'failed'
     否则全 completed → 'completed'
否则维持原有逻辑（含原 PRE_EXECUTION → executing 规则）
```

**含 failed 时派生为 `failed`**（用户已确认，忠实反映结果），而非 completed 或滞留 executing。

## 边界 / 非目标

- **只前进、不回退**：已是 `completed/failed/cancelled/paused` 的计划不会被改回 `executing` 或互相翻转（`waiting_user` 叶子不是终态，存在它时不收尾）。
- **不与显式状态机竞争**：`setPlanStatus`、`recordApproval` 的显式写路径语义不变；本规则只在 `executing` + 全叶子终态这一确定事实下触发。
- `waiting_user`（blocked）叶子视为**未终态**——存在阻塞叶子时不收尾，维持 `executing`，符合「阻塞需人工处理」的直觉。
- 空计划（无叶子）不收尾（避免刚创建的空壳被判 completed）。
- 不新增 IPC、不改 renderer、不改 `GoalPlanStatus` 类型（`completed`/`failed` 已是合法值）、不改 `docs/architecture/*` 与 `AGENTS.md`。

## 实现

仅改 `apps/desktop/electron/main/goal-plan-store.mjs` 的 `derivePlanStatus`，在原 `PRE_EXECUTION` 分支之外、对 `currentStatus === 'executing'` 增加终态派生分支；纯函数、无副作用，`persist` 调用点不变。

## 验证

- 新增单测（`goal-plan-store.test.mjs`）：
  - `executing` + 全 `completed` → `completed`
  - `executing` + 含 `failed`（其余 completed）→ `failed`
  - `executing` + 仍有 `running`/`pending` → `executing`（不前进）
  - `executing` + 含 `waiting_user` → `executing`（阻塞不收尾）
  - 空叶子 → 不前进
  - 嵌套子树全终态 → 收尾
  - 现有「只前进，不干扰其它显式状态机」测试（行 78-84）仍通过
- `pnpm -C apps/desktop test` 通过、`pnpm -C apps/desktop typecheck` 通过。
- `git status` 确认改动仅限 `goal-plan-store.mjs`、`goal-plan-store.test.mjs`、`docs/proposals/0008-*`。
