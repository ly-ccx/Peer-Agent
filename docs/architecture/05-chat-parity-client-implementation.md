# 客户端 Chat 能力补齐实施设计

> 状态：实施设计草案  
> 目标：让 Zeus Atlas 桌面端在 Chat 能力上不低于 Web 小二，同时保留 Codex-like 客户端形态和端云能力代理边界。

---

## 一、核心判断

客户端不能只做一个新的聊天输入框。

Web 端当前的 Chat 组件已经不是普通 Chat UI，而是完整的 Agent 会话运行面：

```text
Page AI Assistant
  + AgentContext Bridge
  + Conversation Runtime
  + SSE Execution Runtime
  + Thinking / Tool / Confirmation Runtime
  + Share / Memory / Billing / Channel Runtime
```

所以 Zeus Atlas 的补齐目标不是：

```text
接一个 /stream 接口
  + 显示 user / assistant message
```

而是：

```text
Web Chat 能力等价
  + Codex-like 桌面任务线程
  + 本地能力 Tool Call / Evidence 增量
```

客户端形态可以和 Web 不一样，但能力语义不能少。

---

## 二、设计原则

本设计遵循 Zeus Atlas 已有工程哲学：

```text
云端负责认知。
本地负责能力。
界面负责表达。
契约负责边界。
证据负责治理。
```

对 Chat 补齐来说，含义是：

- 云端继续持有 Agent cognition、planning、tool choice、execution ledger。
- 客户端不成为本地 CEO Agent Runtime。
- 客户端可以承载更强的任务线程、上下文选择、本地工具授权和 Evidence 展示。
- Web Chat 的能力要被抽成协议和运行时，而不是把 Web 页面照搬进桌面端。
- 所有本地能力仍走 `Capability Provider -> Manifest -> Runtime Projection -> Tool Call -> Evidence`。
- 本地个人经验遵循“云端为准，个人为辅”，默认只作为本次会话辅助上下文，不自动进入云端 Patch 或 1688 cognition ontology。

---

## 三、Web Chat 能力基线

当前 Web 端参考实现：

- `/Users/liangyin/Documents/DEV/cbu-star-link/module-app-runner/src/components/PageAIAssistant/index.tsx`
- `/Users/liangyin/Documents/DEV/cbu-star-link/module-ai-chat-flow/src/components/AIDialog/AIDialogBox.tsx`
- `/Users/liangyin/Documents/DEV/cbu-star-link/module-ai-chat-flow/src/service/aiChatService.ts`
- `/Users/liangyin/Documents/DEV/cbu-star-link/core-ai-bridge/src/bridge.ts`
- `/Users/liangyin/Documents/DEV/cbu-star-link/core-ai-bridge/src/hooks.ts`

规模基线：

| 模块 | 规模 |
|---|---:|
| `AIDialogBox.tsx` | 5664 行 |
| `aiChatService.ts` | 1643 行 |
| `AIDialog` 目录 | 118 个文件 |
| `AIDialog/__tests__` | 41 个测试 |
| 前端显式接口入口 | 约 58 个 |

这说明 Web Chat 的核心不是 UI 外观，而是以下能力集合。

### 3.1 会话与 Channel

必须支持：

- 创建会话。
- 会话列表。
- 会话详情。
- 删除会话。
- 切换会话。
- 历史消息分页。
- URL / view state 同步。
- Web channel。
- DingTalk direct channel。
- DingTalk group channel。
- RoundTable channel。
- Automation channel。
- Share channel。

客户端可以不把所有 Channel 首屏展开，但协议和状态模型必须保留。

### 3.2 ConversationView

Web 端已经把会话视图抽成：

```text
live
frozen
hybrid
```

能力集包括：

```text
canSend
canEdit
canBranch
canShare
readOnly
```

客户端也必须有同样概念。否则分享、旁观、派生会话、只读查看、超级权限都会在桌面端重新变成散落判断。

### 3.3 消息与消息操作

必须支持：

- user / assistant / system message。
- 流式 assistant message。
- message uuid 回填。
- 图片消息。
- 引用消息。
- 复制。
- 重新生成。
- 删除用户消息。
- 从某条消息分支新会话。
- 截断后续消息并重跑。

### 3.4 Stream Execution

Web 端 stream 不是简单文本 delta，而是 Agent 执行事件流。

客户端必须识别：

- `status`
- `skill_loaded`
- `tools_ready`
- `step_start`
- `llm_calling`
- `step_content`
- `tool_calling`
- `tool_start`
- `tool_result`
- `workflow_progress`
- `step_complete`
- `final_output_start`
- `result`
- `complete`
- `chat_complete`
- `billing_update`
- `error`
- deliberation / group / roundtable 事件族

客户端不能把所有事件都压平成 assistant text，否则会丢掉 Agent 运行态。

### 3.5 Thinking Process

Web 端已有三层推理视窗：

```text
IterationNode
  -> ToolCard
    -> SkillStep / NestedSkill
```

客户端必须能展示：

- Agent iteration。
- thinking content。
- tool call card。
- tool arguments。
- tool result。
- nested skill。
- duration。
- waiting user。
- error / warning。
- 历史 CoT 懒加载。
- tool card 折叠状态持久化。

### 3.6 Human Confirmation

必须支持两类确认：

- dispatch confirm：多角色调度是否放行。
- human confirmation：Skill checkpoint 是否继续。

确认不是普通消息，而是执行阻塞点：

```text
pending confirmation
  -> user decision
    -> cloud confirm api
      -> resume execution
        -> stream / poll continuation
```

客户端必须把它渲染成线程里的阻塞卡片，而不是弹一个泛化 confirm。

### 3.7 输入能力

必须支持：

- IME composition。
- Enter / Shift Enter。
- Stop generation。
- quote chips。
- image upload。
- paste image。
- drag drop image。
- quick prompt。
- assistant suggestions。
- inline completion。
- input draft persistence。

这些不是“体验优化”，而是 Web 已经具备的生产能力。

### 3.8 AgentContext Bridge

Web 端通过 `core-ai-bridge` 支持：

- `AgentContext`
- `AIReferenceScope`
- `AIQuoteDraft`
- `AIAction`
- `PayloadHandler`
- `AssistantState`

客户端需要等价对象，但实现形态不同。

Web 是页面和 AI 助手之间的 bridge；客户端应升级为：

```text
DesktopContextBridge
  -> workspace context
  -> selected project context
  -> selected local reference
  -> local capability context
  -> page / plugin provided action context
```

### 3.9 Working Memory / Wiki / Billing / Share

这些可以分阶段实现，但模型不能缺：

- conversation billing summary。
- agent billing summary。
- working memory。
- memory wiki status。
- memory wiki pages。
- compile status / retry。
- create share。
- share detail。
- continue from share。
- revoke share。
- share list。
- share ACL。
- spectator config。

---

## 四、客户端补齐路线

补齐顺序必须是：

```text
Protocol
  -> Chat Kernel
    -> Cloud Chat Gateway
      -> Renderer Runtime
        -> Codex-like UI
          -> Client Tool Call 增量
```

不能先画完整 UI，然后把能力一点点塞进去。

### 4.1 Protocol 层

目标位置：

```text
packages/protocol/src/chat.ts
packages/protocol/src/execution.ts
packages/protocol/src/channel.ts
packages/protocol/src/share.ts
packages/protocol/src/memory.ts
```

需要新增对象：

```text
Conversation
ConversationView
ConversationSource
ConversationCapabilities
ConversationLineage
ConversationChannel
ChatMessage
MessageAction
MessageReference
MessageImage
StreamEvent
ThinkingProcess
IterationNode
ToolCard
SkillStep
NestedSkill
PendingDispatch
PendingHumanConfirmation
ResolvedHumanConfirmation
WorkingMemorySection
ConversationShare
ConversationBillingSummary
```

协议层只定义对象，不写 React 状态，不依赖 Electron。

### 4.2 Chat Kernel 层

目标位置：

```text
packages/chat-kernel/src/
```

需要补：

```text
stream-parser.ts
chat-reducer.ts
thinking-reducer.ts
conversation-actions.ts
message-actions.ts
confirmation-reducer.ts
roundtable-reducer.ts
recovery.ts
```

职责：

- 解析 SSE。
- 把 stream event 归一成 timeline state。
- 维护当前 assistant message。
- 维护 thinking process。
- 维护 tool card。
- 维护 confirmation pending / resolved。
- 处理 cancel / error / retry / recovery。
- 根据 `ConversationView.capabilities` 计算消息操作。

这一层必须可单测。Renderer 只消费 view model。

### 4.3 Cloud Chat Gateway

目标位置：

```text
apps/desktop/electron/main/cloud-chat-service.mjs
apps/desktop/electron/main/chat-stream-service.mjs
apps/desktop/electron/preload/preload.cjs
apps/desktop/renderer/src/clientApi.ts
```

原则：

- Renderer 不直接持有 token。
- Renderer 不直接拼云端鉴权。
- BUC token / refresh / user identity 继续由 Electron main 管理。
- SSE 可以由 main 代理，也可以由 main 下发短期 session 后 renderer 订阅；第一版建议 main 代理，减少鉴权泄漏。
- 所有 Chat API 都以 `AuthState` 和 `CloudRuntimeState` 为前置条件。

第一批最小接口：

```text
chat:listConversations
chat:createConversation
chat:getConversationDetail
chat:getMessages
chat:sendMessageStream
chat:cancelStream
chat:confirmExecution
chat:getExecutionCot
chat:getExecutionStatus
chat:pollExecutionEvents
agent:getAgentById
agent:listAgents
assistant:getSuggestions
assistant:getInlineCompletion
```

第二批接口：

```text
chat:deleteConversation
chat:deleteMessage
chat:truncateAfter
chat:branchFromMessage
share:create
share:list
share:detail
share:continue
share:revoke
memory:getWorkingMemory
memory:initializeWorkingMemory
memory:getWikiStatus
memory:listWikiPages
memory:readWikiPage
billing:getConversationSummary
```

第三批接口：

```text
access:check
access:updateSpectatorConfig
access:createConversationAuth
access:updateConversationAuthMembers
roundtable:turn
automation:listSessions
automation:createSession
automation:openConversation
```

#### 4.3.1 开发者模式控制台

目标：让客户端调试可以在界面内快速切换生产、预发和自定义 Cloud Runtime 地址，并提供常用诊断页面跳转；同时保证所有真实请求仍从 Electron main 出口发出，继续走登录态鉴权，不回退到传工号或 renderer 自行拼鉴权。

当前已落成 UI 开发者模式控制台，界面设置会持久化到 Electron `userData`，并作为 Electron main 的 effective config 事实源；`ZEUS_ATLAS_DEVELOPER_MODE=pre` 仍作为没有 UI 持久化设置时的工程启动 fallback。

##### Scope / Trigger

- Trigger：开发者需要在同一个客户端会话中快速验证预发、生产、SSE 直连、登录态、Contract Probe 和特定诊断页面。
- Scope：只影响客户端请求目标和诊断入口，不改变云端权限模型、不绕过 BUC、不允许 renderer 持有 token。
- Non-goal：不把客户端做成后台管理台；不把开发者模式暴露为普通用户主流程；不通过 `workId` 模拟登录态。

##### UI 入口

入口落在客户端主界面的独立页面，不挂在账号 / 设置弹窗里，避免调试时被浮层尺寸和关闭行为干扰：

```text
左侧导航
  ├── 新会话
  ├── 搜索
  ├── 插件
  ├── 自动化
  └── 开发者模式
```

同时支持快捷键：

```text
Cmd/Ctrl + Shift + D -> 切换到开发者模式页面
```

面板分区：

| 区域 | 必须展示 / 操作 | 说明 |
|---|---|---|
| 环境开关 | 开发者模式 on/off、当前生效环境 | UI 展示必须来自 Electron main 的 effective config，而不是 renderer 本地状态 |
| Cloud Runtime | 生产 / 预发 / 自定义、HTTP API URL、SSE Stream URL | HTTP API 与 SSE 分开配置，避免 SSE 被 gateway 能力绑定 |
| 登录态 | BUC 环境、当前用户、工号、token 状态 | 默认保持 BUC prod；切 BUC daily 必须触发重新登录 |
| 快捷跳转 | 会话首页、当前会话详情、Runtime 状态、Contract Probe、登录状态、最近一次请求错误 | 仅做调试导航，不自动触发高风险写动作 |
| 最近请求 | method、path、origin、status、trace id、error message | 用于快速判断是 401、403、404、5xx 还是 SSE 路由问题 |

##### Main 侧签名

新增 main 侧开发者设置 store，持久化到 Electron `userData`，不进入 git。

```ts
type CloudMode = 'prod' | 'pre' | 'custom';
type BucEnvironment = 'prod' | 'daily';

interface DeveloperSettings {
  developerMode: boolean;
  cloudMode: CloudMode;
  gatewayUrl?: string;
  streamUrl?: string;
  bucEnvironment: BucEnvironment;
  updatedAt: string;
}

interface EffectiveCloudEndpointConfig {
  mode: CloudMode;
  developerMode: boolean;
  gatewayUrl?: string;
  streamUrl?: string;
  source: 'developer-settings' | 'environment';
}
```

IPC 合约：

```text
developer-settings:get -> DeveloperSettings + EffectiveCloudEndpointConfig
developer-settings:update(payload) -> DeveloperSettings + EffectiveCloudEndpointConfig
developer-settings:reset -> DeveloperSettings + EffectiveCloudEndpointConfig
developer-settings:diagnostics -> latest request diagnostics
developer-settings:quick-jump(destination) -> renderer navigation intent
```

`cloud-endpoint-config` 必须从“环境变量解析器”升级为“effective config resolver”：

```text
DeveloperSettings overlay
  -> env fallback
    -> default pre endpoint
      -> Cloud Chat / SSE / Runtime / Contract Probe
```

优先级：

1. `DeveloperSettings.developerMode=true` 且 `cloudMode=pre/custom`：使用 UI 持久化配置。
2. 没有 UI 设置：继续兼容 `ZEUS_ATLAS_DEVELOPER_MODE` 和 `ZEUS_ATLAS_PRE_CLOUD_*`。
3. 非开发者模式：使用 `ZEUS_ATLAS_CLOUD_GATEWAY_URL` 生产配置。

预发默认值：

```text
gatewayUrl = https://pre-cbu-xiaoer-service.alibaba-inc.com
streamUrl = https://pre-cbu-xiaoer-service.alibaba-inc.com
```

##### 切换行为

Cloud Runtime 环境切换后必须执行：

```text
Renderer developer panel
  -> developer-settings:update
    -> Electron main updates effective endpoint config
      -> cloud-runtime:get refresh
      -> clear cloud chat conversation/message/error state
      -> chat:conversations:list reload
      -> optional cloud-contracts:probe
```

如果只切 Cloud Runtime endpoint：

- 不需要退出 BUC。
- 不清除 token。
- 需要重新拉会话列表和 runtime 状态。

如果切换 `bucEnvironment`：

- 必须提示用户重新登录。
- Electron main 必须清除当前 BUC token。
- 重新登录前不允许继续请求 `/authenticated` 接口。

##### Validation & Error Matrix

| 输入 / 状态 | 处理 | UI 反馈 |
|---|---|---|
| `cloudMode=pre` 且 URL 为空 | 自动填预发默认值 | 显示“预发” |
| `cloudMode=custom` 且 URL 为空 | 拒绝保存 | 显示必填错误 |
| URL 非 `https://` 且不是 `http://127.0.0.1` / `http://localhost` | 拒绝保存 | 显示不安全地址 |
| HTTP API 与 SSE Stream 不同域 | 允许 | 面板明确显示双地址 |
| 切换后 list 接口 401 | 保持环境，提示重新登录或 token 无效 | 不回退老接口 |
| 切换后 list 接口 404 | 标记为路由 / 网关未部署问题 | 显示 origin + path |
| 切换 BUC 环境但未重新登录 | 阻止 authenticated 请求 | 显示“需要重新登录” |
| `No handler registered for developer-settings:*` | 判定为 renderer / Electron main 版本偏移 | 完全退出并重启客户端，确保 main 进程已加载新 IPC |

##### Good / Base / Bad Cases

Base case：

```text
开发者模式 off
  -> gateway = ZEUS_ATLAS_CLOUD_GATEWAY_URL
  -> BUC prod
  -> authenticated routes
```

Good case：

```text
开发者模式 on
  -> cloudMode = pre
  -> gateway = pre-cbu-xiaoer-service
  -> stream = pre-cbu-xiaoer-service
  -> BUC prod token 继续由 main 代持
  -> chat:conversations:list 重新拉取
```

Bad case：

```text
Renderer 只改本地状态显示“预发”
  -> Electron main 仍从 process.env 读生产 gateway
  -> /api/chat/conversations/list/authenticated 打到生产
  -> 生产未部署新路由时返回 404
```

##### Tests Required

- `cloud-endpoint-config`：覆盖 UI store 优先级、env fallback、pre 默认值、自定义 URL 校验、streamUrl 与 gatewayUrl 分离。
- `developer-settings-store`：覆盖持久化、reset、非法 URL 拒绝、BUC 环境切换标记需要重新登录。
- `cloud-chat-service`：覆盖同一次进程内切换 endpoint 后，新请求使用新的 effective config。
- `cloud-runtime` / `cloud-contract-probe`：覆盖返回 `mode`、`developerMode`、`source` 和双 endpoint。
- Renderer：覆盖切换后清空会话列表错误态并触发 runtime / conversations reload。

##### Wrong vs Correct

Wrong：

```text
Developer toggle lives only in renderer
  -> UI says pre
  -> Electron main still uses production env
  -> authenticated route 404 is misdiagnosed as data empty
```

Correct：

```text
Developer toggle updates Electron main developer settings
  -> main resolves effective endpoint
  -> all IPC-backed Chat / SSE / Probe share the same endpoint
  -> renderer only displays returned effective config
```

Wrong：

```text
Switch to daily BUC but reuse prod token
```

Correct：

```text
Switching BUC environment clears token and requires login again
```

### 4.4 Renderer Runtime

目标位置：

```text
apps/desktop/renderer/src/chat/
```

建议结构：

```text
chat/
  api/
    chatClient.ts
  state/
    useConversationRuntime.ts
    useStreamRuntime.ts
    useComposerRuntime.ts
    useChannelRuntime.ts
  components/
    ChatShell.tsx
    ConversationSidebar.tsx
    Timeline.tsx
    MessageBubble.tsx
    ThinkingCard.tsx
    ToolCallCard.tsx
    HumanConfirmationCard.tsx
    EvidenceCard.tsx
    Composer.tsx
    RightPanel.tsx
```

Renderer 只负责：

- 用户交互。
- timeline 渲染。
- composer draft。
- side panel 展开。
- 调用 `clientApi`。

Renderer 不负责：

- token 存储。
- 云端鉴权。
- 权限事实源。
- 本地工具执行事实源。

### 4.5 Codex-like UI 形态

客户端主界面应从当前 bootstrap 状态页升级为：

```text
App Shell
  ├── Sidebar
  │   ├── New task
  │   ├── Search
  │   ├── Channels
  │   ├── Pinned
  │   └── Projects
  ├── Thread Header
  │   ├── conversation title
  │   ├── Agent
  │   ├── Cloud / Hybrid state
  │   └── diagnostics
  ├── Timeline
  │   ├── user message
  │   ├── assistant message
  │   ├── thinking card
  │   ├── tool call card
  │   ├── human confirmation card
  │   ├── evidence card
  │   └── artifact card
  ├── Composer
  │   ├── context chips
  │   ├── quote chips
  │   ├── image attachments
  │   ├── local access level
  │   ├── stop / send
  │   └── Agent selector
  └── Right Panel
      ├── Context
      ├── Capabilities
      ├── Permission
      ├── Evidence
      └── Diagnostics
```

注意：

- 不做后台三栏管理台。
- 能力、权限、MCP、Plugin 不作为首屏常驻管理页。
- Tool call、Review、Evidence 必须是 timeline 事件。
- 右侧面板按需展开，不抢主任务线程。

---

## 五、端云边界

Web Chat 主要是云端能力展示；客户端多了本地能力，但不能改变认知边界。

正确链路：

```text
User message
  -> Cloud Chat Gateway
    -> Cloud CEO Agent Runtime
      -> cloud tool / skill selection
        -> optional client_tool_call
          -> local permission
            -> local execution
              -> Evidence
                -> Cloud Runtime
                  -> assistant response
```

错误链路：

```text
User message
  -> local agent
    -> local tools
      -> cloud only receives final text
```

客户端补齐 Chat 能力后，`client_tool_call` 只是 timeline 的一种 tool call event，不是新的大脑。

---

## 六、接口接入范围

### 6.1 P0 必接

P0 目标是能完成真实单人 Agent 会话，不再停留在空状态。

| 能力 | 接口 |
|---|---|
| Agent 信息 | `api/xiaoerAiApi/agents/getAgentById`, `api/xiaoerAiApi/agents/getAgents` |
| 会话 | `/api/chat/conversations/create`, `/list`, `/detail` |
| 消息 | `/api/chat/messages/list`, `/stream`, `/cancel` |
| 执行 | `/api/react-agent/execution/status`, `/cot`, `/poll`, `/confirm` |
| 输入辅助 | `/api/chat/assistant/suggestions`, `/inline-completion` |

P0 暂不做：

- 分享管理。
- Memory Wiki。
- Billing 详情。
- DingTalk / RoundTable / Automation channel 完整 UI。
- 本地任意工具执行。

### 6.2 P1 必接

P1 目标是 Web 常用能力等价。

| 能力 | 接口 |
|---|---|
| 会话操作 | `/delete`, `/branch-from-message` |
| 消息操作 | `/delete`, `/truncate-after` |
| Working Memory | `/working-memory`, `/working-memory/initialize` |
| Billing | `/billing/summary` |
| Thinking UI state | `/thinking/detail`, `/thinking/ui-state/update` |
| Share | `/api/chat/share/create`, `/detail`, `/continue`, `/revoke`, `/list` |

### 6.3 P2 必接

P2 目标是多 Channel 和治理等价。

| 能力 | 接口 |
|---|---|
| Access | `/api/chat/access/*` |
| Memory Wiki | `/memory/wiki/*`, `/memory/compile/*` |
| Automation | `/api/agent-cron/sessions/*` |
| RoundTable | roundtable turn stream / inject / abort |
| Agent Evolution Patch | `/api/agent-memory/patch/updateStatus` |

### 6.4 P3 客户端增量

P3 才进入本地能力增强：

- local capability manifest publish。
- Runtime Projection。
- client_tool_call session。
- local permission review。
- local execution adapter。
- Evidence redaction。
- local audit ledger。
- MCP / Plugin lifecycle。

### 6.5 0.0.1 当前接入审计

截至 `dev/0.0.1` 当前实现，客户端已经不再是 mock shell，而是按 Codex 风格把云端运行面收敛到任务线程和上下文抽屉里。

| 分层 | 当前状态 | 证据 |
|---|---|---|
| 登录 / 会话身份 | 已接真实 BUC OAuth2.1 PKCE、本地回调、token 安全存储 | `apps/desktop/electron/main/auth-service.mjs` |
| Cloud Chat Gateway | 已接真实 Cloud Gateway，并统一从 Electron main 出口访问云端 | `apps/desktop/electron/main/cloud-chat-service.mjs` |
| Conversation / Message | 已接 create/list/detail/delete/archive-ish delete、branch、message list/detail/context/last/stream/cancel/delete/truncate | `apps/desktop/renderer/src/chat/api/chatClient.ts` |
| Chat Kernel | 已有 SSE parser、chat reducer、thinking reducer、confirmation reducer、message action gates | `packages/chat-kernel/src/` |
| Thread UI | 已有真实 conversation sidebar、message timeline、rich message、action bar、composer | `apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx` |
| Thinking / Tool / Confirmation | 已显示 thinking process、tool timeline、human confirmation、execution status/COT/detail/result/source-trace/list/shadow/cancel | `packages/protocol/src/execution.ts` |
| Share / Memory / Billing | 已接 Share create/list/detail/continue/revoke、Working Memory、Memory Wiki、Memory Compile、Billing summary/agent daily | `packages/protocol/src/share.ts`, `packages/protocol/src/memory.ts`, `packages/protocol/src/billing.ts` |
| Channel | 已有 web、DingTalk direct/group、RoundTable、Automation、Share filter 和 channel runtime | `apps/desktop/renderer/src/chat/state/channelRuntime.ts` |
| Governance | 已接 Access、AuthBase、Automation sessions/runs、RoundTable inject/abort/transcript、Agent Evolution Patch status | `packages/protocol/src/governance.ts` |
| Observability | 已接 message/conversation trace、tool call detail/list/statistics/recent/message、per-message inspector | `packages/protocol/src/observability.ts` |
| Statistics | 已接 overview、trends、tools ranking、users ranking、realtime、云端 `/api/chat/statistics/export` 导出桥接、本地导出快照兜底 | `packages/protocol/src/statistics.ts` |
| Agent Studio | 已接 OpenClaw current scene/events、agent channels、channel sessions、显式 enter | `packages/protocol/src/studio.ts` |
| OpenClaw Governance | 已接只读 catalog、identity / role / capability / service ref、memory workspace/snapshot/training/candidate、model/credential/eval、certification/release、on-duty/schedule/alert、remediation、human takeover、upgrade job、effective config | `packages/protocol/src/openclaw-governance.ts` |
| OpenClaw Write Gate | 已列真实 Governance / Studio POST 写动作、风险、权限 gate、审计字段和 Evidence 要求；客户端当前只读展示，不暴露执行按钮 | `packages/protocol/src/openclaw-write-policy.ts` |
| Agent Memory Review | 已接当前会话 Patch 线索、memory candidates、simulation evals、training runs、Zeus backflow、related Shadow execution 只读审核面，并显式保留“云端为准，个人为辅”边界 | `apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx` |
| Agent Memory Write Gate | 已列真实 pre/local-only migration / simulation POST 写动作、环境限制、确认要求、审计字段和 Evidence 要求；客户端当前只读展示，不触发执行 | `packages/protocol/src/agent-memory-write-policy.ts` |
| Channel Evidence | 已从真实 conversation/message 元数据提取 DingTalk、RoundTable、企业 callback、source metadata 只读证据 | `apps/desktop/renderer/src/chat/components/CloudChatSurface.tsx` |
| 本地能力代理 | 已接 Runtime Projection 发布、client_tool_call outbound polling、local permission、local.health、Evidence 返回 | `packages/protocol/src/client-tool.ts`, `packages/protocol/src/runtime-projection.ts` |
| 云端合约诊断 | 命令行 `prod-e2e:probe-contract` 和桌面端 Local Capability Proxy 面板共用同一套探针，展示 poll/result/projection、Statistics export、OpenClaw Governance / Studio 的生产路由状态 | `apps/desktop/electron/main/cloud-contract-probe.mjs` |

运行面约束：

- 首屏和主任务线程只自动加载真实会话、消息、Working Memory、Memory Wiki、Billing、Share 等核心上下文。
- Dispatch、Statistics、Observability、Conversation Governance、OpenClaw Studio、OpenClaw Governance、Agent Memory Review 等控制面能力保持完整，但折叠状态下不主动请求云端；用户展开或点击刷新后才加载。
- 这样客户端仍保持云端能力等价，同时避免历史会话切换时把 OpenClaw / Governance / Statistics 等非主链路接口打满，符合“任务线程优先，能力抽屉按需”的 Codex-like 形态。

仍未视为完成的缺口：

- OpenClaw Governance / Studio 的 approve、promote、run、acknowledge、apply、takeover、register、heartbeat、sync、task-order、remediation、evidence 等真实写动作已完成客户端 gate 矩阵，但尚未接成可执行按钮；需要云端策略、Effective Config、操作者确认、审计原因、Evidence 回传闭环齐备后再开放。
- DingTalk external roundtable 和部分企业通道外部 callback 已做只读元数据 / callback evidence 可视化；外部创建、插话、回调处理等写动作仍不暴露为普通客户端按钮。
- Chat Statistics 客户端已优先调用云端 `/api/chat/statistics/export`；若云端仍返回空导出结果或接口不可用，则降级为本地 JSON/CSV 快照，并通过 Electron save dialog 收口本地写盘副作用。
- Agent Memory migration / simulation 的真实执行接口已完成客户端 gate 矩阵；仍不暴露执行按钮，不会把个人经验自动进入云端 Patch。
- 还没有对真实云端账号做端到端人工验收记录；当前自动门禁只能证明类型、构建和 reducer 行为。

---

## 七、数据流

### 7.1 打开客户端

```text
Renderer
  -> bootstrap:get
    -> Electron main
      -> AuthState
      -> CloudRuntimeState
      -> ClientSessionState
      -> CapabilityManifest[]
      -> ProjectIndex
```

如果未登录：

```text
show auth empty state
```

如果已登录但 cloud gateway 未配置：

```text
show cloud runtime not configured
```

如果已登录且 cloud gateway 可用：

```text
load conversations
```

### 7.2 发送消息

```text
Composer submit
  -> ensure conversation
    -> append local user message
      -> append assistant placeholder
        -> clientApi.chat.stream
          -> Electron main stream proxy
            -> Cloud Runtime SSE
              -> Chat Kernel reducer
                -> Timeline view model
```

### 7.3 断线恢复

```text
stream disconnect
  -> executionUuid exists
    -> checkExecutionStatus
      -> getExecutionCot
        -> pollExecutionEvents
          -> rebuild thinking process
            -> resume timeline
```

### 7.4 本地 Tool Call

```text
Cloud event: client_tool_call
  -> Timeline ToolCallCard
    -> Permission review
      -> PermissionGrant
        -> Rust Local Capability Runtime
          -> adapter execution
            -> Evidence
              -> return to cloud
                -> Timeline EvidenceCard
```

---

## 八、文件落地计划

### 8.1 第一批文件

```text
packages/protocol/src/chat.ts
packages/protocol/src/execution.ts
packages/protocol/src/channel.ts
packages/chat-kernel/src/stream-parser.ts
packages/chat-kernel/src/chat-reducer.ts
packages/chat-kernel/src/thinking-reducer.ts
packages/chat-kernel/src/message-actions.ts
apps/desktop/electron/main/cloud-chat-service.mjs
apps/desktop/electron/main/chat-stream-service.mjs
apps/desktop/renderer/src/chat/api/chatClient.ts
apps/desktop/renderer/src/chat/state/useConversationRuntime.ts
apps/desktop/renderer/src/chat/components/ChatShell.tsx
```

### 8.2 第二批文件

```text
apps/desktop/renderer/src/chat/components/Timeline.tsx
apps/desktop/renderer/src/chat/components/MessageBubble.tsx
apps/desktop/renderer/src/chat/components/ThinkingCard.tsx
apps/desktop/renderer/src/chat/components/ToolCallCard.tsx
apps/desktop/renderer/src/chat/components/HumanConfirmationCard.tsx
apps/desktop/renderer/src/chat/components/Composer.tsx
apps/desktop/renderer/src/chat/components/ConversationSidebar.tsx
packages/i18n/src/chat.ts
```

### 8.3 第三批文件

```text
packages/protocol/src/share.ts
packages/protocol/src/memory.ts
apps/desktop/renderer/src/chat/components/RightPanel.tsx
apps/desktop/renderer/src/chat/components/WorkingMemoryPanel.tsx
apps/desktop/renderer/src/chat/components/SharePanel.tsx
apps/desktop/renderer/src/chat/components/BillingBar.tsx
```

---

## 九、里程碑

### Phase A：Chat 契约补齐

验收：

- 协议层有 Web Chat 等价核心类型。
- `chat-kernel` 有 stream reducer 和 thinking reducer。
- 单测覆盖 message、thinking、tool event、confirmation、message actions。
- UI 仍可不变。

### Phase B：真实云端单人会话

验收：

- BUC 登录后可以拉 Agent。
- 可以创建真实 conversation。
- 可以发送真实 message stream。
- 可以显示 assistant stream。
- 可以停止生成。
- 可以加载历史消息。
- 没有 mock conversation / mock message。

### Phase C：执行过程等价

验收：

- stream 中的 tool / thinking / step 事件进入 Timeline。
- thinking card 支持展开/折叠。
- human confirmation 可以确认并恢复。
- 断线后能用 status / cot / poll 补齐。

### Phase D：Web 常用能力等价

验收：

- 会话列表、切换、删除。
- 消息复制、重跑、删除、分支。
- image / quote / suggestion / inline completion。
- working memory。
- share。
- billing summary。

### Phase E：客户端本地能力增量

验收：

- 云端能发起 `client_tool_call`。
- 客户端能展示本地 tool call card。
- 本地权限 Review 能阻塞执行。
- Rust core 执行本地 adapter。
- Evidence 回到云端并展示在线程里。

---

## 十、验收红线

以下情况不算完成：

- 只接入 `/api/chat/messages/stream`，但没有 conversation runtime。
- 只显示 assistant 文本，不显示 thinking / tool / confirmation。
- Renderer 直接保存 token。
- 用 mock conversation 填充 UI。
- 把本地工具调用绕过 Manifest / Projection / Permission / Evidence。
- 把 Web 的 Channel / Share / Memory 模型删掉，等以后再想。
- 做成后台管理台，而不是任务线程产品。

第一版可以小，但必须是真的。

```text
真实登录
真实会话
真实消息
真实流式
真实执行状态
真实权限边界
```

---

## 十一、当前下一步

当前仓库已经完成 Phase A/B/C/D/E 的主体纵切，下一步不再是“先把 Chat 跑起来”，而是收敛剩余云端能力的接入边界。

优先级建议：

1. **OpenClaw Governance 写动作执行闭环**：approve、promote、run、acknowledge、apply、takeover 已有客户端 gate 矩阵，下一步是对接云端策略校验、操作者确认、审计原因和 Evidence 回传后再开放执行。
2. **OpenClaw Studio 写接口执行闭环**：register、heartbeat、sync、task-order、remediation、evidence 上报已有客户端 gate 矩阵，下一步是绑定本地 runtime 身份、幂等 key、Evidence redaction 和云端审计。
3. **Agent Memory migration / shadow evaluation 执行闭环**：审核面和 gate 矩阵已只读接入；后续若要触发 migration / simulation，必须保持“云端为准，个人为辅”，并补齐预发/本地环境校验、二次确认、LLM 成本确认、审计和 Evidence 回传。
4. **真实账号人工验收**：用 BUC prod + Cloud Gateway prod 记录一次端到端验收，覆盖登录、会话、stream、tool timeline、dispatch review、local proxy polling、Evidence return。
