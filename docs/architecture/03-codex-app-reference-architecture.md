# Codex.app 参考架构

> 状态：产品与工程架构基准  
> 目标：用 Codex.app 的任务型桌面产品形态约束 Zeus Atlas，避免退化成后台管理系统、普通聊天壳或本地工具集合。

---

## 一、采用 Codex.app 的原因

Zeus Atlas 要解决的不是“把 Web 小二搬到桌面”，而是让云端 CEO Agent Runtime 可以在客户端场景里可靠调用本地能力。

因此客户端形态应该更接近 Codex.app：

```text
任务索引
  + 任务线程
  + Composer
  + 工具执行事件
  + 权限 Review
  + Evidence / Artifact
```

而不是：

```text
左侧导航
  + 多个管理页
  + 表单配置
  + 独立权限中心
  + 独立插件中心
  + 独立审计后台
```

Codex.app 值得借鉴的不是视觉皮肤，而是它把 Agent 执行过程组织成“线程里的可解释事件流”。

---

## 二、可借鉴的产品骨架

### 2.1 Shell

```text
App Shell
  ├── Sidebar
  │   ├── New task
  │   ├── Search
  │   ├── Plugins
  │   ├── Automations
  │   ├── Pinned
  │   └── Projects
  ├── Task Header
  │   ├── 当前任务
  │   ├── Agent / Runtime 状态
  │   ├── Hybrid / Cloud Only
  │   └── 诊断入口
  ├── Task Thread
  │   ├── User message
  │   ├── Agent reasoning summary
  │   ├── Tool call card
  │   ├── Review card
  │   ├── Evidence summary
  │   └── Artifact card
  └── Composer
      ├── Context chips
      ├── Attachment / Reference
      ├── Local access level
      ├── Command entry
      └── Model / Agent selector
```

设计约束：

- 任务线程是主界面。
- 工具执行是线程里的事件，不是单独页面。
- 权限确认是阻塞事件，不是设置页里的开关。
- Evidence 是结果的一部分，不是事后审计报表。
- Plugins / MCP / Automations 可以出现在 Sidebar，但它们不应该把主界面变成后台。

---

## 三、Zeus Atlas 的差异

Codex.app 可以作为交互参考，但 Zeus Atlas 不是代码执行器，也不是本地 Agent。

Zeus Atlas 的差异：

| 维度 | Codex.app 参考 | Zeus Atlas 约束 |
|---|---|---|
| 认知来源 | Agent task runtime | Cloud CEO Agent Runtime |
| 本地执行 | 本地 workspace / tool | Local Capability Runtime |
| 工具暴露 | work locally / tools | Manifest / Runtime Projection |
| 权限确认 | hooks / access review | PermissionGrant + policy gates |
| 结果解释 | task output / patch / artifact | Evidence + audit event |
| 个人上下文 | project / local work | 云端为准，个人为辅 |
| 业务治理 | product-level safety | 组织策略 + 云端治理 + 本地授权 |

所以 Zeus Atlas 的产品气质可以像 Codex.app，但运行时对象必须是 Zeus OS 的对象。

---

## 四、运行时主链路

第一阶段和后续完整态都围绕同一条主链路扩展：

```text
User intent
  → Composer context
    → Cloud CEO Agent Runtime
      → Capability selection
        → Runtime Projection
          → Client Tool Call
            → Task Thread event
              → Review card
                → PermissionGrant
                  → Local Capability Runtime
                    → Tool Result
                      → Evidence
                        → Task Thread
                          → Cloud Ledger
```

关键原则：

- Cloud 负责为什么做、做什么、选择哪个能力。
- Client 负责本地是否存在、是否授权、如何执行、返回什么证据。
- UI 负责把每一步变成用户能理解、能确认、能回放的事件。
- 所有本地能力都必须经过 `Capability Provider → Manifest → Runtime Projection → Tool Call → Evidence`。

---

## 五、核心领域对象

参考 Codex.app 后，Zeus Atlas 应该固定以下领域对象：

```text
Workspace
Project
TaskThread
ThreadEvent
ComposerContext
RuntimeSession
CapabilityManifest
RuntimeProjection
ClientToolCall
ReviewRequest
PermissionGrant
ClientToolResult
Evidence
Artifact
AuditEvent
DiagnosticSnapshot
```

对象职责：

- `Workspace`：当前客户端工作区，不等于云端业务空间。
- `Project`：任务索引和上下文聚合单位。
- `TaskThread`：用户看到的主运行态。
- `ThreadEvent`：消息、工具、Review、Evidence、Artifact 的统一事件。
- `ComposerContext`：本次任务允许带入的上下文和本地访问级别。
- `RuntimeSession`：端云会话事实源。
- `CapabilityManifest`：本地能力声明。
- `RuntimeProjection`：云端本次可以看见和选择的能力视图。
- `ReviewRequest`：需要用户确认的本地动作集合。
- `PermissionGrant`：本地授权事实。
- `Evidence`：执行证据和治理对象。

---

## 六、状态分层

Zeus Atlas 不能把所有状态放进 React store。

建议分层：

```text
Cloud state
  → agent plan
  → policy
  → projection
  → cloud ledger

Electron main state
  → window/session
  → local bootstrap
  → capability registry snapshot
  → permission request bridge

Rust core state
  → high-trust local execution
  → permission enforcement
  → MCP/plugin process lifecycle
  → evidence collection
  → local audit ledger

Renderer state
  → task thread view model
  → composer draft
  → selected context chips
  → transient UI state
```

边界：

- Renderer 可以展示 Review card，但不是权限事实源。
- Electron main 可以做 IPC 和桌面胶水，但不成为本地能力核心。
- Rust core 承担高信任本地执行。
- Cloud Runtime 不假装直接拥有用户机器。

---

## 七、界面规则

采用 Codex.app 风格时，必须守住这些规则：

- 默认单主界面：Task thread。
- Sidebar 只做索引和入口，不承载复杂管理表单。
- Composer 是上下文控制台，不只是输入框。
- 工具执行卡片必须留在线程里。
- 本地能力审批必须在任务发生处确认。
- 右侧面板只作为按需抽屉，不常驻三栏。
- 设置、插件、MCP、诊断可以打开为 modal / sheet / detail route，但不抢主任务流。

这意味着：

```text
能力中心、权限中心、MCP 中心、审计中心
```

不应该成为首屏常驻导航的主要工作区。它们应该是任务流里的辅助入口。

---

## 八、不能照搬 Codex.app 的部分

不能照搬：

- 把本地 workspace 当成唯一运行世界。
- 把 shell / bash 作为默认核心能力。
- 把代码 diff / patch 作为所有任务的默认结果形态。
- 把本地项目历史直接当成云端认知更新。
- 把插件和工具调用绕过 Manifest / Projection / Evidence。

Zeus Atlas 的本地能力更泛化，目标用户也不只写代码。因此必须保持：

```text
云端为准，个人为辅。
协议先于 SDK。
Evidence 先于最终解释。
权限前门先于能力扩展。
```

---

## 九、落地顺序

### Phase 0：当前最小骨架

- Electron shell。
- Task thread。
- Composer。
- `ClientBootstrap`。
- `local.health`。
- Review card。
- Evidence summary。
- `zh-CN` / `en-US`。

### Phase 1：Codex-like 任务内核

- `TaskThread` 持久化。
- `ThreadEvent` reducer。
- Composer context chips。
- Artifact model。
- Search / pinned / project index。
- 任务恢复。

### Phase 2：端云能力主链路

- `RuntimeProjection`。
- `ReviewRequest`。
- `PermissionGrant` enforcement。
- Evidence collector。
- Local audit ledger。

### Phase 3：本地能力生态

- Plugin package manifest。
- MCP stdio manager。
- Streamable HTTP provider。
- Capability Provider SDK。
- 诊断和健康检查。

### Phase 4：云端 Gateway

- outbound client session。
- `client_tool_call` 接收。
- tool result / evidence return。
- policy gates。
- cloud ledger。

### Phase 5：组织级治理

- 组织策略。
- 业务 overlay。
- 用户偏好。
- 个人经验显式提交和审核。
- 审计检索。

---

## 十、第一性验收问题

每个版本都用这几个问题验收：

1. 用户是否能在一个任务线程里理解 Agent 为什么请求本地能力？
2. 用户是否能在执行前看清 tool、scope、data、duration？
3. 本地执行是否一定通过 Manifest / Projection / Permission / Evidence？
4. Evidence 是否可回放、可审计、可选择性回云？
5. UI 是否仍然是任务流产品，而不是管理后台？
6. 个人经验是否仍然默认留在本地？

如果这些问题有任意一个退化，就说明架构偏离了 Codex.app 参考形态或端云能力代理设计原则。
