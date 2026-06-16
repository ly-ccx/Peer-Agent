# 31. MCP 连接管理与设置入口

## Status

Accepted locally on 2026-06-15.

## Context

Peer Agent 需要设计 MCP 对接体系，并把用户可操作入口放在桌面端设置页中。MCP
接入会影响能力暴露、运行位置、权限、凭据、Runtime Projection、工具调用和
Evidence，因此它不是一个单纯的 renderer 表单或普通偏好设置。

现有能力治理基线要求所有本地能力必须经过：

```text
Capability Provider
  -> Manifest
    -> Runtime Projection
      -> Tool Call
        -> PermissionGrant
          -> Evidence
```

`docs/architecture/15-plugin-skill-mcp-system.md` 已经明确：

- `MCP` 是工具与资源的传输协议，不等同于 `Plugin` 或 `Skill`。
- MCP 必须区分 `cloud` 与 `local` 两种 locality。
- Local MCP 永远在用户设备上执行，云端不得直接访问本地端口。
- Cloud MCP 由云端 Runtime 或可信服务环境执行，不走本地 runtime channel。
- Local MCP 与 Plugin / Shell 一样，必须通过 Manifest 和 Runtime Projection 后才能被 Agent 看见。

`docs/architecture/16-skill-call-lifecycle.md` 已经明确：本地工具调用必须经由
Runtime Gateway Client、Local Tool Host 和 Capability Provider Registry，禁止为
Bash / MCP / Plugin 另开旁路。

因此，本 ADR 解决的问题是：

1. 设置页中 MCP 菜单应该承担什么产品职责。
2. 本地 MCP 与云端 MCP 在 UI、配置、凭据、执行链路上的边界如何划分。
3. Renderer、Electron main、Protocol、Capability Provider、Runtime Projection、
   PermissionReview、Evidence 各自的接口边界是什么。
4. MVP 如何落地，同时不破坏后续 Plugin / Skill / MCP 体系扩展。

## Decision

在设置页新增独立菜单 **MCP 连接**（英文：**MCP Connections**）。

该菜单是 MCP 接入的表达与配置入口，不是 MCP 工具执行入口。它负责：

- 本地 MCP Server 配置管理。
- 本地 MCP Server 健康检查入口。
- MCP tools/resources/prompts 的 Manifest 预览。
- 工具可见性与投影状态展示。
- 云端 MCP Catalog / OAuth / connection 状态展示入口。
- 最近错误、健康检查、Manifest 刷新、Evidence 引用等诊断信息展示。

该菜单不得负责：

- 直接启动本地进程。
- 直接连接 MCP transport。
- 直接执行 MCP tool。
- 直接写入 raw registry / permission / secret store。
- 把 MCP tool description 或外部资源正文拼入 system prompt。
- 把 UI state 当作权限、projection 或 evidence 事实源。

产品分区如下：

```text
设置
  通用
  模型配置
  系统指令
  MCP 连接
  外观
```

`MCP 连接` 推荐放在 `系统指令` 之后、`外观` 之前。MCP 属于能力接入，不属于模型
Provider 配置，也不属于 UI 外观。

## Naming

用户可见命名：

| 中文 | 英文 | 用途 |
|---|---|---|
| MCP 连接 | MCP Connections | 设置菜单与页面标题 |
| 本地 MCP | Local MCP | 运行在用户设备上的 MCP server |
| 云端 MCP | Cloud MCP | 运行在云端可信环境中的 MCP server |
| 工具可见性 | Tool Visibility | 是否进入当前工具面 / Runtime Projection |
| 本地工具面 | Local Tool Surface | 用户可理解的 projection 产品文案 |

工程命名仍使用 `Runtime Projection`、`CapabilityManifest`、`client_tool_call` 等协议名。
这些工程名只出现在日志、调试、协议和开发文档中，产品 UI 不直接把
`projectionId` 展示为主要概念。

## Scope

### MVP Scope

第一阶段只落地设置入口和 Local MCP 连接管理基础能力：

1. 设置页新增 `MCP 连接` 菜单和 `McpSettingsPanel`。
2. 支持 Local MCP Server 配置 CRUD。
3. MVP transport 只要求支持 `stdio`。
4. 支持启用 / 禁用 server。
5. 支持测试连接与刷新 Manifest。
6. 支持查看 discovered tools 的 Manifest 预览。
7. 支持展示健康状态、最近错误、Manifest 更新时间。
8. 支持为工具设置是否进入当前本地工具面，但不把该设置等同于执行授权。

### Later Scope

后续阶段再加入：

- Local MCP `sse` / `streamable_http` transport。
- Cloud MCP Catalog。
- Cloud MCP OAuth connection。
- 组织 policy allowlist / denylist。
- Plugin 打包分发内置 MCP 配置。
- Skill dependency 推荐安装。
- Marketplace。

### Non-goals

本 ADR 不引入：

- MCP marketplace。
- 任意远程 localhost 反连执行。
- Renderer 直接 `child_process.spawn`。
- Renderer 直接读取或写入 MCP registry 文件。
- Renderer 持有 secret 明文。
- MCP tool 对 Cloud Runtime 的旁路执行通道。
- “添加 MCP 后自动全部授权执行”。
- 把 MCP resources/prompts 作为 system instruction 注入。
- 通用本地 Agent Runtime。

## Architecture

### 1. 总体链路

Local MCP 必须归一到既有能力链路：

```text
Settings UI
  -> clientApi.mcp.*
    -> Electron Main MCP Connection Manager
      -> Local MCP Registry
      -> Local MCP Transport Host
      -> Local MCP Provider Adapter
        -> MCP initialize / tools.list / resources.list
          -> CapabilityManifest
            -> Runtime Projection
              -> Cloud Agent 可见
                -> client_tool_call
                  -> Runtime Gateway Client
                    -> Local Tool Host
                      -> Capability Provider Registry
                        -> Local MCP Provider Adapter.execute()
                          -> MCP tools.call
                            -> PermissionGrant
                              -> Evidence
```

Cloud MCP 必须留在云端执行：

```text
Cloud MCP Catalog
  -> Cloud CapabilityManifest
    -> Runtime Projection
      -> Cloud Agent 可见
        -> Cloud Runtime executes cloud MCP
          -> Cloud-side Tool Result
            -> Cloud-side Evidence / Ledger
```

桌面端对 Cloud MCP 只负责展示 catalog、connection 状态、授权入口和本地用户可见性
偏好。桌面端不得通过 Local Tool Host 执行 Cloud MCP tool。

### 2. Layering

```text
McpSettingsPanel (renderer, expression only)
  -> preload clientApi.mcp bridge
    -> IPC mcp:* protocol handlers
      -> McpConnectionManager (main)
        -> LocalMcpRegistryStore (main, userData)
        -> LocalMcpSecretResolver (main, safeStorage / OS keychain)
        -> LocalMcpTransportHost (main, stdio/sse/http lifecycle)
        -> LocalMcpDiscoveryService (main, initialize + list tools/resources/prompts)
        -> LocalMcpManifestProjector (main/protocol adapter)
          -> CapabilityProviderRegistry
            -> LocalMcpProviderAdapter
              -> PermissionReview
              -> Evidence writer
```

设计原则：

- Renderer 只表达状态和用户意图。
- Main process 持有配置、进程生命周期、凭据解析、健康检查事实。
- Protocol 定义跨层数据结构和 IPC payload，不用 ad hoc plain object 作为长期契约。
- Provider Adapter 负责把 MCP tool 归一为 `CapabilityManifest` 并处理执行。
- Runtime Projection 决定 Agent 可见能力。
- PermissionReview 决定本地执行授权。
- Evidence 记录事实，不由 assistant 文本或 renderer state 替代。

### 3. Module Seams

| Module | Interface | Implementation responsibility |
|---|---|---|
| `McpSettingsPanel` | `clientApi.mcp.*` view model | 设置页表达、表单、状态展示、空状态、错误展示 |
| `clientApi.mcp` | Preload bridge typed methods | renderer 到 main 的受控入口 |
| MCP IPC handlers | `mcp:*` channels / protocol payloads | 参数校验、错误归一、调用 main service |
| `McpConnectionManager` | server CRUD / test / refresh / diagnostics | 编排 registry、transport、discovery、manifest cache |
| `LocalMcpRegistryStore` | load/save server config | userData 持久化；不保存 secret 明文 |
| `LocalMcpTransportHost` | connect/test/stop/call | stdio/sse/http 生命周期与超时取消 |
| `LocalMcpDiscoveryService` | discover capabilities | MCP initialize、tools/list、resources/list、prompts/list |
| `LocalMcpManifestProjector` | MCP -> CapabilityManifest | risk/source/locality/origin/schema 归一化 |
| `LocalMcpProviderAdapter` | provider register / execute | Provider Registry adapter；执行 tool call；Evidence |
| `PermissionReview` | permission grant | 执行前授权、规则命中、拒绝路径 |
| Evidence writer | artifact refs / previews | 输入输出脱敏、artifact、失败/超时/拒绝记录 |

禁止把 `McpConnectionManager` 做成新的本地工具执行旁路。它只管理连接、发现和配置；
真实 Agent tool call 仍通过 `LocalToolHost -> CapabilityProviderRegistry` 执行。

## UI Decision

### 1. Page Layout

`MCP 连接` 页面分为四块：

```text
MCP 连接

[总览]
  本地 MCP 数量 / 运行中数量 / 失败数量
  云端 MCP connection 数量
  当前本地工具面可见 MCP tools 数量
  最近 Manifest 刷新时间

[本地 MCP]
  server 列表
  添加本地 MCP
  启用 / 禁用
  测试连接
  刷新 Manifest
  查看工具
  编辑 / 删除

[云端 MCP]
  catalog 与连接状态
  授权 / 断开
  启用到当前工具面

[诊断]
  健康检查结果
  最近错误
  最近 Manifest 刷新结果
  最近执行 Evidence 引用
```

MVP 可以先实现 `[本地 MCP]` 与基础空状态，`[云端 MCP]` 以占位说明呈现。

### 2. Empty State

无 MCP 连接时显示：

```text
还没有 MCP 连接。

MCP 可以让 Peer Agent 接入本地工具、数据库、文件系统或第三方服务。
添加本地 MCP Server 后，Peer Agent 会先生成能力清单。只有进入本地工具面并通过执行授权后，Agent 才能调用这些工具。

[添加本地 MCP]
```

英文：

```text
No MCP connections yet.

MCP lets Peer Agent connect to local tools, databases, filesystems, or third-party services.
After a local MCP server is added, Peer Agent discovers its capability manifest first. The Agent can call those tools only after they are admitted into the local tool surface and pass runtime permission review.

[Add Local MCP]
```

### 3. Local MCP Card

每个本地 MCP server 卡片显示：

```text
Filesystem MCP                         Running
Transport: stdio
Command: npx -y @modelcontextprotocol/server-filesystem ...
Tools: 5 discovered / 3 visible
Permission: Ask every time
Manifest: Updated at 14:32
Last health check: OK

[View tools] [Test] [Refresh manifest] [Disable] [Edit] [Delete]
```

异常状态：

```text
GitHub Local MCP                       Error
Transport: stdio
Command: node ./server.js
Tools: 0
Last error: initialize timed out after 10s

[Test] [Edit] [Disable] [Delete]
```

### 4. Tool Visibility

`View tools` 展示 Manifest 预览和可见性：

```text
[✓] filesystem.read_file       local / mcp / L2_read
[ ] filesystem.write_file      local / mcp / L4_write
[✓] filesystem.list_directory  local / mcp / L2_read
```

可见性开关表示：是否允许该 tool 进入当前本地工具面 / Runtime Projection。

它不表示：

- 当前已经授权执行。
- 未来每次调用自动允许。
- Agent 可绕过 PermissionReview。

高风险工具默认不可见或默认 `ask`，具体执行时仍进入 PermissionReview。

### 5. Add Local MCP Flow

添加流程：

1. 选择 transport。MVP 只显示 `stdio`。
2. 填写名称、command、args、cwd、env secret refs。
3. 点击 `测试连接`。
4. Main process 创建临时 transport，执行 MCP initialize 与 tools/list。
5. UI 展示 Manifest 预览、风险提示和错误。
6. 用户确认添加。
7. Main process 写入 registry，默认 server 可 enabled，但 tools 默认不应全部自动进入 projection。
8. 用户在 `工具可见性` 中选择暴露哪些工具。

失败或取消时不应落盘半成品连接，除非用户明确选择“保存为禁用草稿”。

## Protocol Contracts

MCP 设置相关协议对象应定义在 `packages/protocol/src` 下的新模块或现有能力协议模块中。
不要让 renderer/main 使用长期无类型 ad hoc payload。

### 1. Server Config

```ts
export type McpTransportKind = 'stdio' | 'sse' | 'streamable_http';

export interface LocalMcpServerConfig {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly transport: McpTransportKind;

  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string | null;

  readonly url?: string;
  readonly headers?: Record<string, string>;

  /** Secret values are not stored here. Values are references resolved by main. */
  readonly envSecretRefs?: Record<string, string>;
  readonly headerSecretRefs?: Record<string, string>;

  readonly permissionProfile: McpPermissionProfile;
  readonly visibilityDefaults: McpVisibilityDefaults;

  readonly createdAt: string;
  readonly updatedAt: string;
}

export type McpPermissionProfile =
  | 'ask_every_time'
  | 'allow_readonly'
  | 'custom'
  | 'disabled';

export type McpVisibilityDefaults =
  | 'disabled_by_default'
  | 'readonly_visible'
  | 'all_visible_requires_confirmation';
```

MVP 只实现 `transport: 'stdio'`，但协议预留 `sse` 与 `streamable_http`。

### 2. Renderer View

Renderer view 不包含 secret 明文，不包含完整高风险环境变量：

```ts
export interface LocalMcpServerView {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly transport: McpTransportKind;
  readonly commandPreview?: string;
  readonly urlPreview?: string;
  readonly toolsCount: number;
  readonly visibleToolsCount: number;
  readonly health: McpHealthStatus;
  readonly manifestUpdatedAt?: string;
  readonly lastError?: string;
}

export interface McpHealthStatus {
  readonly status: 'unknown' | 'ok' | 'error' | 'disabled' | 'checking';
  readonly checkedAt?: string;
  readonly message?: string;
}
```

### 3. Tool Summary

```ts
export interface McpToolSummary {
  readonly id: string;
  readonly serverId: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;

  readonly source: 'mcp';
  readonly locality: 'local' | 'cloud';
  readonly origin: {
    readonly providerId: string;
    readonly transport: McpTransportKind;
  };

  readonly riskLevel: 'L1_safe' | 'L2_read' | 'L3_network' | 'L4_write' | 'L5_destructive' | 'unknown';
  readonly visibility: 'visible' | 'hidden' | 'policy_disabled';
  readonly permissionMode: 'disabled' | 'ask' | 'allow_if_rule_matches';
}
```

### 4. IPC / clientApi

Renderer 通过 preload 暴露的 `clientApi.mcp` 调用 main process：

```ts
export interface McpClientApi {
  listLocalServers(): Promise<readonly LocalMcpServerView[]>;
  getLocalServer(id: string): Promise<LocalMcpServerView>;

  addLocalServer(input: AddLocalMcpServerInput): Promise<LocalMcpServerView>;
  updateLocalServer(id: string, patch: UpdateLocalMcpServerInput): Promise<LocalMcpServerView>;
  removeLocalServer(id: string): Promise<void>;

  setLocalServerEnabled(id: string, enabled: boolean): Promise<LocalMcpServerView>;

  testLocalServer(inputOrId: AddLocalMcpServerInput | string): Promise<McpHealthCheckResult>;
  refreshLocalServerManifest(id: string): Promise<McpManifestRefreshResult>;

  listLocalTools(serverId?: string): Promise<readonly McpToolSummary[]>;
  setLocalToolVisibility(toolId: string, visibility: 'visible' | 'hidden'): Promise<void>;

  getDiagnostics(serverId?: string): Promise<McpDiagnostics>;

  listCloudCatalog(): Promise<readonly CloudMcpCatalogItem[]>;
  startCloudConnection(providerId: string): Promise<CloudMcpConnectionStartResult>;
  disconnectCloudConnection(connectionId: string): Promise<void>;
  setCloudMcpEnabled(providerId: string, enabled: boolean): Promise<void>;
}
```

MVP 可以先实现 Local MCP 方法，Cloud MCP 方法可以保留协议草案或返回
`not_implemented`，但 UI 不能伪装为已支持。

## Storage Decision

### 1. Local MCP Registry

Local MCP registry 是 main process 管理的本地事实源，存储在 Electron `userData`
下。推荐路径：

```text
<userData>/mcp/servers.json
<userData>/mcp/manifest-cache.json
<userData>/mcp/diagnostics.jsonl
```

或后续收敛到统一 Capability / Plugin registry。无论路径如何，renderer 不得直接读写。

`servers.json` 保存配置与 secret refs，不保存 secret 明文：

```json
{
  "version": 1,
  "servers": [
    {
      "id": "local-mcp-filesystem",
      "displayName": "Filesystem MCP",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
      "cwd": null,
      "envSecretRefs": {},
      "permissionProfile": "ask_every_time",
      "visibilityDefaults": "disabled_by_default",
      "createdAt": "2026-06-15T00:00:00.000Z",
      "updatedAt": "2026-06-15T00:00:00.000Z"
    }
  ]
}
```

### 2. Secret Storage

- Secret 明文只能在 main process 内短暂存在。
- Registry 中只保存 `secretRef`。
- `secretRef` 由 safeStorage / OS keychain / 未来组织 secret provider 解析。
- Renderer view 只显示 `hasSecret: true`、`secretName` 或脱敏占位，不返回 secret 值。
- 导出配置默认不导出 secret；导入时必须重新绑定 secret。

### 3. Manifest Cache

Manifest cache 是 discovery 的结果缓存，不是执行证据，也不是权限事实源。

缓存项至少包含：

```ts
interface LocalMcpManifestCacheEntry {
  readonly serverId: string;
  readonly discoveredAt: string;
  readonly protocolVersion?: string;
  readonly tools: readonly McpToolSummary[];
  readonly resources?: readonly unknown[];
  readonly prompts?: readonly unknown[];
  readonly errors?: readonly McpDiscoveryError[];
}
```

修改 server 配置、启用状态、secret 绑定或 policy 后，必须重新计算可见能力并重新发布
Runtime Projection。

## Manifest Decision

Local MCP tool 归一为 `CapabilityManifest` 时必须携带来源、运行位置和 origin：

```json
{
  "source": "mcp",
  "locality": "local",
  "capabilityId": "mcp.local.local-mcp-filesystem.filesystem.read_file",
  "displayName": "read_file",
  "description": "Read a file from the allowed filesystem root.",
  "inputSchema": {},
  "origin": {
    "providerId": "local-mcp-filesystem",
    "transport": "stdio",
    "toolName": "read_file"
  },
  "riskLevel": "L2_read"
}
```

规则：

- MCP tool name 不直接等同于全局 `capabilityId`。
- `capabilityId` 必须稳定、可审计、避免跨 server 冲突。
- MCP tool description 只是 Manifest 元数据，不是 system instruction。
- MCP resources/prompts 不自动进入 System Context。
- 只有通过 visibility + policy + Runtime Projection 的能力才可被 Agent 看见。
- 被 disabled、policy disabled、untrusted、health failed 的 capability 不得进入 projection。

## Runtime Projection Decision

MCP 设置页中的工具可见性影响 Runtime Projection 的输入，但不是 projection 本身。

Projection 构建时至少合并：

```text
Cloud policy
  + 用户/工作区 MCP visibility
  + Local MCP enabled/health/trust state
  + Manifest cache
  + Gateway session capability availability
  -> Runtime Projection
```

Projection guard 仍由 Runtime Gateway Client / Local Tool Host 执行：

1. `sessionId` 必须匹配当前客户端 session。
2. `projectionId` 必须匹配当前 accepted projection。
3. `capabilityId` 必须命中 projection capability 列表。
4. disabled / policy disabled / untrusted capability 不执行。
5. 本地 MCP server 不健康或配置变化导致 manifest 失效时不执行。

当 MCP 配置、工具可见性、policy、健康状态发生变化时，客户端必须重新发布或刷新
Runtime Projection。不能只改 renderer state。

## Execution Decision

Local MCP tool call 只允许经过既有本地执行主链路：

```text
client_tool_call.request
  -> Runtime Gateway Client projection guard
    -> Local Tool Host
      -> Capability Provider Registry
        -> LocalMcpProviderAdapter.execute(capabilityId, arguments)
          -> PermissionReview
            -> LocalMcpTransportHost.toolsCall(serverId, toolName, arguments)
              -> ClientToolResult
                -> Evidence
                  -> client_tool_call.result
```

禁止：

- Renderer 调用 `clientApi.mcp.callTool` 作为 Agent 执行路径。
- Cloud Runtime 直接访问用户本地 MCP endpoint。
- Local MCP Provider 绕过 PermissionReview。
- Local MCP Provider 返回 assistant 文本代替 `ClientToolResult`。
- MCP server 自己写 cloud memory、business ontology 或 execution ledger。

设置页中的 `测试连接` 和 `刷新 Manifest` 是管理操作，不是 Agent tool execution。它们可以写入
diagnostics / health record，但不得伪装成对话中的 Tool Result 或 Evidence。

## Permission Decision

MCP 有两层用户控制：

1. **Visibility**：是否允许 tool 进入本地工具面 / Runtime Projection。
2. **PermissionGrant**：某次具体 tool call 是否允许执行。

Visibility 不是 PermissionGrant。即使 tool visible，也必须在执行时经过 PermissionReview。

默认策略：

| Risk | Default visibility | Default permission |
|---|---|---|
| `L1_safe` | visible if server trusted | ask or allow by explicit rule |
| `L2_read` | user choice / readonly visible profile | ask or allow by scoped rule |
| `L3_network` | hidden by default | ask |
| `L4_write` | hidden by default | ask |
| `L5_destructive` | hidden or policy disabled | deny unless future explicit high-risk flow exists |
| `unknown` | hidden by default | ask / deny by policy |

Permission rules for MCP must be scoped at least by：

- workspace / personal scope。
- serverId。
- toolName / capabilityId。
- riskLevel upper bound。
- optional argument constraints。
- expiry or review policy。

Renderer 不得直接写 PermissionRule raw store。所有“始终允许”或“允许只读工具”都必须通过
PermissionReview 的正式入口写入，且必须能被 Evidence 引用。

## Evidence Decision

每次 Agent 触发的 Local MCP tool execution 必须产生 Evidence。Evidence 至少包含：

```ts
interface LocalMcpToolEvidence {
  readonly evidenceKind: 'local_mcp_tool_call';
  readonly providerId: string;
  readonly serverId: string;
  readonly transport: McpTransportKind;
  readonly capabilityId: string;
  readonly toolName: string;

  readonly startedAt: string;
  readonly endedAt: string;
  readonly status: 'success' | 'failed' | 'denied' | 'timeout' | 'cancelled';

  readonly permissionGrantId?: string;
  readonly projectionId: string;
  readonly toolCallId: string;
  readonly conversationId: string;

  readonly inputPreview?: unknown;
  readonly outputPreview?: unknown;
  readonly errorPreview?: string;
  readonly artifactRefs?: readonly string[];
}
```

要求：

- 输入输出 preview 必须脱敏和截断。
- 大输出写入 artifact，云端只拿 preview 和 artifact refs。
- 失败、拒绝、超时、取消也要形成标准 `ClientToolResult` 和 Evidence。
- Evidence 不保存 secret 明文。
- Evidence 不由 renderer state 或 assistant 文本替代。

## Cloud MCP Decision

Cloud MCP 是后续阶段，但本 ADR 先固定边界，避免 Local MCP MVP 设计把 Cloud MCP 卡死。

Cloud MCP 特征：

- 运行在云端 Runtime 或可信服务环境。
- 凭据与 OAuth connection 由云端或组织级 connection manager 管理。
- 产生 Cloud-side Evidence。
- 可以进入 Runtime Projection，但不通过本地 `client_tool_call` 执行。

桌面设置页对 Cloud MCP 的职责：

- 展示 catalog。
- 展示授权状态。
- 发起 OAuth / connection flow。
- 展示 scopes 和组织 policy。
- 控制用户是否希望启用到个人工具面。

桌面设置页不得：

- 保存 cloud OAuth token 明文。
- 把 Cloud MCP 当作 Local MCP server 连接。
- 通过 Local Tool Host 执行 Cloud MCP tool。

## Failure Semantics

### 1. Health Check Failure

`testLocalServer` 失败时返回结构化错误：

```ts
interface McpHealthCheckResult {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly phase: 'spawn' | 'connect' | 'initialize' | 'list_tools' | 'shutdown';
  readonly message: string;
  readonly detailsPreview?: string;
}
```

常见错误：

- command not found。
- process exited before initialize。
- initialize timeout。
- tools/list timeout。
- invalid JSON-RPC response。
- protocol version mismatch。
- permission denied launching process。

### 2. Runtime Failure

Agent tool execution 失败必须映射为标准 `ClientToolResult`：

- `denied`：PermissionReview 拒绝。
- `failed`：MCP server 错误或协议错误。
- `timeout`：调用超时。
- `cancelled`：用户或 runtime 取消。

Gateway 已 ack 的调用必须有最终 result；不能只发送 `runtime.error`。

### 3. Config Drift

如果 server 配置在 tool call 入队后发生变化：

- Local Tool Host 必须重新检查 projection 与 capability availability。
- 如果 capability 已不可用，返回 `failed` 或 `denied` 的标准 result。
- Evidence 中记录 drift 原因。

## Security Decision

安全约束：

- Renderer 不直接使用 `fs`、`child_process`、MCP transport、secret storage。
- Local MCP stdio 启动必须有 allowlist / explicit user config / future policy guard。
- `command` 和 `args` 不经过 shell 拼接，必须使用 argv 形式启动。
- `cwd` 必须规范化，禁止 UI 文本直接作为 shell 命令。
- env/header secret 只通过 secretRef 注入。
- 日志、diagnostics、Evidence 必须脱敏。
- 删除 server 默认不删除历史 Evidence。
- 导入 registry 必须默认 disabled，直到用户确认。
- 远程 HTTP/SSE MCP 默认禁用，直到后续 ADR 明确 TLS、OAuth、CORS、proxy、policy 边界。

## System Context Decision

MCP 不获得 system prompt 注入特权。

- MCP tool description 是 Manifest 元数据，可作为 tool schema 描述提供给模型。
- MCP resources 是 factual/user context，只能通过明确的资源读取工具或附件/上下文准入机制进入对话。
- MCP prompts 如果未来支持，必须作为受限 Context Source 或用户可见模板进入，不能直接拼接 system prompt。
- Compact summary 不替代 MCP Tool Result、Evidence 或 artifact refs。

## SettingsPage Integration

当前 `SettingsPage` 是设置入口的单一表达层。新增 MCP 分区时继续保持该边界：

```tsx
type SettingsSection = 'general' | 'model' | 'instructions' | 'mcp' | 'appearance';
```

菜单项：

```tsx
const localizedSettingsLabels =
  i18n.locale === 'en-US'
    ? {
        model: 'Model configuration',
        instructions: 'System instructions',
        mcp: 'MCP Connections',
      }
    : {
        model: '模型配置',
        instructions: '系统指令',
        mcp: 'MCP 连接',
      };
```

渲染：

```tsx
section === 'mcp' ? (
  <McpSettingsPanel i18n={i18n} />
) : ...
```

`McpSettingsPanel` 不承载能力执行，只通过 `clientApi.mcp.*` 读写受控 view model。

## Migration / Compatibility

第一版没有历史 MCP 配置，因此无需复杂迁移。

后续如果 registry schema 变化：

- registry 必须带 `version`。
- migration 在 main process 执行。
- migration 失败时保留原文件并返回诊断错误，不让 renderer 自行修复。
- 不认识的 transport 默认 disabled。
- 不认识的 permission profile 默认 `ask_every_time` 或 `disabled`。

## Implementation Plan

### Phase 1: ADR + UI Skeleton

- 新增本 ADR。
- 设置页新增 `MCP 连接` 菜单。
- 新增 `McpSettingsPanel` 空状态和静态分区。
- Cloud MCP 显示“即将支持”或受控占位。
- 不实现真实 MCP transport。

### Phase 2: Local MCP Registry CRUD

- 在 `packages/protocol/src` 增加 MCP 设置协议类型。
- 在 preload 增加 `clientApi.mcp`。
- 在 main 增加 MCP IPC handlers。
- 增加 `LocalMcpRegistryStore`。
- UI 支持添加 / 编辑 / 删除 / 启用 / 禁用 stdio MCP。
- 保存 secret refs，不保存 secret 明文。

### Phase 3: Health Check + Discovery

- 增加 `LocalMcpTransportHost`。
- 支持 stdio process lifecycle。
- 实现 initialize / tools.list。
- 写入 manifest cache。
- UI 展示 tools、health、last error。

### Phase 4: Manifest + Runtime Projection

- 增加 `LocalMcpManifestProjector`。
- 把 MCP tools 转成 `CapabilityManifest`。
- 注册进 `CapabilityProviderRegistry`。
- MCP 配置变化触发 projection 刷新。
- UI 的 visibility 设置进入 projection 输入。

### Phase 5: Execution + Permission + Evidence

- 增加 `LocalMcpProviderAdapter.execute()`。
- Tool call 经 Local Tool Host 路由。
- 执行前进入 PermissionReview。
- 执行后生成 `ClientToolResult` 与 Evidence。
- 支持失败、拒绝、超时、取消。

### Phase 6: Cloud MCP

- 增加 Cloud MCP catalog 展示。
- 增加 OAuth / connection flow。
- 云端凭据与执行保持 cloud-side。
- Cloud MCP capability 进入 Runtime Projection，但不进入 local runtime channel。

## Alternatives Considered

### Alternative A: 把 MCP 配置放进模型配置页

拒绝。模型配置管理 LLM provider 和鉴权，MCP 是能力接入。混在一起会让用户误以为 MCP
改变模型能力或 provider 请求格式，也会让代码边界从 provider settings 扩散到 capability
runtime。

### Alternative B: Renderer 直接启动 MCP stdio 进程

拒绝。Renderer 不能直接使用 `child_process`，也不能成为权限、进程生命周期、Evidence
事实源。这样会绕过 Local Tool Host、PermissionReview 和 Evidence。

### Alternative C: 添加 MCP 后直接把 tools 注入 system prompt

拒绝。MCP tool description 应作为 Manifest/tool schema，不是 system instruction。
资源正文和 prompt 模板也不能绕过 Context Source 与上下文准入。

### Alternative D: 把所有 MCP 都当作 Plugin

拒绝。MCP 是协议，Plugin 是本地能力包。Plugin 可以携带 MCP server 配置，但 MCP server
本身仍要以 MCP Provider Adapter 归一为 Manifest。把两者混淆会破坏 Skill / Plugin / MCP
对象边界。

### Alternative E: 本地 MCP 通过云端直接连接 localhost

拒绝。云端不能直接访问本地端口。本地 MCP 只能通过客户端 outbound Gateway session 接收
`client_tool_call`，并在本地授权后执行。

## Consequences

正向影响：

- 用户有清晰的 MCP 接入入口。
- Local MCP 与 Cloud MCP 边界明确。
- 设置页不会膨胀成能力执行层。
- MCP 可以复用既有 Provider / Manifest / Projection / Permission / Evidence 治理链路。
- 后续 Plugin、Skill dependency、Cloud MCP Catalog 有稳定扩展点。

代价：

- MVP 需要先建立 protocol、IPC、registry、transport、manifest adapter 等模块，不能只做 UI。
- 用户看到的“工具可见性”和“执行授权”需要清晰文案解释。
- MCP discovery 与 execution 分离会增加实现阶段数，但这是防止旁路能力的必要成本。

## Acceptance Criteria

设计与实现可接受条件：

1. 设置页存在 `MCP 连接 / MCP Connections` 独立菜单。
2. Renderer 不直接访问 filesystem、child_process、MCP transport 或 secret storage。
3. Local MCP 配置事实源在 main process 管理的 registry。
4. Secret 明文不出 main process。
5. Local MCP tools 必须转成 `CapabilityManifest`，带 `source: 'mcp'`、`locality: 'local'`、`origin`。
6. Agent 只能看到 Runtime Projection 允许的 MCP capabilities。
7. Local MCP tool call 必须经 Local Tool Host 和 Capability Provider Registry。
8. 每次 Local MCP tool execution 必须经 PermissionReview。
9. 每次 Local MCP tool execution 必须产生 Evidence，失败/拒绝/超时也要有标准 result。
10. Cloud MCP 不通过本地 runtime channel 执行。
11. MCP resources/prompts 不直接拼入 system prompt。
12. 修改 MCP 配置、visibility、policy 或 health 后必须刷新 projection 输入。
13. 设置页的健康检查和 Manifest 刷新不能伪装成 Agent tool execution。
14. 文档 `15-plugin-skill-mcp-system.md` 与 `16-skill-call-lifecycle.md` 的主链路约束继续成立。
