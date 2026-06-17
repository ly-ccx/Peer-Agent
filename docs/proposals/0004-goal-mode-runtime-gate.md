# 0004 — Goal 模式运行时闸门 + request_user_input 可交互渲染

状态：提案（A 级变更：触及能力暴露、运行时契约、权限闸门、System Context、渲染层 Evidence 表达）。

关联：
- `docs/proposals/0002-goal-mode.md`（goal 模式「先规划 → 批准 → 执行」与持久化计划）
- `docs/proposals/0003-request-user-input.md`（提问即停的运行时护栏）
- `AGENTS.md` 非协商运行时链 / 「不得仅以 prompt 作为权限或能力边界的唯一执行手段」

## 背景 / 现象

用户在 goal（目标）模式的一次会话里观察到两个问题：

1. **没有产出目标和完整计划，就直接开始执行 / 直接 `request_user_input`。**
2. **等待用户输入时，界面把 `request_user_input` 的结果渲染成一坨原始 JSON**，没有把 `options`
   变成可点击选项，也没有「正在等待你输入」的状态，用户以为是请求失败卡住了。

## 根因分析（代码证据）

### 问题一：goal 模式缺少运行时闸门，规划阶段形同虚设

- 暴露给模型的 goal 工具**只有 `goal_update_task`**（`tools/goal-tool-definitions.mjs` 的
  `GOAL_TOOL_NAMES` 仅含 `updateTask`）。**没有任何让模型「创建计划」的工具** ——
  创建计划（`goalPlans:create`）只存在于 renderer→IPC→`goal-plan-store`，运行时链路里模型
  根本无法产出计划。
- `mode` 只流到 System Context（`llm-chat-service.mjs` 把 `mode` 传给 `buildSystemContext`），
  **没有进入 `toolContext`**（`tool-orchestrator.mjs` 的 `createToolContext` 只有
  `conversationId / workspacePath`），也没有进入 `permissionGate`。因此**工具执行层无法感知
  当前是不是 goal 模式、计划处于什么状态**，无法施加任何闸门。
- 现存唯一约束是 `prompt/sources/mode-copy.mjs` 里 goal 的文案。这违反 AGENTS.md
  「Do not rely on prompt instructions as the only enforcement」。结果 goal 模式退化为
  「chat + 偶尔提问」。

### 问题二：渲染层把交互结果当原始 JSON 输出

- 后端是对的：`request_user_input` 接受 `options`，并在结果里带 `control.terminal = true`，
  agent loop 据此 `sendDone()` 停住等待（`anthropic-agent-loop.mjs`）。
- 但 `ThinkingTimeline.tsx` 的 `renderToolResult` 对所有工具结果一视同仁，统一塞进
  `<pre className="tool-result-content">`。`request_user_input` 的 `question / options`
  因此以 JSON 文本出现，既不可点击，也没有等待态。

## 决策

在**不新增旁路执行路径**的前提下，沿用既有运行时链补齐两个缺口。

### A. 让 mode 与计划状态成为运行时执行上下文的一等公民

- `createToolContext` 增加 `mode` 与 `goalPlanStatus`（只读快照：是否存在计划、最高状态
  是否 `approved/executing`）。由 `llm-chat-service` 在构造 `toolContext` 时注入，数据来自
  `goal-plan-store.listPlansByConversation(conversationId)`。
- 这是 System Context 之外的**执行上下文**通道，不污染 prompt 字符串拼接。

### B. 新增 `goal_create_plan` 工具，让「规划」进入运行时链

- 新 Manifest 项 `goal_create_plan`（`capabilityId = local.goal.create`），经
  `local-goal-provider` 落到 `goal-plan-store.createPlan`，产出 `status='awaiting_approval'`
  的草稿计划并回写 Evidence（planId、artifactRefs）。
- 规划工具属 `L0_inert / D0_public`（只写本地计划草稿，等待人工批准，不触达外部副作用）。

### C. Goal 模式运行时闸门（执行层强制，不靠 prompt）

在 projected-tool 执行入口按 `toolContext.mode === 'goal'` 施加闸门：

- 计划不存在或未 `approved` 时：
  - 允许的工具：`goal_create_plan`、`goal_update_task`、`request_user_input`，以及只读/惰性
    检索类（`L0_inert`）。
  - 拒绝的工具：一切有副作用的能力（写文件、bash 变更、MCP 副作用等，`riskLevel` 非惰性）。
    返回结构化拒绝（denial），明确「goal 模式需先产出计划并获批准」。
- 计划已 `approved/executing` 时：放行，按既有权限链继续。

闸门是**新增的 PermissionGrant 前置判定**，复用既有 denial/Evidence 路径，不绕过 Runtime
Projection。

### D. `request_user_input` 的可交互渲染（表达层，不持有权限真相）

- 渲染层识别 `request_user_input` 的结果，提取 `question / options`：
  - 渲染为「问题文本 + 可点击选项按钮 + 等待你输入」的状态卡（替代原始 JSON）。
  - 点击某选项 = 复用既有 `submitMessage` 把该选项文本作为用户消息发送，不另造发送路径。
  - 无 `options` 时退化为纯等待提示，不再裸露 JSON。
- 解析在 renderer 的 state 规范化层（`clientToolCallEvents` 邻域）完成，作为受治理的
  factual context 投影；权限/终止真相仍在主进程 control signal。

## 影响面

- 协议：`packages/protocol` 暴露 goal 计划状态快照类型 / 交互结果视图类型（只读视图）。
- 运行时：`tool-orchestrator`、`projected-tool-executor`、`local-goal-provider`、
  `goal-tool-definitions`、`llm-chat-service`。
- System Context：`mode-copy.mjs` goal 文案对齐「必须先 `goal_create_plan` 再请求批准」。
- 渲染：`ThinkingTimeline.tsx` + 交互卡样式；复用 `submitMessage`。

## 测试

- 闸门：goal 模式下，无批准计划时副作用工具被拒、惰性/规划/交互工具放行；批准后放行。
- `goal_create_plan`：经运行时链产出 `awaiting_approval` 计划并回写 Evidence。
- 渲染：`request_user_input` 结果渲染为选项按钮 + 等待态，点击触发 `submitMessage`。

## 取舍 / 备选

- 备选「仅强化 prompt」：违反 AGENTS.md 唯一执行手段禁令，已否决。
- 备选「渲染层直接解析所有工具 JSON 做特例」：会让表达层承担过多协议知识，故收敛为单一
  交互结果视图类型 + 规范化层投影。
