# Peer Agent 工程结构设计

> 状态：工程结构草案  
> 目标：定义 Peer Agent 的仓库组织、模块边界和第一阶段落地路径。

---

## 一、推荐仓库结构

```text
peer_agent/
├── apps/
│   └── desktop/
│       ├── electron/
│       │   ├── main/
│       │   └── preload/
│       └── renderer/
│           ├── app/
│           ├── features/
│           ├── components/
│           └── styles/
├── packages/
│   ├── protocol/
│   ├── i18n/
│   ├── chat-kernel/
│   ├── task-thread/
│   └── ui/
├── crates/
│   └── cu-proxy-core/
├── docs/
│   └── architecture/
│       ├── 00-engineering-philosophy.md
│       ├── 01-project-structure.md
│       ├── 02-i18n-architecture.md
│       └── 03-codex-app-reference-architecture.md
├── package.json
├── pnpm-workspace.yaml
└── Cargo.toml
```

---

## 二、模块职责

### 2.1 `apps/desktop`

Electron 桌面客户端。

职责：

- 窗口、托盘、快捷键。
- 本地 session store。
- 本地 capability registry。
- 本地 project index。
- 安全 IPC 边界。
- Rust core adapter。
- Codex-like task thread。
- Sidebar / Header / Composer。
- Review card。
- Evidence summary。
- 设置入口。

限制：

- Renderer 不允许直接读写文件。
- Renderer 不允许直接启动命令。
- Renderer 不允许直接连接 MCP。
- Renderer 不保存密钥。
- Renderer 不成为权限事实源。

### 2.2 `packages/protocol`

端云和端内共享契约。

第一阶段对象：

```text
LocalAccessLevel
CapabilityManifest
RuntimeProjection
ClientToolCall
ClientToolResult
PermissionGrant
Evidence
AuditEvent
ClientSessionState
ClientBootstrap
LocaleCode
LocalizedText
```

这个包是工程的第一优先级。所有 UI、Electron main、Rust core、云端 gateway 未来都应该围绕这些对象对齐。

### 2.3 `packages/i18n`

客户端国际化边界。

职责：

- locale 解析。
- 中英文资源。
- 术语边界。
- capability name / description 本地化。
- UI 和 task thread 的共享文案。

原则：

```text
中文优先表达业务语义。
英文保留工程对象语义。
locale 必须来自 session，不由组件各自猜测。
```

### 2.4 `packages/chat-kernel`

对话内核，不绑定具体 UI。

职责：

- Chat Stream client。
- message model。
- quote / attachment / artifact model。
- thinking / tool event model。
- SSE event 解析。

这个包可以吸收现有 Web `module-ai-chat-flow` 的协议经验，但不能直接复制 Web 页面。

### 2.5 `packages/task-thread`

任务线程状态和渲染编排。

职责：

- thread event reducer。
- user / assistant / tool / review / evidence / artifact 的线程事件模型。
- Composer 状态。
- Review card 状态。
- 线程恢复和本地缓存策略。
- 从 `ClientSessionState + CapabilityManifest` 派生任务线程。
- 按 session locale 生成任务文案。

这个包让 UI 不直接理解底层工具协议，而是消费运行态事件。

Codex.app 参考下，`task-thread` 是客户端最核心的产品内核：

- 线程事件是运行态账本。
- Tool call、Review、Evidence、Artifact 都必须进入线程。
- 权限中心、能力中心、诊断中心默认通过线程事件或按需抽屉进入，不做首屏常驻管理页。

### 2.6 `packages/ui`

客户端基础 UI 组件。

职责：

- Button、Input、Popover、Sheet。
- Card、AttachmentCard、ToolCallCard、ReviewCard。
- StatusBadge、AccessLevelSelect。
- 设计 token。
- 中英文基础控件文案。

原则：

```text
UI 组件可以复用品牌和基础体验。
业务运行态语义不要下沉到纯 UI 组件里。
```

### 2.7 `crates/cu-proxy-core`

本地能力核心。

第一阶段只做最小本地核心：

- health capability。
- local session state。
- permission / evidence 只保留协议入口，真实任务到达前不在 UI 中伪造执行事件。

后续再进入：

- Manifest registry。
- Permission enforcement。
- Tool router。
- MCP manager。
- Plugin host。
- Evidence collector。
- Local memory store。
- Audit ledger。
- Cloud capability session。

原则：

```text
Rust Core 只在本地能力真的需要高信任执行时变厚。
不要为了架构完整感提前堆实现。
```

---

## 三、运行时边界

第一阶段运行时：

```text
Renderer
  → preload typed API
    → Electron main
      → local core adapter
        → Rust cu-proxy-core health stub
```

后续混合运行时：

```text
Cloud CEO Agent Runtime
  → Client Gateway
    → outbound client session
      → Rust CU Proxy Core
        → Electron Review card
          → user approval
            → local tool execution
              → Evidence
                → Cloud Ledger
```

边界规则：

- Cloud 不直接访问本地端口。
- Rust Core 主动维持 cloud session。
- Electron Renderer 只展示和请求，不执行高权限能力。
- Electron Main 只做桌面胶水和安全 IPC 转发。
- 本地工具必须进入 Manifest / Projection / ToolCall / Evidence 主链路。

---

## 四、第一阶段实现范围

### 4.1 必须有

- Monorepo 初始化。
- Electron desktop app。
- React task thread。
- Sidebar：New task、Search、Plugins、Automations、Pinned、Projects、Settings。
- Composer：`+`、local access level、model selector、input、send。
- Review card contract flow。
- Tool call card contract flow。
- Evidence summary contract flow。
- `bootstrap:get` IPC。
- `zh-CN` / `en-US` i18n scaffold。
- Electron main capability registry，来源于 `capabilities/*.json`。
- Electron main project index，来源于 workspace/package/git status。
- Electron main local session store。
- `packages/protocol` 类型。
- `crates/cu-proxy-core` health stub。

### 4.2 暂缓

- 真实文件读写。
- 真实 MCP lifecycle。
- Plugin 安装和签名。
- 云端 client gateway。
- 个人经验存储。
- 任意命令执行。
- 完整 SDK。

### 4.3 验收标准

第一阶段完成时，应该能在本地看到一个可运行客户端：

```text
用户输入任务
  → 线程中出现 assistant work summary
    → 出现 local health tool call card
      → 出现 Review card
        → 用户确认
          → Rust health stub 返回 result
            → 线程展示 Evidence summary
```

即使没有真实云端 Agent，也要先把交互和契约骨架跑通。

---

## 五、禁止事项

第一阶段禁止：

- Renderer 直接调用 `fs`。
- Renderer 直接调用 `child_process`。
- IPC 传任意命令字符串。
- 用 Node main 实现本地能力核心。
- 把 Plugin / MCP 做成 UI 内部状态。
- 把权限授权只存在前端 store。
- 把本地个人经验塞进普通 chat context。
- 把客户端描述成本地 Agent。

这些禁止项不是洁癖，而是为了防止工程从第一天就偏离端云能力代理设计原则。
