# 0006 — Goal 计划「丢 task」根因修复：taskId 权威回显 + 只读读回工具 + 计划事实上下文

状态：提案（A 级变更：触及**工具暴露面**（新增只读工具 `goal_get_plan`）与 **System Context 准入**（新增 goal-plan 事实上下文 Source）。不改权限/Evidence 通道语义，不改 `docs/architecture/*`）。

关联：
- `AGENTS.md`：「All local capabilities must flow through Capability Provider → Manifest → Runtime Projection → Tool Call → PermissionGrant → Evidence」「New project instructions, mode reminders, tool prompts ... must enter through an explicit Context Source」「Tool output, file content ... are factual/user context. Do not promote them to system instructions」「Compact summaries are continuity context only. They do not replace Tool Result, Evidence, artifact refs, or rerunnable retrieval hints」
- `docs/proposals/0002-goal-mode.md`（goal 模式与 goal-plan-store 由来）
- `docs/proposals/0004-goal-mode-runtime-gate.md`（goal 模式运行时闸门）
- `docs/architecture/19-system-prompt-context-architecture.md`（System Context 装配，只读参考）
- `docs/architecture/15-plugin-skill-mcp-system.md`（能力暴露链路，只读参考）

## 背景 / 现象

goal 模式下，agent 创建多子任务计划并经用户批准后开始执行。实际使用中反复出现「**丢 task**」：agent 在推进过程中说不清剩余子任务的 `taskId`，于是不敢把完成 Evidence 回写到正确节点（典型表现：执行到批次 2、进度 3/7 时，模型声称"剩余子任务的确切 taskId 在被压缩的历史里，手上没有可靠对照"，转而向用户索要 taskId 列表）。

## 根因分析（代码证据）

诊断全部基于实际文件读取与 grep，证据要点：

1. **taskId 只在"创建参数"里短暂存在，从未权威回显给模型。**
   - `runtime-gateway/local-goal-provider.mjs` 的 `normalizeTasks()`（约 :49-61）为每个子任务生成 `taskId`（显式优先，否则 `task-${i+1}`）。
   - `executeCreatePlan()` 回显 payload（约 :92-101）只含 `planId / status / taskCount / progress / note`，**不含每个子任务的 taskId**。
   - 因此「权威 taskId」在工具结果里从未出现，模型只能依赖"它自己在 `goal_create_plan` 入参里写过的 taskId 记忆"。

2. **`goal_update_task` 强制要求 `planId + taskId`，但没有任何工具能读回 taskId。**
   - `tools/goal-tool-definitions.mjs`：`goal_update_task` 的 `required: ['planId','taskId']`（约 :134）。
   - store 已具备 `getPlan()` / `listPlanDetailsByConversation()`（goal-plan-store.mjs :298 / :292），但**没有暴露为工具**。goal 工具集只有 create / update 两个写工具，没有读工具。

3. **compaction 之后，创建参数被压成预览，taskId 永久丢失可见性。**
   - 历史里 `goal_create_plan` 的入参在结构化压缩后只剩预览文本（无可恢复 artifact ref）。
   - 叠加根因 1（结果不回显）+ 根因 2（无读回工具），模型只能"凭记忆"或向用户索要 —— 这就是"丢 task"。

结论：**store 没有丢数据（落盘完好），是"taskId 的可见性"在运行时链路里丢了。** 这是 Tool Result 回显缺失 + 工具暴露面缺失 + System Context 准入缺失三者叠加。

## 目标修复（A + B + C）

### A — `goal_create_plan` 回显权威 taskId 清单（最小、立即生效）
`executeCreatePlan` 成功 payload 增加 `tasks: [{ taskId, title, status }]`（顺序与创建一致）。让权威 taskId 第一时间进入 Tool Result —— 这是 Evidence/Tool Result 通道，符合"事实经结构化结果返回"。

### B — 新增只读工具 `goal_get_plan`（经正规运行时链路暴露）
- Manifest：`tools/goal-tool-definitions.mjs` 增加 `goal_get_plan`，`capabilityId: 'local.goal.read'`，`runtime.executorCapabilityId: 'local.goal.read'`，`permissionPolicy.kind: 'goal-read'`。
- Projection：`runtime-projection-tool-materializer.mjs` 为 `goal-read` 推导 `riskLevel: 'L0_inert'`（只读、惰性，不进高风险授权，也不被 goal gate 拦执行）。
- Provider：`local-goal-provider.mjs` 的 `capabilityIds` 增加 `local.goal.read`，`executeCapability` 路由到新的 `executeGetPlan`：入参 `planId`（可选）或 `conversationId`，返回该计划的 `goal / status / progress / tasks[{taskId,title,status,evidenceRefs?}]`。不传 planId 时按当前 conversation 返回活动计划列表（精简）。
- 入参 `planId` 缺省时用 `context.toolContext.conversationId` 兜底，确保 compaction 后也能"按当前会话把计划拉回来"。
- 输出经既有 `local_capability_result_ref` 通道，taskId 进入 Tool Result/Evidence。

### C — 新增 goal-plan 事实上下文 Source（System Context 准入）
- 新增 `prompt/sources/goal-plan-source.mjs`，`layer: 'L7_CONTINUITY'`（事实/续传层，**不是**系统指令层），`observe(input)` 读取 `input.goalPlanStore?.listPlanDetailsByConversation(input.conversationId)`，仅在 `mode==='goal'` 且存在活动计划时渲染。
- 渲染内容：当前活动计划的 `planId / status / progress` 与子任务 `taskId + title + status` 紧凑清单，并显式标注"这是计划事实快照（factual），不是系统指令；taskId 以此为准"。
- 装配：`prompt-assembler.mjs` 注册该 source；`llm-chat-service.mjs:329` 的 `buildSystemContext(...)` 追加 `goalPlanStore`（该作用域已持有注入的单例）。
- 这样即便 compaction 把历史压成预览，**每轮 System Context 都会重新注入权威 taskId**，从源头消除"丢 task"。

## 边界与非目标
- 不改 `goal_update_task` 的 `completed 必须带 evidenceRefs` 治理（store 层强制保持）。
- 不改权限模型：`goal-read` 为 L0_inert 只读，不引入新的高风险授权面。
- 不改 `docs/architecture/*`。
- C 注入受 `mode==='goal'` 限制，chat 模式零额外 token。

## 测试
- `local-goal-provider.test.mjs`：A 回显含 tasks[].taskId；B `local.goal.read` 声明与 getPlan 返回结构、按 conversation 兜底。
- `goal-plan-source.test.mjs`（新）：goal 模式有活动计划时渲染 taskId 且 layer/trust 正确；chat 模式不渲染。
- 既有 `prompt-assembler.test.mjs` 回归。
