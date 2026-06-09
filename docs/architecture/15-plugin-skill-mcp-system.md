# Plugin / Skill / MCP 能力体系设计

日期：2026-05-20
分支：`dev/0.0.1`
状态：设计草案

本文定义 Peer Agent 的能力扩展体系。这里刻意区分三个经常被混在一起的对象：

- `Skill`：云端编排对象。
- `Plugin`：本地能力打包和分发对象。
- `MCP`：工具传输协议，需要区分云端 MCP 和本地 MCP。
- `Local Shell`：客户端内置的本地命令执行 Provider，不属于 Plugin，也不是 MCP。

核心主链路不变：

```text
Capability Provider
  -> Manifest
    -> Runtime Projection
      -> Tool Call
        -> PermissionGrant
          -> Evidence
```

任何 `Skill`、`Plugin`、`MCP Server` 都不能绕过这条链路。

## 当前对齐：先以个人 Workspace 为基准

`Runtime Projection` 是工程协议名；产品层不要把它展示成“发布 Projection”。第一阶段也不能把它理解成“某台个人电脑的临时快照 ID”。当前应按个人 Workspace 对齐：

- `projectionId` 表示个人 Workspace 的统一工具面，后续可同构升级为业务 Workspace 的统一工具面。
- Renderer / chat message 不携带 `projectionId`；它不是用户消息上下文。
- 本地 Gateway Session 负责本地执行通道；它决定 `client_tool_call` 发往哪一个已连接客户端。
- 本地 MCP、Plugin、Shell 永远在本地执行；Projection 只表达“这个 Workspace 工具面允许 Agent 看到哪些能力”，不表达“云端拥有这些本地工具”。
- 后续业务 Workspace 上线时，把 scope 从 `personal:{workId}` 切到 `workspace:{workspaceId}`，而不是改掉本地执行协议。
- 用户可见文案统一叫“本地工具面”或“接入本地工具”；`projectionId` 只出现在日志、调试和协议字段。

当前最小分层：

```text
Cloud Built-in Tools
  固定云端能力，不可由客户端卸载

Personal Workspace Projection
  个人工具面：云端策略 + 个人安装/挂载 + 本地 Gateway 可用能力裁剪后的 Manifest

Runtime Gateway Session
  当前客户端的 outbound 执行通道，只负责 client_tool_call / ack / result
```

## 一、产品边界

Peer Agent 不是插件市场壳，也不是本地 Agent Runtime。它是云端认知 Runtime 的客户端 Harness。

云端负责：

- 认知。
- 规划。
- `Skill` 选择。
- 工具选择。
- 组织和业务策略。
- 执行账本。

客户端负责：

- 本地能力发现。
- 本地安装和启用。
- 本地权限确认。
- 本地执行。
- 本地 Evidence 采集和脱敏。
- 把 Evidence 回传云端。

云端不能直接访问本地端口。任何本地执行都必须通过客户端主动建立的 Gateway WS / outbound runtime session 接收 `client_tool_call`；`poll` 只能作为断线恢复或兼容兜底。

## 二、对象模型

### 2.1 Skill

`Skill` 是云端编排对象。

它描述云端 Agent 如何解决某一类工作：

- 意图模式。
- 规划步骤。
- 所需能力。
- 能力选择规则。
- 治理要求。
- 人类确认点。
- 预期产物。
- Evidence 要求。

`Skill` 不打包本地可执行代码。

`Skill` 不直接暴露本地工具。

`Skill` 不能直接连接用户机器。

示例：

```text
Skill: summarize_dingtalk_conversation_to_todos
  needs:
    - read selected conversation messages
    - classify owners and deadlines
    - create draft todos
  may use:
    - cloud chat read tool
    - local calendar plugin if projected
    - local notes MCP if projected
```

### 2.2 Plugin

`Plugin` 是本地能力包。

它可以包含：

- 一个或多个 capability manifest。
- 本地 adapter。
- 本地 MCP Server 配置。
- 运行权限声明。
- 安装元数据。
- 签名和发布方元数据。
- 设置页或诊断页的 UI contribution 元数据。

`Plugin` 不拥有认知。

`Plugin` 不决定 Agent 什么时候使用它。

`Plugin` 不是权限事实源。它只声明“我能做什么”；是否能运行由云端 policy、Runtime Projection、本地用户授权和 adapter 执行时约束共同决定。

示例：

```text
Plugin: dingtalk-workbench
  capabilities:
    - dingtalk.message.read_selected
    - dingtalk.todo.create_draft
  local adapters:
    - native Electron bridge
    - local MCP stdio server
```

### 2.3 MCP

`MCP` 是工具和资源的传输协议。

它不是产品对象，不是治理模型，也不是权限模型。

Peer Agent 支持两类 MCP：

| MCP 类型 | 运行位置 | 使用方 | 主要风险 |
|---|---|---|---|
| 云端 MCP | 云端 Runtime 或可信服务环境 | Cloud Agent Runtime | 云端 policy、租户数据、共享凭证 |
| 本地 MCP | 用户设备，通过 Plugin / CU Proxy 承载 | Local Capability Runtime | 私有数据、本地文件、桌面自动化、用户授权 |

两类 MCP 都可以产出 `CapabilityManifest`。两类 MCP 都必须先进入 `RuntimeProjection`，Agent 才能选择使用。

## 三、云端 MCP

云端 MCP 用于适合在云端执行的能力。

典型例子：

- 组织知识库检索。
- 业务数据读取 API。
- 云端产物生成。
- 云端工作流系统。
- 组织统一授权的 SaaS 集成。

云端 MCP 的特征：

- 由云端平台注册和治理。
- 在 capability projection 前执行租户、角色和业务策略。
- 不访问用户本机。
- Evidence 直接写入云端执行账本。
- 可被云端 `Skill` 选择，不依赖本地 Runtime Projection。

云端 MCP 仍然必须生成 Manifest：

```text
Cloud MCP Server
  -> Cloud Capability Provider
    -> CapabilityManifest(source = "mcp", locality = "cloud")
      -> Cloud Runtime Projection
        -> Cloud Tool Call
          -> Cloud Evidence
```

云端 MCP 不能假装拥有本地私有上下文。如果任务需要用户本地文件、本地 app 状态、本地凭证、本地浏览器会话，那就不是云端 MCP 的工作。

## 四、本地 MCP

本地 MCP 用于必须在用户设备上执行的能力。

典型例子：

- 本地文件系统。
- 本地 app 自动化。
- 私有浏览器会话。
- 桌面剪贴板。
- 用户本地数据库。
- 本地开发工具。
- 只能从用户机器访问的企业客户端。

本地 MCP 的特征：

- 通过 `Plugin` 或本地开发者注册安装。
- 由 CU Proxy / Local Capability Runtime 承载。
- 云端永远不能通过 localhost 直接调用。
- 只能通过 Runtime Projection 暴露给云端。
- 执行前必须本地权限确认，除非已有有效 grant 覆盖当前 scope。
- 通过 `ClientToolResult` 返回脱敏 Evidence。

本地 MCP 链路：

```text
Local MCP Server
  -> Plugin or local provider registration
    -> Local Capability Provider
      -> CapabilityManifest(source = "mcp", locality = "local")
        -> Runtime Projection
          -> Gateway WS client_tool_call
            -> Local PermissionGrant
              -> Local MCP execution
                -> ClientToolResult + Evidence
                  -> Cloud ledger
```

这个设计让本地 MCP 可用，但不会变成隐藏的远程控制通道。

## 五、本地 Shell / Bash Provider

本地 Bash 指令调度是客户端最核心、最高风险的内置能力。它必须作为一等 `Capability Provider` 建模，不能被混进普通 Plugin，也不能被当作 Local MCP 的一个普通 tool。

参考 `claude-code` 的 `BashTool` 设计，本地 Shell 能力至少要拆成四层：

```text
Local Shell Provider
  -> command schema
    -> command safety / permission classification
      -> shell process execution
        -> task output persistence
          -> Evidence
```

`claude-code` 的本地命令实现可以拆成以下可迁移设计点：

| `claude-code` 模块 | 迁移到宙斯客户端的设计 |
|---|---|
| `BashTool.inputSchema` | `LocalShellExecInput`，只暴露 command、cwd、timeout、description、background 等必要字段 |
| `bashPermissions.ts` | `ShellPermissionClassifier`，负责 command AST / wrapper / redirect / env prefix / heredoc 风险分类 |
| `runShellCommand` / `Shell.ts` | `ShellProcessRunner`，负责 spawn、timeout、abort、sandbox、cwd 固定 |
| `LocalShellTask` | `ShellBackgroundTask`，负责后台任务、停止、完成通知、交互 prompt 卡死检测 |
| output persistence | `ShellOutputArtifact`，完整 stdout / stderr 文件化，云端只拿 preview 和 artifact ref |
| result UI | `ShellCommandEvent`，在任务线程里展示 description、状态、exit code、输出摘要和可展开明细 |

当前实现落点：

| 模块 | 代码路径 |
|---|---|
| Capability Provider Registry | `apps/desktop/electron/main/runtime-gateway/capability-provider-registry.mjs` |
| PermissionReview | `apps/desktop/electron/main/runtime-gateway/permission-review.mjs` |
| local health provider | `apps/desktop/electron/main/runtime-gateway/local-health-provider.mjs` |
| command safety / permission classification | `apps/desktop/electron/main/runtime-gateway/shell-classifier.mjs` |
| Shell PermissionRule | `apps/desktop/electron/main/runtime-gateway/shell-permission-rules.mjs` |
| shell process execution / stop | `apps/desktop/electron/main/runtime-gateway/shell-task-manager.mjs` |
| output artifact | `apps/desktop/electron/main/runtime-gateway/shell-artifacts.mjs` |
| output redaction | `apps/desktop/electron/main/runtime-gateway/shell-redaction.mjs` |
| Local Shell Provider orchestration | `apps/desktop/electron/main/runtime-gateway/local-shell-provider.mjs` |

`LocalToolHost` 只负责把 `client_tool_call` 交给 `CapabilityProviderRegistry`。后续
MCP、Plugin、FileRead、FileWrite 都必须以 Provider adapter 形式注册，不能在
`LocalToolHost` 里增加新的 capabilityId 分支。

后台 Bash 任务不能只返回“已启动”。`Local Shell Provider` 必须在任务结束时通过
Runtime Gateway follow-up result 回传最终状态和 Evidence，保证云端 Agent Runtime 的执行账本闭环。

Shell PermissionRule 的写入必须经过 `PermissionReview`。`allow` rule 不能使用 wildcard，
必须绑定 workspace 内 cwd，并声明不超过 `L4_privileged` 的 `maxRiskLevel`。原始
rule store 只负责持久化和匹配，不能直接暴露给 renderer。

### 5.1 能力定义

第一阶段内置一个 capability：

```text
local.shell.exec
local.shell.stop
```

输入：

```ts
interface LocalShellExecInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  description?: string;
  runInBackground?: boolean;
}
```

输出：

```ts
interface LocalShellExecResult {
  status: 'success' | 'failed' | 'cancelled' | 'running';
  exitCode: number | null;
  stdoutPreview: string | null;
  stderrPreview: string | null;
  interrupted: boolean;
  timedOut: boolean;
  promptDetected: boolean;
  outputArtifactRef?: string | null;
  backgroundTaskId?: string | null;
}
```

`stdoutPreview` / `stderrPreview` 只能是截断预览。完整输出必须落本地 artifact，再通过 Evidence 引用，不允许大块原始输出直接塞回云端。

### 5.2 Permission 分类

Shell 不是“允许 / 不允许”这么粗的能力，至少要区分：

| 类型 | 行为 |
|---|---|
| read-only | 可以按 policy 自动执行或轻量确认 |
| write | 必须用户确认，记录写入路径 |
| network | 必须确认，记录目标摘要 |
| process-control | 必须确认，后台任务要可停止 |
| destructive | 默认 ask / deny，不能被宽泛规则静默放行 |
| unknown / too-complex | fail closed，进入 ask |

命令权限不能只做字符串前缀匹配。需要解析 compound command、pipeline、redirect、env var prefix、wrapper command 和 heredoc。解析不了时默认 `ask`。

### 5.3 Shell PermissionRule

本地需要 Shell 专属 permission rule：

```ts
type ShellPermissionBehavior = 'allow' | 'ask' | 'deny';

interface ShellPermissionRule {
  behavior: ShellPermissionBehavior;
  match:
    | { type: 'exact'; command: string }
    | { type: 'prefix'; prefix: string }
    | { type: 'wildcard'; pattern: string };
  scope: {
    cwd?: string;
    maxRiskLevel?: CapabilityRiskLevel;
  };
  expiresAt?: string;
}
```

规则保存位置：

```text
<userData>/permissions/shell-rules.json
```

`allow` 规则不能覆盖 `deny` 规则。`deny` / `ask` 匹配时要比 `allow` 更保守，例如对 env var 前缀和 wrapper command 做更激进的归一化，避免 `FOO=bar rm ...` 绕过规则。

默认策略：

- read-only 自动允许。
- destructive 默认拒绝。
- write / network / process-control / unknown 默认 ask；没有本地授权 UI 或匹配规则时拒绝。
- `PEER_AGENT_SHELL_TRUST_WORKSPACE=1` 只用于开发联调，可临时允许 workspace 范围内非 destructive 命令，不能作为生产默认。

### 5.4 执行约束

Shell 执行必须具备：

- 固定 cwd，默认当前 workspace。
- timeout。
- abort / stop。
- background task id。
- stdout / stderr 文件化持久化。
- 最大输出大小限制。
- 输出预览截断。
- 非交互模式提示；发现命令卡在 prompt 时提示用户重跑带 piped input 或 non-interactive flag。
- sandbox 支持；无法 sandbox 时风险等级上升。

### 5.5 与个人 Workspace Runtime Projection 的关系

云端不能拿到“任意 Bash”能力。个人 Workspace Projection 只能暴露被裁剪后的 Shell capability；真正执行仍由当前 Gateway Session 路由到客户端：

```ts
interface LocalShellProjectionPolicy {
  capabilityId: 'local.shell.exec';
  cwdScope: 'workspace' | 'selected_directories';
  defaultBehavior: 'ask' | 'deny';
  readOnlyAutoAllow: boolean;
  backgroundTasks: boolean;
  sandboxAvailable: boolean;
}
```

云端发起 `client_tool_call` 时必须携带：

- command。
- cwd。
- description。
- timeout。
- expected risk。
- tool call id。

客户端最终以本地判断为准。即使云端认为可以执行，本地 Shell Provider 仍然可以 deny 或要求用户确认。

### 5.6 第一阶段最小闭环

第一阶段不要先做复杂 Plugin / MCP marketplace。先用 `local.shell.exec` 打通真实本地调度：

```text
User asks
  -> Cloud Agent decides it needs shell
    -> client_tool_call(local.shell.exec)
      -> local permission classification
        -> user confirm if needed
          -> spawn shell
            -> return result + Evidence
              -> Cloud Agent continues answer
```

验收时至少覆盖：

- `pwd` / `ls` read-only。
- `git status` read-only。
- `npm test` / `pnpm test` long-running foreground / background，需要显式 rule 或本地授权。
- `rm` / `git reset` destructive 默认 deny，不能被宽泛 allow 静默放行。
- output too large persisted to artifact。
- stop background task。

## 六、Capability Provider 层

`Capability Provider` 层负责把 native capability、本地 Plugin、云端 MCP、本地 MCP 统一归一成 Manifest。

Provider 类型：

| Provider | Locality | 产出 | 示例 |
|---|---|---|---|
| Native provider | local | 内置 manifest | `local.health` |
| Local Shell provider | local | 内置 shell manifest | `local.shell.exec` |
| Plugin provider | local | plugin manifest | DingTalk helper plugin |
| Local MCP provider | local | MCP tool manifest | local filesystem MCP |
| Cloud MCP provider | cloud | MCP tool manifest | organization search MCP |
| Cloud native provider | cloud | cloud tool manifest | chat statistics export |

Provider 负责：

- 发现能力。
- 归一化 schema。
- 标注 risk level 和 data level。
- 生成本地化说明。
- 附加 Evidence policy。
- 上报 health。
- 在 adapter 执行时强制约束。

Provider 不负责：

- 判断某个 `Skill` 是否应该使用能力。
- 授予用户权限。
- 绕过云端组织 policy。
- 直接写入云端认知 memory。

## 七、云端对接 API

插件体系的云端 API 分成两类：

- 能力目录 API：告诉客户端云端有哪些 `Skill`、云端 MCP、组织允许的 Plugin。
- 运行态 API：让客户端接入个人 Workspace 工具面、通过 Gateway WS 接收 `client_tool_call`、回传 Evidence。

第一阶段不要把插件安装、MCP 调用和 Skill 编排混到一个接口里。目录是目录，运行是运行。

### 7.1 最小必需 API

| API | 方向 | 目的 | 阶段 |
|---|---|---|---|
| `GET /api/client/capability/bootstrap` | Client -> Cloud | 拉取云端能力目录、组织策略、推荐插件和最低客户端版本 | P0 |
| `POST /api/client/runtime/projection` | Client -> Cloud | 接入个人 Workspace 工具面 | 已有主链路，P0 |
| `GET /api/client/runtime/ws` | Client -> Cloud | 建立 Gateway WS / outbound runtime session，承载 `client_tool_call`、ack 和 resume | 新主链路，P0 |
| `POST /api/client/runtime/tasks/poll` | Client -> Cloud | 断线恢复或旧客户端兼容时兜底拉取本地 `client_tool_call` | 兼容兜底 |
| `POST /api/chat/client-tool/result` | Client -> Cloud | 回传本地执行结果、PermissionGrant 和 Evidence | 已有主链路，P0 |

`POST /api/client/runtime/projection`、`GET /api/client/runtime/ws`、`POST /api/chat/client-tool/result` 是本地执行主链路。`projection` 负责个人 Workspace 工具面治理，`ws` 负责当前客户端执行通道；`POST /api/client/runtime/tasks/poll` 只保留为断线恢复或旧客户端兼容兜底。插件体系不能另起新的本地执行 API。

当前客户端代码映射：

| 客户端入口 | Cloud service method | Cloud API |
|---|---|---|
| `runtime-projection:publish` | `publishRuntimeProjection` | `POST /api/client/runtime/projection` |
| `runtime-gateway:status` | `createRuntimeGatewayClient().getState()` | 本地状态查询 |
| Runtime Gateway Client | `createRuntimeGatewayClient().start()` | `GET /api/client/runtime/ws` |
| `chat:client-tool:poll` | `pollClientToolCalls` | `POST /api/client/runtime/tasks/poll`，仅兜底 |
| `chat:client-tool:result` | `reportClientToolResult` | `POST /api/chat/client-tool/result` |

新增的 `GET /api/client/capability/bootstrap` 应该补一个独立方法，例如 `getCapabilityBootstrap(params)`，不要塞进 projection publish，也不要在聊天发送链路里隐式拉取。

### 7.2 Capability Bootstrap

`GET /api/client/capability/bootstrap`

用途：

- 拉取云端 `Skill` catalog。
- 拉取云端 MCP capability catalog。
- 拉取组织允许安装或推荐的 Plugin catalog。
- 拉取 organization capability policy。
- 拉取最低客户端版本和兼容性提示。

请求参数：

```text
GET /api/client/capability/bootstrap?clientVersion=0.0.1&platform=darwin-arm64&locale=zh-CN
```

响应结构：

```ts
interface CapabilityBootstrapResult {
  serverTime: string;
  minimumClientVersion?: string;
  policy: OrganizationCapabilityPolicy;
  skills: SkillCatalogItem[];
  cloudMcpServers: CloudMcpServerSummary[];
  cloudCapabilities: CapabilityManifestV2[];
  plugins: PluginCatalogItem[];
}

interface OrganizationCapabilityPolicy {
  tenantId: string;
  allowLocalMcp: boolean;
  allowDeveloperPlugins: boolean;
  maxRiskLevel: CapabilityRiskLevel;
  maxDataLevel: DataLevel;
  blockedCapabilityIds: string[];
  allowedPluginIds: string[];
}
```

设计要求：

- 该接口只返回目录和策略，不返回本地执行任务。
- 云端 MCP 可以出现在 `cloudCapabilities` 中。
- 本地 Plugin 只能以 catalog metadata 返回，不能假设用户已经安装。
- 返回的 capability 也必须是 Manifest 形态，不能返回临时 tool schema。

### 7.3 Runtime Projection Publish

`POST /api/client/runtime/projection`

用途：

- 客户端把“当前个人 Workspace 工具面中、本机可执行的能力子集”发布给云端。
- 云端根据组织 policy 二次裁剪。
- 返回 accepted projection id。该 id 属于个人 Workspace 工具面，不属于聊天请求。

请求结构：

```ts
interface RuntimeProjectionPublishRequest {
  projection: RuntimeProjection;
  session: ClientSessionState;
  workspace?: WorkspaceProject;
  publishedAt: string;
}
```

插件体系新增要求：

- `ownerWorkId` 必须由认证态注入，客户端传入值不能覆盖服务端认证结果。
- `projection.capabilities[].origin.locality` 必须明确是 `local` 还是 `cloud`。
- 本地 MCP 能力必须带 `origin.providerId` 和 `origin.transport`。
- Plugin 能力必须带 `origin.packageId` 和 `origin.packageVersion`。
- 不允许把本地 command、env、secret path 投影给云端。

响应结构：

```ts
interface RuntimeProjectionPublishResult {
  accepted: boolean;
  projectionId: string;
  expiresAt?: string;
  rejectedCapabilities?: ProjectionRejection[];
  message?: string;
}

interface ProjectionRejection {
  capabilityId: string;
  reason:
    | 'policy_disabled'
    | 'untrusted_plugin'
    | 'unhealthy_provider'
    | 'risk_too_high'
    | 'data_level_too_high'
    | 'schema_invalid';
}
```

### 7.4 Gateway WS Runtime Session

`GET /api/client/runtime/ws`

用途：

- 客户端主动建立 outbound runtime session。
- 云端通过这个 session 推送当前个人 Workspace Projection 中允许、且需要本地执行的 `client_tool_call`。
- 客户端通过 ack / resume 保证断线恢复时不会漏执行或重复执行。
- 会话消息、assistant delta、本地工具调用请求、执行结果状态可以走同一条 runtime channel，但边界事件必须分类型建模。

核心事件：

```ts
type RuntimeGatewayEvent =
  | RuntimeClientHello
  | RuntimeProjectionPublished
  | RuntimeUserMessage
  | RuntimeAssistantDelta
  | RuntimeClientToolCallRequest
  | RuntimeClientToolCallAck
  | RuntimeClientToolCallResult
  | RuntimeResume
  | RuntimeError;
```

`client_tool_call` 请求结构：

```ts
interface RuntimeClientToolCallRequest {
  type: 'client_tool_call.request';
  sessionId: string;
  conversationId?: number;
  projectionId: string;
  call: ClientToolCall;
  seq: number;
  issuedAt: string;
}
```

运行约束：

- `ClientToolCall.capabilityId` 必须命中 projection 中的 capability。
- 云端不得推送未 projected 的本地 MCP tool。
- 云端不得推送来自 disabled / untrusted plugin 的 tool。
- 云端不得把 Cloud MCP tool 放进本地 runtime channel；Cloud MCP 由云端自己执行。
- 客户端收到请求后必须先本地分类、权限确认和 provider enforcement，再执行。
- Gateway WS 是主链路；`POST /api/client/runtime/tasks/poll` 只用于断线恢复、旧客户端兼容或 WS 不可用时兜底。

### 7.5 Client Tool Result / Evidence Return

`POST /api/chat/client-tool/result`

用途：

- 客户端回传本地执行结果。
- 云端写入执行账本。
- 线程根据 Evidence 更新 Tool timeline。

请求结构：

```ts
interface ClientToolResultReport {
  conversationId?: number;
  streamId?: string;
  call: ClientToolCall;
  grant: PermissionGrant;
  result: ClientToolResult;
  reportedAt: string;
}
```

插件体系新增要求：

- Local MCP 和 Plugin 执行必须带 Evidence。
- Evidence 只能包含 summary、redaction、artifact refs，不能直接塞大块敏感原始输出。
- 如果 Evidence 回传失败，客户端必须进入本地 retry queue，并在 UI 中标注“未回传云端”。

### 7.6 后续可选 API

这些不是第一阶段必需，但需要提前预留路径：

| API | 目的 |
|---|---|
| `GET /api/client/plugins/catalog` | 单独拉取组织插件目录；可被 bootstrap 聚合 |
| `POST /api/client/plugins/download-ticket` | 私有插件包下载鉴权；返回短期下载凭证、签名和 hash |
| `POST /api/client/plugins/inventory` | 客户端上报已安装本地服务、版本和 health 摘要 |
| `GET /api/client/skills/catalog` | 单独拉取云端 Skill catalog；可被 bootstrap 聚合 |
| `GET /api/client/mcp/cloud/catalog` | 单独拉取云端 MCP capability catalog；可被 bootstrap 聚合 |
| `GET /api/client/oauth/providers` | 拉取组织允许的 OAuth 2.1 provider、scope policy 和 connection policy |
| `POST /api/client/oauth/connections/start` | 启动 cloud-owned OAuth 2.1 connection；用于 Skill / Cloud MCP 依赖的云端连接 |
| `GET /api/client/oauth/connections` | 查询用户 / 租户已授权 connection 摘要，不返回 token |

第一阶段推荐先做 `GET /api/client/capability/bootstrap` 聚合接口，避免客户端启动时多接口散落。

## 八、本地注册配置文件

本地注册分三层：内置、用户安装、工作区开发调试。三者不能混在一个目录里。

### 8.1 现状兼容：开发态 capability manifest

当前客户端已经从以下目录读取能力：

```text
<workspaceRoot>/capabilities/*.json
```

当前实现落点是 `apps/desktop/electron/main/capability-registry.mjs`。第一阶段可以继续使用这个入口，但要把它定位成兼容层，不要继续往里面堆 Plugin 安装、MCP 进程、用户设置和运行态 health。

这个目录继续保留，但定位收窄为：

- 开发态 direct `CapabilityManifest`。
- 内置能力或本地 health stub 调试。
- 不承载正式 Plugin package。
- 不承载第三方 MCP 进程配置。

示例：

```text
capabilities/local.health.json
```

### 8.2 正式用户级 Plugin Registry

正式本地注册文件放在 Electron `userData` 下：

```text
<userData>/plugins/registry.json
```

在 macOS 上实际路径是：

```text
~/Library/Application Support/@peer-agent/desktop/plugins/registry.json
```

Windows / Linux 通过 Electron `app.getPath('userData')` 获取，不在代码里硬编码。

`registry.json` 是客户端管理的本地事实源，记录用户安装了哪些 Plugin、哪些 MCP Server 被启用、默认权限策略是什么。

第一阶段实现建议：

- 新增 `apps/desktop/electron/main/plugin-registry-store.mjs`，只负责读写 `<userData>/plugins/registry.json`。
- 新增 `apps/desktop/electron/main/plugin-package-loader.mjs`，只负责读取 `<userData>/plugins/packages/*/*/plugin.json`。
- `capability-registry.mjs` 只做聚合：读取开发态 capability、Plugin package manifest、MCP health 结果，然后输出 `CapabilityManifestV2[]`。
- `main.mjs` 创建 registry 时传入 `userDataPath: app.getPath('userData')`，不要在底层模块里直接 import Electron。

示例：

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-05-20T00:00:00.000Z",
  "plugins": [
    {
      "pluginId": "dingtalk-workbench",
      "version": "0.1.0",
      "enabled": true,
      "trust": "organization_signed",
      "packagePath": "packages/dingtalk-workbench/0.1.0",
      "permissionDefaults": {
        "dingtalk.message.read_selected": "ask",
        "dingtalk.todo.create_draft": "ask"
      }
    }
  ],
  "mcpServers": [
    {
      "serverId": "dingtalk-workbench.local-mcp",
      "pluginId": "dingtalk-workbench",
      "enabled": true,
      "transport": "stdio",
      "commandRef": "plugin:bin/mcp-server",
      "args": [],
      "envPolicy": "plugin_scoped"
    }
  ]
}
```

注意：

- `registry.json` 不能存 secret 明文。
- secret 只能存 OS keychain / credential store，registry 里只放 `secretRef`。
- `packagePath` 是相对 `<userData>/plugins/` 的路径。
- `commandRef` 推荐使用 plugin-relative 引用，避免把绝对本地路径投影给云端。

### 8.3 Plugin Package 目录

插件包安装到：

```text
<userData>/plugins/packages/<pluginId>/<version>/
```

插件包必须包含：

```text
plugin.json
```

示例：

```text
~/Library/Application Support/@peer-agent/desktop/plugins/
  registry.json
  packages/
    dingtalk-workbench/
      0.1.0/
        plugin.json
        bin/
          mcp-server
```

`plugin.json` 是 package-level manifest：

```json
{
  "schemaVersion": 1,
  "pluginId": "dingtalk-workbench",
  "name": "DingTalk Workbench",
  "version": "0.1.0",
  "publisher": "1688",
  "minimumClientVersion": "0.0.1",
  "capabilities": [],
  "mcpServers": []
}
```

### 8.4 本地运行态状态文件

运行态 health、启动失败、最近错误不写进 `registry.json`，单独写：

```text
<userData>/plugins/state.json
```

示例：

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-05-20T00:00:00.000Z",
  "providers": [
    {
      "providerId": "dingtalk-workbench.local-mcp",
      "health": "available",
      "lastCheckedAt": "2026-05-20T00:00:00.000Z"
    }
  ]
}
```

这样做是为了避免运行态噪声频繁污染用户配置。

### 8.5 工作区本地开发注册

开发者调试 Plugin / MCP 时，允许工作区下放一个本地注册文件：

```text
<workspaceRoot>/.peer-agent/plugins.local.json
```

这个文件只在 developer mode 下读取，不进入生产用户默认路径。

示例：

```json
{
  "schemaVersion": 1,
  "developerModeOnly": true,
  "plugins": [
    {
      "pluginId": "local-dev-plugin",
      "packagePath": "./plugins/local-dev-plugin",
      "enabled": true,
      "trust": "developer_local"
    }
  ],
  "mcpServers": [
    {
      "serverId": "local-dev-plugin.mcp",
      "pluginId": "local-dev-plugin",
      "transport": "stdio",
      "command": "node",
      "args": ["./plugins/local-dev-plugin/server.mjs"],
      "envPolicy": "user_configured",
      "enabled": true
    }
  ]
}
```

工作区注册规则：

- 默认不提交到仓库。
- 只在 developer mode 生效。
- 不允许自动进入个人工具面；仍然要通过本地 trust、health 和 policy。
- 不能覆盖用户级 registry 中的组织签名 plugin。

### 8.6 最终加载顺序

客户端启动时按以下顺序加载：

```text
1. built-in capabilities
2. <workspaceRoot>/capabilities/*.json                 # 现状兼容 / 开发态 capability
3. <userData>/plugins/registry.json                    # 正式用户安装
4. <userData>/plugins/packages/*/*/plugin.json          # 插件包 manifest
5. <workspaceRoot>/.peer-agent/plugins.local.json       # developer mode only
6. health check local MCP / adapters
7. build personal tool surface
```

加载后的能力全部归一到 `CapabilityManifestV2[]`，再进入个人工具面裁剪流程（Runtime Projection）。

## 九、Manifest 扩展

当前 `CapabilityManifest` 已经覆盖第一版能力声明：

```ts
interface CapabilityManifest {
  capabilityId: string;
  source: 'native' | 'shell' | 'plugin' | 'mcp' | 'page_bridge' | 'private';
  riskLevel: CapabilityRiskLevel;
  dataLevel: DataLevel;
  health: CapabilityHealth;
  inputSchema: JsonSchemaLike;
  evidencePolicy: EvidencePolicy;
}
```

插件体系需要在不破坏现有契约的前提下补充能力来源：

```ts
type CapabilityLocality = 'cloud' | 'local';

interface CapabilityOrigin {
  locality: CapabilityLocality;
  providerId: string;
  packageId?: string;
  packageVersion?: string;
  transport?: 'native' | 'shell_spawn' | 'mcp_stdio' | 'mcp_streamable_http' | 'cloud_mcp' | 'http';
}
```

建议追加字段：

```ts
interface CapabilityManifestV2 extends CapabilityManifest {
  origin: CapabilityOrigin;
  tags?: string[];
  requiredSecrets?: string[];
  requiredApps?: string[];
  requiredPermissions?: string[];
  installState?: 'builtin' | 'installed' | 'disabled' | 'missing_dependency' | 'untrusted';
}
```

投影给云端的 Manifest 不能暴露原始 plugin 配置、本地 secret 路径或本地敏感路径。

## 十、Plugin Manifest

`Plugin` manifest 是包级对象，不是 capability manifest。

```ts
interface PluginPackageManifest {
  pluginId: string;
  name: string;
  version: string;
  publisher: string;
  description?: string;
  signature?: {
    algorithm: string;
    digest: string;
  };
  capabilities: CapabilityManifestV2[];
  mcpServers?: PluginMcpServerConfig[];
  settingsSchema?: JsonSchemaLike;
  minimumClientVersion?: string;
}
```

`PluginMcpServerConfig` 必须区分本地 MCP Server 类型：

```ts
interface PluginMcpServerConfig {
  serverId: string;
  locality: 'local';
  transport: 'stdio' | 'streamable_http';
  command?: string;
  args?: string[];
  url?: string;
  envPolicy?: 'none' | 'plugin_scoped' | 'user_configured';
}
```

本地私有工具默认使用 `stdio`。服务型本地工具可以使用 local Streamable HTTP，但前提是进程生命周期和端口所有权明确。

## 十一、Skill Definition

`SkillDefinition` 属于云端 Runtime。

```ts
interface SkillDefinition {
  skillId: string;
  name: string;
  version: string;
  intentPatterns: string[];
  requiredCapabilities: CapabilityRequirement[];
  optionalCapabilities?: CapabilityRequirement[];
  checkpoints?: SkillCheckpoint[];
  evidencePolicy: EvidencePolicy;
}

interface CapabilityRequirement {
  capabilityPattern: string;
  locality?: 'cloud' | 'local' | 'any';
  maxRiskLevel: CapabilityRiskLevel;
  maxDataLevel: DataLevel;
}
```

`Skill` 选择链路：

```text
User intent
  -> Cloud Skill matching
    -> Capability requirement resolution
      -> Runtime Projection pruning
        -> Tool selection
```

`Skill` 可以要求某类本地能力，但不能假设该能力一定存在。如果 Runtime Projection 里没有匹配的本地能力，云端应该降级、提示用户安装或启用 Plugin，或者继续执行 cloud-only 路径。

## 十二、Runtime Projection 规则

`Runtime Projection` 是云端 Agent 能看到的唯一一本地能力视图。

Projection 输入：

- 云端组织 policy。
- 用户身份和租户。
- 当前 session access level。
- 已安装本地 plugins。
- 本地 Shell policy、sandbox availability 和 permission rules。
- 本地 MCP health。
- 用户禁用的 plugins。
- 数据和风险 policy。
- 当前 conversation scope。

Projection 输出：

- 云端可见的本地能力子集。
- 脱敏后的 manifest 元数据。
- 稳定的 `projectionId`。
- TTL。

Projection 必须移除：

- 已禁用的 plugins。
- 被本地 Shell policy 禁用的 command scope。
- 未受信的 plugin package。
- 不健康的本地 MCP Server。
- 超过当前 access level 的能力。
- 被业务 policy 阻断的能力。
- input schema 或 evidence policy 无法校验的能力。

## 十三、权限 Gates

每个能力都必须经过四道 gate：

| Gate | Owner | 适用对象 |
|---|---|---|
| Cloud organization policy | Cloud | Skills、Cloud MCP、Local Shell、Local MCP、Plugins |
| Runtime Projection pruning | Cloud + client | Local Shell、Local MCP、Plugins、native local capabilities |
| Local user consent | Client | 本地执行，尤其是 Shell / MCP / Plugin |
| Adapter execution enforcement | Local provider | Local Shell / Local MCP / Plugin adapter |

云端 MCP 不在用户机器执行，因此不需要本地用户确认，但仍然需要云端 policy 和 Evidence。

本地 MCP 永远不能跳过 adapter execution enforcement。

本地 Shell 永远不能跳过本地 command classification 和 PermissionRule 检查。

### 13.1 Skill 鉴权

`Skill` 不是 OAuth client，也不持有 token。`Skill` 鉴权分三层：

1. 用户是否已通过客户端登录，并持有有效 cloud session。
2. 租户 / 组织 policy 是否允许该用户启用或调用这个 `Skill`。
3. `Skill` 依赖的 capability 是否具备可用 connection 和足够 scope。

`SkillDefinition` 只能声明依赖：

```ts
interface SkillAuthRequirement {
  connectionKind: 'cloud' | 'local';
  providerId: string;
  requiredScopes: string[];
  requiredCapabilities: string[];
}
```

`Skill` 不能发起 OAuth token exchange，不能读取 refresh token，也不能把 token 注入 prompt。它只能通过 Runtime 调度 capability，由对应 provider 使用自己的 connection 执行。

### 13.2 Cloud MCP 鉴权

`Cloud MCP` 在云端执行，OAuth 2.1 connection 归云端 credential vault 管理。

链路：

```text
User enables Cloud MCP / Skill dependency
  -> Cloud returns OAuth 2.1 auth_url with PKCE / state
  -> User completes consent
  -> Cloud callback exchanges code
  -> Cloud stores token in credential vault
  -> Runtime stores only connectionRef
  -> Cloud MCP provider executes tool with connectionRef
```

设计约束：

- 只使用 Authorization Code + PKCE，不使用 implicit flow。
- `state` 必须绑定用户、租户、provider、requested scopes 和 nonce。
- refresh token 只能进入云端 credential vault，不能进入 LLM context。
- Tool call 只携带 `connectionRef`，不携带 access token。
- Cloud MCP 的 Evidence 记录 connection id、scope 摘要和 provider id，不记录 token。

### 13.3 Local MCP 鉴权

`Local MCP` 在用户机器执行，OAuth 2.1 connection 默认归客户端本地 credential store 管理。

链路：

```text
User enables Local MCP / Plugin
  -> Client reads MCP auth metadata
  -> Client opens OAuth 2.1 auth_url with PKCE / state
  -> Client receives loopback / custom scheme callback
  -> Client exchanges code
  -> Client stores token in OS credential store
  -> Runtime Projection exposes authState only
  -> client_tool_call arrives
  -> Local adapter injects short-lived credential or uses local token broker
```

本地 registry 只能存引用：

```json
{
  "serverId": "dingtalk-workbench.local-mcp",
  "auth": {
    "type": "oauth2_1",
    "providerId": "dingtalk",
    "connectionOwner": "client",
    "secretRef": "keychain://peer-agent/oauth/dingtalk/default",
    "scopes": ["todo.read", "todo.write"]
  }
}
```

设计约束：

- `<userData>/plugins/registry.json` 不能存 access token、refresh token、client secret。
- token 存 OS keychain / credential store；registry 只存 `secretRef`。
- projection 只能上报 `authState: connected | expired | missing | revoked` 和 scope 摘要。
- 如果 Local MCP adapter 需要环境变量注入 token，必须经过 `envPolicy` 和本地用户确认。
- 云端不得要求客户端把本地 OAuth token 回传。

### 13.4 ConnectionRef 和 PermissionGrant

统一 connection 摘要：

```ts
interface CapabilityConnectionRef {
  connectionId: string;
  owner: 'cloud' | 'client';
  providerId: string;
  scopes: string[];
  status: 'connected' | 'expired' | 'missing' | 'revoked';
  expiresAt?: string;
}
```

`Runtime Projection` 可以暴露 connection 摘要，但不能暴露 token。

每次执行仍然要生成 `PermissionGrant`：

```ts
interface PermissionGrant {
  grantId: string;
  capabilityId: string;
  connectionId?: string;
  scopes: string[];
  approvedBy: 'policy' | 'user';
  expiresAt?: string;
}
```

OAuth 解决“能不能访问某个外部系统”，`PermissionGrant` 解决“这一次工具调用是否被允许执行”。两者不能互相替代。

## 十四、Evidence 契约

任何影响数据、文件、外部系统或持久状态的能力都必须产生 Evidence。

Local MCP 和 Plugin 的 Evidence 必须包含：

- Tool call id。
- Capability id。
- Plugin/package id，如适用。
- MCP server id，如适用。
- Data level。
- Redaction summary。
- Artifact references，不能直接回传大块原始输出。
- Local execution status。
- Evidence 是否已经回传云端。

Local Shell 的 Evidence 必须包含：

- Tool call id。
- command 摘要和 redacted command。
- cwd scope。
- PermissionRule / user grant 摘要。
- exit code。
- stdout / stderr preview。
- output artifact ref。
- background task id，如适用。
- sandbox status。

Cloud MCP 的 Evidence 必须包含：

- Tool call id。
- Cloud provider id。
- Tenant / policy context summary。
- Output summary。
- Artifact references。
- Cloud ledger write status。

## 十五、界面放置

UI 不应该让 Plugin 或 MCP 变成主工作面。

Sidebar：

- `Plugins` 打开能力管理面板。
- `Automations` 保持独立。
- 活跃会话和 Channels 仍然是主索引。

插件管理面板：

- 已安装 plugins。
- 可用 capabilities。
- 本地 MCP health。
- 云端 MCP 可用性，如果云端暴露。
- 信任和签名状态。
- 启用 / 禁用开关。
- 默认权限。
- 诊断信息。

Shell 管理面板：

- 当前 workspace shell policy。
- Shell permission rules。
- background tasks。
- sandbox availability。
- output artifacts。
- destructive command audit。

Task thread：

- Tool call 作为 timeline event 出现。
- Shell command 作为可展开的 command event 出现，默认只显示 description、状态、exit code 和输出摘要。
- 权限确认作为 Review card 出现。
- Evidence 作为 Evidence summary 出现。
- Plugin / MCP 名称只是元数据，不是主回答内容。

Composer：

- 可以显示当前 access mode。
- 可以在相关时显示本地能力可用性。
- 不应该变成密集的插件控制台。

## 十六、本地安装和信任

云端能力不做“安装”。

- `Skill` 是云端编排对象，只做 catalog 可见、租户授权、用户启用或禁用。
- `Cloud MCP` 是云端托管服务，只做 cloud policy / tenant binding。
- 需要安装的只有本地服务：`Plugin`、`Local MCP Server`、以及某个 `Skill` 依赖的本地 Plugin / Local MCP。

因此“一键安装 Skill”在产品语义上应该表达为：

```text
启用 Skill
  -> 发现缺少本地依赖
    -> 一键安装所需本地 Plugin / Local MCP
      -> health check
        -> Runtime Projection refresh
          -> Skill 可调度这些本地能力
```

不能把 `SkillDefinition` 下载到本地当插件执行，也不能让云端 MCP 走本地安装链路。

### 16.1 本地安装动作

本地安装不需要云端 install API。

客户端可以从三类来源安装本地服务：

| 来源 | 是否需要云端 | 说明 |
|---|---|---|
| 本地文件 / 本地目录 | 不需要 | 直接读取 plugin package 或 MCP config |
| 官方 / 组织插件目录 | 需要 catalog | 只用于发现版本、签名、hash、下载地址 |
| 私有插件包 | 需要 download ticket | 只用于下载鉴权，不是安装鉴权 |

安装动作始终由客户端完成：

```text
Client reads package / catalog metadata
  -> verify plugin.json / mcp config / signature / hash
  -> show local permissions
  -> user confirms
  -> write package and registry
  -> health check
  -> refresh Runtime Projection
```

云端只参与 catalog、企业 policy、私有包下载鉴权和 OAuth connection，不参与本地写文件。

### 16.2 客户端安装落点

客户端安装本地服务后，只能写这些位置：

```text
<userData>/plugins/packages/<pluginId>/<version>/
<userData>/plugins/registry.json
<userData>/plugins/state.json
```

开发者模式可以额外写：

```text
<workspaceRoot>/.peer-agent/plugins.local.json
```

安装完成后，客户端可以选择性上报本地 inventory：

```text
POST /api/client/plugins/inventory
```

上报内容只包含安装摘要、版本、health、capability ids 和 Evidence 摘要，不包含本地绝对路径、secret、环境变量。

Plugin 安装状态：

```text
discovered
  -> installed
    -> verified
      -> enabled
        -> projected
          -> executable
```

信任要求：

- 内置 plugins 随客户端版本发布，默认可信。
- 组织 plugins 需要签名，并通过组织 policy。
- 开发者 plugins 只能在 developer mode 或显式本地信任模式下运行。
- 未受信 plugins 可以被安装，但不能进入个人工具面。
- Plugin 更新必须重新校验签名、manifest 和 minimum client version。
- Local MCP 如果由 Plugin 携带，信任继承 Plugin package；如果是用户手动注册，必须单独确认 command / url / env policy。
- Skill 只能依赖本地能力，不能安装、更新或执行本地代码。

## 十七、失败模式

| 失败 | 预期行为 |
|---|---|
| Cloud Skill 需要本地能力，但没有任何能力被 projected | 云端提示用户安装所需本地 Plugin / Local MCP，或降级执行 |
| Shell command 风险无法分类 | fail closed，客户端要求用户确认或拒绝 |
| Shell command 输出过大 | 输出落 artifact，只回传 preview 和 artifact ref |
| 后台 Shell task 卡在交互 prompt | 通知用户停止并用非交互参数重跑 |
| 本地 MCP Server 不健康 | capability health 变为 `unhealthy`，projection 移除它 |
| 用户拒绝授权 | 返回 `ClientToolResult.status = "denied"` 和 Evidence |
| Plugin 在任务中被禁用 | 后续调用被阻断；进行中的调用安全失败 |
| MCP schema 变化 | Manifest version 变化；要求刷新 projection |
| Evidence 回传失败 | 保留本地重试队列；UI 显示 Evidence 未回传 |

## 十八、实现阶段

### Phase 0：契约词汇

- 增加 `CapabilityLocality` 和 `CapabilityOrigin`。
- 定义 `LocalShellExecInput`、`LocalShellExecResult`、`ShellPermissionRule` 和 `LocalShellProjectionPolicy`。
- 定义 `PluginPackageManifest`。
- 定义 local MCP server config shape。
- 明确云端 API：`capability/bootstrap`、`runtime/projection`、`runtime/ws`、`client-tool/result`、`plugins/catalog`、`plugins/download-ticket`；`runtime/tasks/poll` 仅作为兼容兜底。
- 明确 OAuth 2.1 鉴权边界：Skill 不持有 token；Cloud MCP token 在云端 vault；Local MCP token 在本地 credential store。
- 明确本地配置文件：`<userData>/plugins/registry.json`、`<userData>/plugins/state.json`、`<workspaceRoot>/.peer-agent/plugins.local.json`。
- 文档化云端 MCP 和本地 MCP 的差异。
- 保持现有 `local.health` 链路不变，并新增 `local.shell.exec` 作为第一阶段真实本地调度能力。

### Phase 1：Runtime Contract + Local Shell Provider

- 定义 Gateway WS / `client_tool_call` 事件契约。
- 内置 `local.shell.exec` capability manifest。
- 实现 shell command permission classification。
- 实现 shell spawn、timeout、abort、background task、output artifact。
- 实现 Shell Evidence 回传。
- 用 `pwd`、write command rule、background stop、Gateway projected shell call 跑通端云闭环。

### Phase 2：本地 Plugin Registry

- 实现 `plugin-registry-store.mjs`，读写 `<userData>/plugins/registry.json`。
- 实现 `plugin-package-loader.mjs`，从 `<userData>/plugins/packages/*/*/plugin.json` 加载 package manifest。
- 校验 manifest schema。
- 把 plugin capabilities 合并进本地 registry。
- 保留 `<workspaceRoot>/capabilities/*.json` 作为开发态兼容输入。
- 在 Settings 里展示已安装 plugins 和 capability health。
- 暂不执行第三方 plugin code。

### Phase 3：本地 MCP Host

- 增加 MCP stdio 进程生命周期。
- 把 MCP tools 转成 `CapabilityManifest`。
- health-check 本地 MCP servers。
- 只把 projected tools 暴露给云端。
- 只通过 `client_tool_call` 执行。

### Phase 4：云端 MCP Registry

- 云端通过 cloud-side manifest registry 暴露云端 MCP capabilities。
- 云端 Skills 可以按 locality 要求 cloud MCP 或 local MCP。
- 云端 ledger 记录 Cloud MCP Evidence。

### Phase 5：Local Service Distribution

- 增加签名 plugin package 格式。
- 增加 install / update / uninstall 流程。
- 增加组织 policy allowlist。
- 增加 developer mode plugin install。
- 支持 Skill dependency 一键安装，但安装对象仍然只能是本地 Plugin / Local MCP。
- 一键安装不依赖云端 install API；私有包下载可以依赖 OAuth 2.1 / download ticket。

### Phase 6：Skill Marketplace

- Skill catalog 仍然由云端拥有。
- Skills 声明 capability requirements。
- Skills 可以推荐本地依赖，但不能在没有用户动作的情况下安装或执行本地能力。

## 十九、第一阶段非目标

- 完整 marketplace。
- Plugin auto-update。
- 通过 localhost 做远程执行。
- 任意无限制 Bash 执行。
- 让本地 MCP 成为云端凭证代理。
- 让 plugins 直接写 cloud memory 或 business ontology。
- 让 Skills 绕过 Runtime Projection。
- 通用本地 Agent Runtime。

## 二十、设计验收口径

设计可接受的条件：

1. `Skill`、`Plugin`、`MCP` 有独立定义。
2. MCP locality 明确区分：`cloud` 和 `local`。
3. Local Shell 是一等内置 Provider，不能被当成普通 Plugin / MCP。
4. Local MCP 只使用客户端中介的 outbound execution。
5. 能力暴露必须经过 Manifest 和 Runtime Projection。
6. Shell command 必须经过本地分类、PermissionRule、timeout、output artifact 和 Evidence。
7. 执行结果必须返回 PermissionGrant 和 Evidence。
8. UI 放置保证 Plugins / MCP / Shell 不侵入主任务面。
9. 云端 API 有明确 endpoint、方向、输入输出和现有客户端映射。
10. 本地注册有明确文件路径，并区分用户安装、运行态状态和工作区开发调试。
11. 现有 `<workspaceRoot>/capabilities/*.json` 被限定为兼容层，不承担正式 Plugin Registry。
12. 一键安装只安装本地服务；`Skill` 和 `Cloud MCP` 不进入本地安装链路。
13. Skill / MCP 鉴权有明确 OAuth 2.1 owner：cloud-owned connection 和 client-owned connection 分离。
14. 实现阶段可以开始，不引入新的大而全 catch-all 模块。
