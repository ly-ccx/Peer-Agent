# Goal Runner + Explorer SubAgents 实施任务清单

## 背景

当前 Goal 模式更接近“Plan 模式”：用户提出目标后，系统生成计划，用户批准后通常只是触发一条继续执行消息，缺少跨 turn 持续托管、自动推进、证据不足时自动探索、以及明确的 Runner 生命周期。

本计划目标是把 Goal 模式升级为更接近 Codex Goal 的托管执行体验：用户批准目标计划后，系统进入受控的自动推进模式；遇到不确定或证据不足时，可以派发只读 Explorer SubAgents 进行探索；所有本地能力仍必须经过既有权限与 Evidence 链路。

## 已确认设计决策

### 1. 状态模型

采用收窄版状态模型：

```text
GoalPlan + runner
```

不新增独立 `GoalSession` / `GoalRun` 表。当前 conversation 下仍活跃的最新 `GoalPlan` 即为 active goal。

`GoalPlan.status` 表示目标/计划整体生命周期：

```text
drafting / awaiting_approval / approved / executing / paused / completed / cancelled / failed
```

`GoalPlan.runner.status` 表示自动推进器运行状态：

```text
idle / running / paused / exploring / blocked / budget_exhausted / completed / failed
```

`GoalPlan.tasks[].status` 继续表示具体任务 Evidence 进度。

### 2. Runner 自动化程度

采用 **Hands-off Goal Runner + Explorer SubAgents**：

- 用户批准计划后，Runner 托管推进目标。
- Runner 可以在已批准的 `goal / boundaries / successCriteria` 内自动执行、验证、修复、继续推进。
- Runner 不把每一步伪装成用户消息。
- Runner 必须在权限拒绝、需要用户选择、预算耗尽、证据不足、越界风险时停止到明确状态。
- Runner 不绕过权限审批，不跳过 Evidence，不直接执行本地能力。

### 3. Explorer SubAgents 范围

Explorer SubAgents 用于不确定或证据不足时的只读探索：

- 可以查证、搜索、读取、诊断、验证。
- 返回结构化报告和 Evidence refs。
- 第一版不允许写文件。
- 第一版不允许更新 `GoalPlan`。
- 第一版不允许直接调用 `goal_update_task`。
- 第一版不允许 ask user；如需要用户决策，报告给主 Runner。

### 4. 架构约束

继续遵守当前仓库的非协商运行时链：

```text
Capability Provider
  -> Manifest
    -> Runtime Projection
      -> Tool Call
        -> PermissionGrant
          -> Evidence
```

Renderer 只负责表达状态和发送用户控制意图，不执行本地能力，不保存权限真相。

`docs/architecture/*` 默认只读。本任务清单不修改架构文档；实际实现完成后，在总结中说明架构影响。如后续需要更新架构文档，需单独确认。

## 当前已确认代码落点

基于当前仓库检查，相关落点如下：

- `packages/protocol/src/goal.ts`
  - 已有 `GoalPlan` / `GoalTask` / `GoalPlanStatus` 等协议类型。
  - 目前需要新增 runner 相关类型与字段。

- `apps/desktop/electron/main/goal-plan-store.mjs`
  - 已有 GoalPlan 持久化、progress 聚合、task Evidence 回写等逻辑。
  - 需要新增 runner 状态读写、active plan 查询等 store seam。

- `apps/desktop/electron/main/runtime-gateway/local-goal-provider.mjs`
  - 已有 `goal_create_plan` / `goal_update_task` / `goal_get_plan` 的本地 Provider。
  - 已经遵循能力链路返回 PermissionGrant / Evidence。

- `apps/desktop/electron/main/tools/goal-tool-definitions.mjs`
  - 已有 Goal 模式工具 Manifest 定义。
  - 后续可继续通过 Runtime Projection 控制 Goal/Explorer 模式下可见工具。

- `apps/desktop/package.json`
  - 可用验证脚本：`test`、`typecheck`、`build`。

- 根目录 `package.json`
  - 可用验证脚本：`pnpm -r typecheck`、`pnpm architecture:check`、`pnpm -r build` 等。

## Slice 1：协议 + GoalPlan Store Runner 状态

### 目标

让当前 `GoalPlan` 支持轻量 `runner` 状态，并保证旧计划兼容。

### 任务清单

- [x] 在 `packages/protocol/src/goal.ts` 新增 `GoalRunnerStatus`。
- [x] 在 `packages/protocol/src/goal.ts` 新增 `GoalRunnerIntent`。
- [x] 在 `packages/protocol/src/goal.ts` 新增 `GoalRunnerState`。
- [x] 在 `GoalPlan` 上新增 `runner?: GoalRunnerState`。
- [x] 在 `apps/desktop/electron/main/goal-plan-store.mjs` 增加 runner 默认归一化逻辑。
- [x] 在 store 中新增 `setRunnerState(planId, patch)`。
- [x] 在 store 中新增 `getActivePlanByConversation(conversationId)` 或等价 helper。
- [x] 确保 runner 状态更新不会影响 task progress 聚合。
- [x] 增加/更新 store 单测，覆盖 runner 状态读写与旧计划兼容。

### 建议类型草案

```ts
export type GoalRunnerStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'exploring'
  | 'blocked'
  | 'budget_exhausted'
  | 'completed'
  | 'failed';

export type GoalRunnerIntent =
  | 'execute'
  | 'verify'
  | 'explore'
  | 'synthesize'
  | 'block';

export interface GoalRunnerState {
  readonly enabled: boolean;
  readonly status: GoalRunnerStatus;
  readonly intent?: GoalRunnerIntent;
  readonly currentTaskId?: string;
  readonly turnCount: number;
  readonly toolCallCount: number;
  readonly explorerCount: number;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxExplorers: number;
  readonly blockedReason?: string;
  readonly lastError?: string;
  readonly updatedAt: string;
}
```

### 验收标准

- [x] 旧 plan 文件缺少 `runner` 字段时仍可读取。
- [x] runner 状态可以写入并读回。
- [x] runner patch 不绕过 task Evidence 约束。
- [x] completed task 仍必须带 evidenceRefs。
- [x] typecheck 通过。

### 建议验证命令

```bash
pnpm --filter @peer-agent/protocol typecheck
pnpm --filter @peer-agent/desktop test
pnpm --filter @peer-agent/desktop typecheck
```

### 当前验证记录

```bash
pnpm --filter @peer-agent/protocol typecheck
node --test apps/desktop/electron/main/goal-plan-store.test.mjs
pnpm --filter @peer-agent/desktop typecheck
```

## Slice 2：Goal Runner Skeleton + Fake Runtime 测试

### 目标

新增主进程 Runner 编排模块，但暂不接真实 UI 和真实模型调用。先用 fake runtime 证明状态机成立。

### 任务清单

- [x] 新增 `apps/desktop/electron/main/goal-runner.mjs`。
- [x] 新增 `apps/desktop/electron/main/goal-runner.test.mjs`。
- [x] 实现 `createGoalRunner(...)` 工厂。
- [x] 实现 `start(planId, options)`。
- [x] 实现 `pause(planId, reason)`。
- [x] 实现 `resume(planId)`。
- [x] 实现 `clear(planId)`。
- [x] 实现 `getState(planId)`。
- [x] 增加 fake `chatRuntime` 测试，验证自动多 tick 推进。
- [x] 增加预算、暂停、取消、完成、失败等状态转换测试。

### 核心接口草案

```js
createGoalRunner({
  goalPlanStore,
  chatRuntime,
  explorerRunner,
  emitEvent,
  now,
  logger,
})
```

### Runner 职责

```text
读取 GoalPlan
  -> 判断是否可继续
  -> 组装 goal continuation 请求
  -> 调用 chatRuntime 产生 assistant turn
  -> 等待该 turn 完成，包括工具链路和 Evidence
  -> 重新读取最新 GoalPlan
  -> 判断继续 / 探索 / 完成 / 阻塞 / 预算耗尽
```

### Runner 禁止事项

- [x] 不直接读写文件系统能力。
- [x] 不直接调用 bash/file/MCP provider。
- [x] 不绕过 permission review。
- [x] 不伪造 Tool Result。
- [x] 不在没有 Evidence 的情况下标记完成。

### 验收标准

- [x] `start` 会把 plan/runner 置为 executing/running。
- [x] `pause` 会停止后续 tick。
- [x] `clear` 会 cancel plan 并停止 Runner。
- [x] budget 用尽会进入 `budget_exhausted`。
- [x] fake runtime 连续返回 progress 时，Runner 能自动多 tick 推进。
- [x] Runner 每轮重新读 store，不依赖旧内存 plan。

### 建议验证命令

```bash
pnpm --filter @peer-agent/desktop test -- goal-runner
pnpm --filter @peer-agent/desktop typecheck
```

### 当前验证记录

```bash
node --test apps/desktop/electron/main/goal-runner.test.mjs
node --test apps/desktop/electron/main/goal-plan-store.test.mjs
pnpm --filter @peer-agent/desktop typecheck
pnpm --filter @peer-agent/protocol typecheck
```

## Slice 3：Runner 自动推进策略

### 目标

把 Runner 从 skeleton 升级为 hands-off 自动推进：能识别继续执行、阻塞、预算耗尽、完成前验证。

### 任务清单

- [x] 实现 leaf task 提取与完成判定。
- [x] 实现 successCriteria 检查入口。
- [x] 实现 intent 决策：`execute | verify | explore | synthesize | block`。
- [x] 实现 no-progress 防护。（`pump` 闭包内双信号检测：`progress.completed` 计数 + 叶子 `evidenceRefs` 总数，任一增长即「有进展」；连续 3 轮无增长判 `blocked(no_progress)`，先于预算上限触发。局部计数随 `pump` 重新拉起而清零，匹配 resume「既往不咎」语义。提交 `9b916a3`）
- [x] 实现权限拒绝后的 stop/block 策略。
- [x] 实现 `request_user_input` 后的 stop/block 策略。
- [x] 实现工具失败后的 exception policy 处理入口。
- [x] 实现预算耗尽后的 `budget_exhausted` 状态。

### 默认预算建议

第一版不做无限后台无人值守，建议默认：

```text
maxTurns: 12
maxToolCalls: 80
maxExplorers: 4
```

### 自动完成条件

- [x] 所有 leaf tasks 均为 `completed`。
- [x] 每个 completed task 均有 evidenceRefs。
- [x] successCriteria 有对应结果说明或 Evidence。
- [x] 完成状态由 Runner 写入 plan/runner 状态，但任务完成仍必须经 `goal_update_task` Evidence 回写。

### 阻塞条件

- [x] 权限被拒绝。
- [x] 需要用户选择或确认。
- [x] 工具失败且 exception policy 要 pause/ask_user。
- [x] budget 耗尽。
- [x] Explorer 也无法补足证据。
- [x] 模型连续 N 轮未产生有效进展。（N=3 双信号无进展检测，判 `blocked(no_progress)`，提交 `9b916a3`）

### 验收标准

- [x] 所有 leaf tasks completed 且有 evidenceRefs 时，Runner 可以进入 verify/complete 流程。
- [x] 没有 evidenceRefs 时不允许目标完成。
- [x] 连续无进展不会无限循环。（N=3 双信号无进展检测先于预算上限触发 `blocked(no_progress)`，预算上限作为最终兜底）
- [x] 遇到用户选择需求时进入 blocked/paused，而不是继续跑。

### 当前验证记录

```bash
node --test apps/desktop/electron/main/goal-runner.test.mjs
```

## Slice 4：Explorer SubAgents 只读探索

### 目标

Runner 在证据不足、路径不确定、失败原因不明时，能自动派发只读 Explorer。

### 任务清单

- [x] 在 `packages/protocol/src/goal.ts` 新增 `GoalExplorerRun`。
- [x] 在 `packages/protocol/src/goal.ts` 新增 `GoalExplorerReport`。（同时新增 `GoalExplorerRequest` / `GoalExplorerProfile` / `GoalExplorerStatus`）
- [x] Explorer runner 能力落地。（经评估确认为最终设计，不再拆分独立文件：explorer 三职责天然分属现有三层——`main.mjs` 注入 `explorerRunner.runExplorer`（传输/适配）、`goal-runner.mjs` `pump` 循环编排、`goal-plan-store.mjs` `dispatchExplorer/reportExplorer` 持久化。硬抽独立文件会形成跨三层的浅包装，违反 YAGNI 与「避免 shallow pass-through wrappers」）
- [x] Explorer 行为测试覆盖。（经评估确认为最终设计，不再建独立测试文件：explorer 派发/回填/失败降级/预算行为本质是 `pump` 循环行为，由 `goal-runner.test.mjs` 端到端覆盖更真实；独立单测需 mock 三层，测的是包装而非行为）
- [x] Explorer run/report 持久化位置确定。（经评估确认为最终设计，落在 `plan.runner.explorers`，与 Slice 1 已确认的「收窄版 GoalPlan + runner」状态模型一致；sidecar 会引入第二套持久化路径、与该决策冲突，故不采用）
- [x] 实现只读 Runtime Projection 过滤。（`runtime-projection-tool-materializer.mjs` 按 `mode === 'explorer'` 过滤）
- [x] 实现 Explorer 预算计数。（`maxExplorers` + explorer 工具调用计入预算）
- [x] 实现 Explorer 失败后的主 Runner 降级处理。

### Explorer Report 草案

```ts
export interface GoalExplorerReport {
  readonly explorerId: string;
  readonly planId: string;
  readonly question: string;
  readonly findings: string[];
  readonly evidenceRefs: string[];
  readonly confidence: 'low' | 'medium' | 'high';
  readonly recommendedNextAction?: string;
  readonly blockedReason?: string;
}
```

### Explorer 权限边界

Explorer projection 默认允许：

- [x] `L0_inert`
- [x] `L1_local_read`
- [x] 明确只读能力（`read_file` / `search_files` 等带 `explorer` 模式标记的只读工具）

Explorer projection 默认禁止：

- [x] 写文件。
- [x] 删除/移动。
- [x] commit。
- [x] 上传。
- [x] 外部写操作。
- [x] privileged/destructive 能力。
- [x] `goal_update_task`。
- [x] 直接修改 `GoalPlan`。

### 验收标准

- [x] Explorer projection 不包含写/危险能力。
- [x] Explorer report 必须带 Evidence refs 才能作为完成依据。
- [x] Explorer 失败不会让主 Runner 崩溃。
- [x] Explorer 数量受 `maxExplorers` 控制。
- [x] Explorer 不直接更新 task 状态。

## Slice 5：System Context 接入

### 目标

Runner continuation turn 和 Explorer turn 都通过明确 Context Source/adapter 注入上下文，不拼普通用户消息。

### 任务清单

- [x] 查找当前 system context assembly seam。（`prompt-assembler.mjs` registry + `buildSystemContext`，input 透传 observe）
- [x] 新增或接入 `GoalRunnerContextSource`。（`prompt/sources/goal-runner-source.mjs`，已注册）
- [x] 新增或接入 `ExplorerContextSource`。（`prompt/sources/explorer-source.mjs`，已注册）
- [x] 给 Runner turn 注入 active goal summary。（goal 模式读 `getActivePlanByConversation`）
- [x] 给 Runner turn 注入当前 task、boundaries、successCriteria、budget、Evidence refs。
- [x] 给 Explorer turn 注入 brief、scope、只读约束、报告 schema。（source 就绪；需调用方在 explorer turn 传 `mode:'explorer'` + `explorerContext`，在 Slice 4/8 explorer turn 接线时透传）
- [x] 确保普通 chat 模式不注入 Goal Runner 上下文。（mode!=='goal'/'explorer' 返回空，测试覆盖）
- [x] 确保 provider-specific message shape 不散落到 runner 中。（仅产出 section content，shape 仍由 provider encoder seam 负责）

### Runner 必须注入的约束

- [x] 继续推进当前 goal，不重新规划无关目标。
- [x] 不确定时优先读 authoritative `goal_get_plan`。
- [x] 完成 task 后必须用 `goal_update_task` 回写 Evidence。
- [x] 不可越过 boundaries。
- [x] 需要用户决策时调用 `request_user_input` 并让 Runner 停止。

### 验收标准

- [x] Goal 模式 runner turn 有明确 goal context。（`goal-runner-source.test.mjs`）
- [x] Explorer turn 有明确只读约束。（`explorer-source.test.mjs`）
- [x] 普通 chat 模式不受影响。（测试覆盖 + chat 模式零额外 section）
- [x] Prompt/Context 注入不变成零散字符串拼接。（统一走 Context Source）

## Slice 6：批准流程接 Runner

### 目标

把当前“批准后发一条开始执行消息”的语义改成“批准后启动 Goal Runner”。

### 任务清单

- [x] 找到 `GoalPlanPanel.tsx` / ChatSurface 的批准链路。（`GoalPlanPanel.tsx:464` decide → clientApi；`ChatSurface.tsx:1016` 批准后托管推进，不伪造用户消息）
- [x] 增加或复用 preload / IPC runner 控制接口。（`clientApi.goalRunnerPause/Resume/Clear` 等已接线）
- [x] main process 注册 `goalRunner:start`。（`main.mjs:754`）
- [x] main process 注册 `goalRunner:pause`。（`main.mjs:755`）
- [x] main process 注册 `goalRunner:resume`。（`main.mjs:756`）
- [x] main process 注册 `goalRunner:clear`。（`main.mjs:757`）
- [x] main process 注册 `goalRunner:getState`。（实现为 `goalRunner:get-state`，`main.mjs:753`）
- [x] 批准后调用 store `recordApproval(...)`。（`main.mjs:746` goalPlans:approve handler）
- [x] 批准后设置 `GoalPlan.status = executing`。（由 `start`→`initializeRunner` 内部推进，非 handler 内直写）
- [x] 批准后设置 `runner.enabled = true`。（同上，`initializeRunner` 内部完成）
- [x] 批准后启动 `goalRunner.start(planId)`。（`main.mjs:748`，仅 `approval.decision === 'approve'` 时）
- [x] 保留 reject/revise 流程。（非 approve 分支不启动 Runner；`goalPlans:revise` 独立保留）

### 改造后事件流

```text
approve GoalPlan
  -> store.recordApproval(...)
  -> set plan.status = executing
  -> set runner.enabled = true
  -> goalRunner.start(planId)
```

### 验收标准

- [x] 未批准 plan 不会启动 Runner。（`initializeRunner` 批准守卫：仅 `approval.decision === 'approve'` 或已在 executing/paused 才放行）
- [x] 批准后启动 Runner。（`goalPlans:approve` → `goalRunner.start`，`main.mjs:748`）
- [x] Runner 自动推进，不需要用户每步发消息。（`pump` 循环托管，`ChatSurface.tsx:1016` 不再伪造用户消息）
- [x] reject/revise 语义不被破坏。（非 approve 分支不启动；revise 链路独立保留）

### 当前验证记录

- 批准守卫：`apps/desktop/electron/main/goal-runner.mjs` `initializeRunner` 放行条件改为 `approval.decision === 'approve'` 或 plan 已在 executing/paused（resume 可重入）。
- 测试：`node --test apps/desktop/electron/main/goal-runner.test.mjs` → 14 pass / 0 fail。
- 类型：`pnpm -r typecheck` 通过。
- 提交：`f68e1fb`（Slice 6 批准守卫）。
- 级别：B 级（动 Runner 启动契约语义），不碰协议、不碰只读区。

## Slice 7：Renderer 状态表达

### 目标

UI 表达托管运行状态，而不是把每个 tick 刷进聊天流。

### 任务清单

- [x] 在 Goal 面板/浮条显示 Runner 状态。
- [x] 显示状态：running / exploring / blocked / paused / budget_exhausted / completed / failed。
- [x] 显示 counters：turns、tool calls、explorers。
- [x] 增加 pause 按钮。
- [x] 增加 resume 按钮。
- [x] 增加 clear 按钮。
- [x] 增加 blocked/budget_exhausted 提示。
- [x] 增加 Explorer 折叠列表。
- [x] Explorer 列表显示 question、confidence、Evidence refs。
- [x] 主聊天流保持干净，不把每个 tick 伪装成用户消息。

### 验收标准

- [x] 用户能看到 Runner 当前状态。
- [x] pause 后无新 tick。
- [x] resume 从当前 plan 状态继续。
- [x] clear 后不再注入 goal context。
- [x] Renderer 没有直接执行本地能力。

### 当前验证记录（据实读码核验，未改代码）

调用链（renderer 控制意图 → IPC → main runner，全程不在 renderer 执行本地能力）：

```text
GoalPlanPanel 按钮 onControl(plan,'pause'|'resume'|'clear')
  → controlRunner (GoalPlanPanel.tsx:441) → clientApi.goalRunnerPause/Resume/Clear
    → IPC goalRunner:pause/resume/clear (main.mjs:755-757)
      → goalRunner.pause/resume/clear (goal-runner.mjs)
        → 广播 goalRunner:changed → 面板 reload 重渲染
```

逐条核验：

- 用户能看到 Runner 状态：`GoalPlanPanel.tsx` RunnerSection 渲染 status/counters/attention（running/exploring/blocked/paused/budget_exhausted/completed/failed）。
- pause 后无新 tick：`pause` 置 `session.cancelled=true`（goal-runner.mjs:281），`pump` 以 `while(!session.cancelled)` 及多处 `if(session.cancelled) return` 守卫，下一 tick 不再启动。
- resume 从当前 plan 状态继续：`resume`（goal-runner.mjs:244）读当前 plan、终态拒绝、置 `executing`/`running` 并新建 session 重启 `pump`，从 store 当前状态续推。
- clear 后不再注入 goal context：clear 置 plan `cancelled` + runner `enabled:false`（goal-runner.mjs:282-284）；context source `normalizePlan` 对非 active 状态返回 null（goal-runner-source.mjs）；store `isActivePlan`/`ACTIVE_PLAN_STATUSES` 不含 cancelled（goal-plan-store.mjs:343,403）。双保险。
- Renderer 不执行本地能力：`controlRunner` 仅经 `clientApi.goalRunner*` 发 IPC 控制意图，本地能力全部在 main 侧 runner 执行。

结论：5 条验收标准均由代码强制成立，非仅靠约定。

## Slice 8：集成验证与收敛

### 目标

确保 Goal Runner、Explorer、权限、Evidence、UI、普通 chat 模式之间的边界成立。

### 集成场景

- [ ] approve plan -> runner start -> fake assistant executes -> `goal_update_task` -> completed。
- [ ] missing evidence -> explorer starts -> explorer report -> runner continues。
- [ ] permission denied -> runner blocked。
- [ ] `request_user_input` -> runner paused/blocked。
- [ ] budget exhausted -> runner `budget_exhausted`。
- [ ] clear active goal -> no more goal context injection。
- [ ] 普通 chat 不注入 runner context。

### 建议验证命令

```bash
pnpm --filter @peer-agent/protocol typecheck
pnpm --filter @peer-agent/task-thread test
pnpm --filter @peer-agent/desktop test
pnpm --filter @peer-agent/desktop typecheck
pnpm --filter @peer-agent/desktop build
pnpm -r typecheck
pnpm architecture:check
```

## 最终完成标准

- [ ] `GoalPlan.runner` 可持久化和恢复。
- [ ] 用户批准后启动 Runner，而不是伪造用户消息。
- [ ] Runner 能自动连续推进多个 assistant turns。
- [ ] Runner 遇到不确定/证据不足能派发只读 Explorer SubAgents。
- [ ] Explorer 不能写文件。
- [ ] Explorer 不能改 plan。
- [ ] Explorer 不能绕权限。
- [ ] task 完成必须有 Evidence refs。
- [ ] 权限拒绝时 Runner 停在明确状态。
- [ ] 用户选择需求时 Runner 停在明确状态。
- [ ] 预算耗尽时 Runner 停在明确状态。
- [ ] 证据不足时 Runner 不假装完成。
- [ ] Renderer 只表达状态和控制，不执行工具。
- [ ] 普通 chat 模式不受 Goal Runner 影响。
- [ ] 主聊天流不被 Explorer 子 Agent 刷屏。
- [ ] 相关 typecheck/build/test 通过，或失败项有明确原因和下一步。

## 建议提交切片

建议按以下提交顺序推进：

1. `Add goal runner state to GoalPlan store`
2. `Add goal runner skeleton and tests`
3. `Implement hands-off goal runner loop`
4. `Add read-only explorer subagent runner`
5. `Add goal runner context sources`
6. `Start goal runner after plan approval`
7. `Render goal runner status controls`
8. `Stabilize goal runner integration tests`

## 风险与控制

### 风险：自动推进无限循环

控制：预算限制、no-progress 检测、每轮重读 authoritative plan、blocked 状态。

### 风险：Explorer 越权执行

控制：只读 Runtime Projection、测试断言危险能力不可见、Explorer 不暴露 `goal_update_task`。

### 风险：Renderer 承载执行逻辑

控制：Renderer 只调用 IPC 控制意图，不判断下一步，不执行本地能力。

### 风险：无 Evidence 完成任务

控制：store 层继续强制 completed task 必须带 evidenceRefs，Runner 只消费 Evidence，不制造 Evidence。

### 风险：System Context 零散拼接

控制：通过明确 Context Source/adapter 注入 runner/explorer 上下文，provider-specific formatting 保持在 encoder seam 后面。

## 暂不做事项

第一版暂不做：

- [ ] 多个 active goals 并行。
- [ ] 跨 conversation 共享 goal。
- [ ] Explorer 写文件或改 plan。
- [ ] 完整任务控制台 UI。
- [ ] 自动绕过权限审批。
- [ ] 无限后台无人值守。
- [ ] 修改 `docs/architecture/*`。
