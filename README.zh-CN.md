<p align="center">
  <img src="docs/logo.png" alt="Peer Agent" width="120" />
</p>

<h1 align="center">Peer Agent</h1>

<p align="center">
  <strong>完全开源的本地任务流 Agent —— 以任务的流转、继承与追问，在你的机器上授权、规划、并用证据收尾。</strong>
</p>

<p align="center">
  完全开源（MIT）· 本地优先 · 权限门控 · 证据可追溯 · 默认任务流
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://github.com/ly-ccx/Peer-Agent/stargazers"><img src="https://img.shields.io/github/stars/ly-ccx/Peer-Agent?style=for-the-badge&logo=github&label=Stars" alt="GitHub Stars" /></a>
  <a href="https://www.npmjs.com/package/@peer-agent/cli"><img src="https://img.shields.io/npm/v/@peer-agent/cli?style=for-the-badge&logo=npm&label=npm%20%40peer-agent%2Fcli" alt="npm version" /></a>
  <a href="https://github.com/ly-ccx/Peer-Agent/releases"><img src="https://img.shields.io/github/v/release/ly-ccx/Peer-Agent?include_prereleases&style=for-the-badge&label=Release" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#-快速开始">快速开始</a> ·
  <a href="#-为什么选-peer-agent">为什么</a> ·
  <a href="#-设计哲学">设计哲学</a> ·
  <a href="#-任务流流转继承追问">任务流</a> ·
  <a href="#-你能做什么">功能</a> ·
  <a href="#-架构一览">架构</a> ·
  <a href="#-产品愿景">愿景</a> ·
  <a href="#-路线图">路线图</a>
</p>

---

今天很多 coding agent 的工具本身就已经在本地跑了。只谈「本地执行」已经不够构成差异。

**Peer Agent 是完全开源（MIT）的** —— 不是「核心闭源 + 插件开源」的混合体：从 Desktop、TUI、CLI 到运行时、协议与能力清单，整条链路都在 [LICENSE](LICENSE) 之下。你可以审计每一行授权代码，fork 出自己的分支，或把运行时嵌进你自己的宿主。

**Peer Agent 关心的是本地执行之后的事：** 目标如何被签收与设边界，歧义如何被澄清而不是默默猜测，工作如何按复杂度规划，完成如何用 Evidence 证明 —— 并在 Desktop / TUI / CLI 上共享同一条受治理的能力链。

三种一等入口，共享同一套统一核心运行时：

| 入口 | 是什么 |
| --- | --- |
| **Desktop** | 任务线程、输入框、审阅卡片、Workbench、托盘 |
| **TUI** | 终端完整 Agent（`peer`），同一套运行时 |
| **CLI** | 可安装的 `@peer-agent/cli` —— 脚本化进入同一台机器 |

> [!NOTE]
> 当前正式版：**`0.0.4`**（npm `latest`），beta 通道 **`0.0.4-beta.4`**。Desktop、TUI/CLI、Agent/Plan/Goal 工作流、Automation、MCP、Skills 与 Open Runtime 现已可用 —— 见 [路线图](#-路线图)。

---

## ✨ 为什么选 Peer Agent

| | |
| --- | --- |
| 📜 **完全开源（MIT）** | 整条链路 —— Desktop、TUI、CLI、运行时、协议与能力清单 —— 都在同一 MIT 许可下；可审计、可 fork、可嵌入，没有「开源壳 + 闭源核」。 |
| 🎯 **任务流，而不是工具聊天** | 目标带着边界被签收，需要时澄清，按复杂度规划，并对照明确成功标准关闭。 |
| ✅ **可执行成功标准（DoD-as-Code）** | `successCriteria`、`criterionResults` 与 `evidenceRefs` 把「完成」变成可验证闸门，而不是助手自称做完。 |
| 🔒 **本地执行，信任显式** | 工具在*你的*机器上经 `PermissionGrant` 执行。认知可来自你选择的模型服务商 —— 能力权力仍留在本地且可审计。 |
| 🔐 **系统钥匙串 + 加密密钥库** | OS 钥匙串只保存 vault 主密钥；Provider API Key 与 OAuth token 进入本地 AES-256-GCM 加密 vault，不落明文设置。 |
| 🌐 **模型与 Provider 自由** | 官方 API、OAuth/订阅、Coding Plan，或自定义 OpenAI / Anthropic-compatible 端点都能接；`baseUrl`、模型 ID 与能力元数据由你配置。 |
| 🧑‍🏫 **师徒式模型协作** | 你选的主模型负责推理；它不能看图时，可让兜底多模态模型先识图，再把文字结果静默交回主模型继续任务。 |
| 🧾 **Evidence 是一等结果** | 产物、日志、元数据、拒绝、超时与失败都保留为结构化事实，供界面与自动化检查。 |
| 🧩 **一条受治理能力链** | Shell、文件、浏览器、MCP、插件、技能都走 Manifest → Projection → Permission → Evidence，没有暗门。 |
| 🔌 **可嵌入 Open Runtime** | 公开、宿主中立的 `protocol`、`runtime-core`、`runtime-sdk` 让其他 Node 宿主复用同一受治理运行时，不依赖 Electron。 |
| 🔁 **长任务连续性** | Goal 状态、暂停/恢复、`waiting_user`、压缩摘要、上下文 checksum 与 continuity source，让任务跨中断续跑，同时不把摘要当证据。 |
| 🖥️ **一个核心，多种表面** | Desktop、TUI 与 `peer` CLI 共享运行时、System Context 和 `~/.peer-agent` 数据；界面不会分叉执行真值。 |

---

## 🧭 设计哲学

Peer Agent 建立在清晰的职责拆分上：

| 角色 | 负责 |
| --- | --- |
| **模型** | 认知 —— 理解、规划、决定下一步。这是由你选择的模型服务商提供的*角色*。 |
| **本地运行时** | 能力 —— 在你机器上完成发现、授权、执行与 Evidence。 |
| **界面** | 表达 —— Desktop / TUI / CLI 呈现工作；不持有权限真值。 |
| **契约** | 边界 —— 协议类型、Runtime Projection，以及层间硬禁令。 |
| **证据** | 治理 —— 实际发生了什么，事后可检查。 |

尽量不违反的产品原则：

- **优雅优先** —— 能用一个清晰概念解决的，不引入两个重叠概念；拒绝会腐烂的「凑合 seam」。
- **任务优于闲聊** —— 多步工作以目标、边界与成功标准签收，而不是在对话里随手乱做。
- **卡住再问** —— 关键歧义与高风险取舍要打断确认；禁止默默猜测。
- **完成靠证明** —— Done 意味着工具结果与 Evidence，而不是一句「做完了」。
- **一条能力链** —— Shell、文件、浏览器、MCP、插件、技能都经过同一套权限 + Evidence 路径。

这些原则同时约束产品表面（Agent / Plan / Goal）与工程底线。

---

## 🧠 任务流：流转、继承、追问

Peer Agent 把多步工作当成**任务**，而不是一次自由发挥的聊天回合。任务不是聊天的装饰品，而是一等公民 —— 它有自己的目标、边界、成功标准与生命周期。

### 流转 —— 任务有自己的生命周期

一个任务从被签收到关闭，走过一条显式的链路：

```text
签收（目标+边界+成功标准）→ 澄清 → 规划（L0–L3 深度缩放）→ 执行 → 验证 → 验收关闭
```

- **规划深度随复杂度缩放**：L0 简单问答直接答；L1 小改动短计划后执行；L2 多步工作走自驱 GoalPlan（可跟踪子任务）；L3 高风险/不可逆工作先过显式 **Plan** 审阅再产生副作用。
- **Agent 是默认模式**；**Plan** 是你希望先审再做时的刹车。
- **派发-验收闭环**：任务可被派发（如云端调度执行），派发前需用户确认（同意/拒绝），派发后经历 `dispatching → acked → running → result_received` 的显式状态链；执行结果回来后先过质量自检，再进入**待用户验收**，用户验收通过才算交付 —— 不是模型自称「做完了」。
- 子任务与成功标准只在有真实工具结果与 Evidence 时关闭。

### 继承 —— 中断不是终点

真实工作会被打断：上下文会满、进程会重启、你会去吃饭。Peer Agent 把这些当成一等场景：

- **Goal 状态持久化**：计划图、子任务状态、成功标准与 Evidence 全部落盘，任务跨会话存活。
- **暂停 / 恢复 / `waiting_user`**：任务可以停在「等你回复」上，你回来后从断点继续，不丢上下文。
- **压缩摘要 + 上下文 checksum**：长任务的上下文被压缩成 continuity 摘要续跑；但摘要是**连续性上下文，不是证据** —— 关闭任务永远只认真实工具结果。
- 只读 Explorer 可以并行调查，但范围、预算与完成责任仍由主任务流统一持有。

### 追问 —— 卡住再问，而不是猜

模型缺关键信息时，Peer Agent 的规则是**先问、不猜**：

- **结构化追问**：`request_user_input` 工具带选项提问 —— 你点选，而不是敲一段话。回复会作为持久化状态转移记录在案。
- **问在该问的时候**：关键歧义、高风险取舍、缺权限才打断；日常执行不打扰。
- **追问可继承**：追问的答复属于任务本身 —— 下次恢复、下次派发时，答案还在。

任务流与能力链各管一段：任务流决定*接什么活、何时算完*；本地执行永远走同一条能力链：

```text
Capability Provider → Manifest → Runtime Projection → Tool Call → PermissionGrant → Evidence
```

能力链决定*本地权力如何授权与证明*。

---

## 🚀 你能做什么

### 📡 多渠道接入 —— 任何入口，同一台机器

工作从哪个入口进来不重要 —— 配置、权限与 Evidence 永远是同一套：

| 渠道 | 形态 |
| --- | --- |
| **界面渠道** | 🖥️ Desktop（任务线程、审阅卡片、Workbench + 内嵌 Browser）· ⌨️ TUI / `peer` CLI · ⚡ Quick Chat 全局轻量对话 |
| **模型渠道** | 官方 API · OAuth / 订阅登录 · Coding Plan 模板 · 自定义 OpenAI / Anthropic-compatible 端点 —— 可混用；模型 ID、headers、推理、视觉、缓存与价格元数据均可配置 |
| **集成渠道** | ⏰ Automation 定时 / 周期运行 · 🔌 MCP 服务器（stdio / HTTP / SSE）· 🌐 网页抓取与浏览器交互 |

> “多端统一”指同一台机器、同一用户数据目录下的 Desktop / TUI / CLI 共用配置与凭证；Peer 不宣称把密钥通过云端同步到不同设备。

### 🧩 丰富的插件化 —— 能力经同一契约拼装

- 🔌 **MCP 一等公民** —— 外部 MCP 服务器直接接入，与内置能力走同一套权限 + Evidence 管线，没有旁路
- 🏪 **插件与技能 marketplace** —— 类 marketplace 的安装、启停与更新；技能按需触发工作流
- 🧱 **声明式能力清单** —— 每个能力以 manifest 描述（权限、入口、参数），运行时统一投影为模型可见工具
- 🔌 **Open Runtime SDK** —— `@peer-agent/protocol` / `runtime-core` / `runtime-sdk` 让任何 Node 宿主嵌入同一受治理能力管线；宿主中立，不绑 Electron
- 📎 **受治理的上下文准入** —— 附件、文件与网页内容经显式准入路径进入上下文，而不是随意拼进 prompt

### 📋 任务派发与验收 —— 工作可以交出去，责任链不断

- ✅ **派发需确认** —— 任务派发（如云端调度执行）前必须经你同意/拒绝，绝不静默外发
- 🔗 **显式状态链** —— `dispatching → acked → running → result_received`，每一步可观测
- 🧪 **质量自检 + 用户验收** —— 执行结果回来先过质量自检，再进入待验收状态，你验收通过才算交付
- 🌿 **隔离运行** —— 仓库任务可在独立 Git worktree 中执行，返回 commit / diff 与回执，不污染当前工作区
- 🗣️ **圆桌协同** —— 治理模式下的多参与者会话，可随时向当前圆桌插话

### 🔐 你的模型栈与凭证，你做主

- 🔐 **一套安全凭证库** —— macOS Keychain、Windows Credential Manager 或 Linux Secret Service 托管随机 32-byte 主密钥；Provider 密钥在本地以 AES-256-GCM 加密
- 🧑‍🏫 **师徒式模型协作（主模型 + 兜底多模态）** —— 任意模型都可作为主模型；需要读图且主模型不支持时，兜底模型只负责识图，主模型继续掌握推理与任务流

### 🛡️ 安全地控制本机

- 📁 文件 · 💻 Shell · 🔍 搜索 · 🧰 本地工具 —— 一律经 Runtime Projection + PermissionGrant + Evidence

---

## 🏁 快速开始

### 方式 A —— Desktop（大多数用户推荐）

1. 从 **[GitHub Releases](https://github.com/ly-ccx/Peer-Agent/releases)** 下载发行包
2. 安装并打开 Peer Agent
3. 在设置中添加模型服务商 / API Key
4. 开始对话 —— 或直接给它一个真实目标，让 **Agent** 模式推进

### 方式 B —— 通过 npm 安装 CLI / TUI

```bash
npm install -g @peer-agent/cli
peer --version
peer
```

npm 包会在安装时从 GitHub Releases 下载对应平台的 `peer` 二进制（macOS / Linux，arm64 / x64）。

### 方式 C —— 从源码构建

```bash
# 前置：Node.js 20+、pnpm、Rust 工具链（原生部分）

git clone https://github.com/ly-ccx/Peer-Agent.git
cd Peer-Agent
pnpm install

# Desktop（Electron）
pnpm --filter @peer-agent/desktop dev

# 终端 Agent（TUI）
pnpm --filter @peer-agent/tui dev
```

工作区包分布在 `apps/`（产品壳）与 `packages/`（运行时、协议、CLI 发布包 `@peer-agent/cli`）。

---

## 🏗️ 架构一览

架构从一个点出发：**agent runtime**。其余一切都是从它身上剥出来的层。

### 第一层：Runtime 内核 —— 能力、授权与证据

最底层回答一个问题：*模型想用本地能力时，凭什么执行、如何证明？*

```text
Capability Provider → Manifest → Runtime Projection → Tool Call → PermissionGrant → Evidence
```

`@peer-agent/runtime-core` 是这个内核的纯实现：能力注册、清单、投影、授权与 Evidence 原语，外加上下文压缩与记账。它不知道 Electron、不知道终端、不知道任何产品形态 —— 它只知道契约。`@peer-agent/protocol` 把契约本身（chat、execution、goal、system-context、automation、compaction 等 13 个域）定义成跨层类型，让每一层都说同一种语言。

**没有旁路。** Bash、文件、搜索、MCP、插件、技能 —— 所有能力走同一条链，这是架构的不可协商项。

### 第二层：System Context —— 模型看到什么

runtime 执行能力，但模型首先需要*上下文*。`@peer-agent/system-context` 是 System Context 的规范装配器：prompt sources 注册、分层、checksum、快照。项目指令、模式提醒、工具提示、压缩摘要都经显式 Context Source 进入 —— 而不是散落的字符串拼接。工具输出与文件内容是事实性上下文，永远不会被提升为系统指令。

### 第三层：任务流内核 —— 工作如何流动

在能力与上下文之上，是任务的运转：`@peer-agent/chat-kernel`（reducer 驱动的会话状态机）与 `@peer-agent/task-thread`（任务线程事件模型）承载流转、继承、追问；goal 契约定义 GoalPlan、子任务与成功标准；`@peer-agent/conversation-store` 把这一切持久化，任务才能跨会话存活。

### 第四层：Node 宿主 —— 落到真实机器

`@peer-agent/runtime-node` 把内核落到 Node 环境：MCP 服务器接入、Automation 调度器、chat runtime、加密凭证（配合 `@peer-agent/credential-helper` 与系统 Secret Service）。`@peer-agent/runtime-sdk` 则把同一套编排开放给任何 Node 宿主嵌入。

### 表面层：表达与交互

Desktop（`apps/desktop`）、TUI、CLI（`apps/tui` + `@peer-agent/cli`）只做表达与交互，不持有执行真值。宿主中立不是口号，是依赖事实：TUI 不依赖任何 UI 包，只依赖 `protocol + runtime-core + runtime-node + runtime-sdk + system-context`；Desktop 额外使用 `chat-kernel / task-thread / ui / i18n`。同一台机器、同一个 `~/.peer-agent`，界面不同，真值唯一。

```text
┌──────────────────────────────────────────────────────────┐
│  Desktop / TUI / CLI        （仅表达与交互）              │
└───────────────────────────┬──────────────────────────────┘
                            │ protocol / IPC
┌───────────────────────────▼──────────────────────────────┐
│  Agent Runtime                                            │
│  ① runtime-core + protocol   能力链 · 授权 · Evidence      │
│  ② system-context            Context Sources · 装配       │
│  ③ chat-kernel + task-thread 任务流 · goal · 持久化        │
│  ④ runtime-node              MCP · Automation · 凭证      │
│  ⑤ runtime-sdk               宿主嵌入                     │
└───────────────────────────┬──────────────────────────────┘
                            │ Provider 路由 / 模型 API
┌───────────────────────────▼──────────────────────────────┐
│  认知（你的模型栈）  官方 · OAuth/订阅 · Coding Plan · 自定义 │
└──────────────────────────────────────────────────────────┘
```

### 仓库结构

```text
peer_agent/
├── apps/            # Desktop、TUI/CLI 产品壳
├── packages/        # protocol · runtime-core/node/sdk · system-context
│                    # chat-kernel · task-thread · conversation-store
│                    # credential-helper · i18n · ui · npm-cli
├── capabilities/    # 能力清单（local.shell.* / local.web.* / …）
├── crates/          # Rust 原生组件
├── marketplace/     # 插件 / 技能 marketplace 资源
├── skills/          # 内置技能
├── docs/            # 站点资源（logo、页面）
└── scripts/         # 构建 / 发布工具
```

---

## 🔭 产品愿景

Peer Agent 的目标是成为面向真实工作的 **跨平台 Agent 操作系统** —— 而不是又一个能执行命令的聊天窗口。

长期产品主轴：

| 支柱 | 含义 |
| --- | --- |
| **跨平台** | 以 macOS 为先，再扩展更广的桌面 / 运行环境，不分裂核心模型。 |
| **统一核心流** | Desktop、TUI、CLI、Automation、MCP、插件与技能共享同一条运行时链：投影 → 授权 → 执行 → Evidence。 |
| **任务流转** | 工作以受治理任务被签收、澄清、规划、执行与关闭 —— 而不是闲聊式乱做。 |
| **自我闭环** | 探索 → 规划 → 行动 → 验证 → 调整，以成功标准与 Evidence 作为完成闸门。 |
| **自我进化** | 从历史 Evidence 改进 playbook、技能与工作流 —— 可审阅的迭代，绝不静默改写信任边界。 |
| **多 Agent 协作** | 同一任务下的专家角色（探索 / 实现 / 审阅），交接清晰、Evidence 共享。 |
| **Agent swarm** | 可选的更大规模并行探索 / 验证 —— 仍有预算、由主导任务流托管，不是失控的人群。 |
| **Canvas 创作体系** | 与对话并列的空间画布，承载计划、图示与中间产物 —— 看得见、可编辑的思考与创作。 |
| **记忆体系** | 超越单线程的持久、受权限约束的记忆：偏好、项目事实与本地检索。 |

表面会变，原则不变：**认知可插拔；授权与 Evidence 留在本地。**

---

## 🗺️ 路线图

### 现已可用

| 领域 | 状态 |
| --- | --- |
| 本地能力运行时 + Evidence | ✅ 可用 |
| Desktop · TUI · CLI | ✅ 可用 |
| Agent / Plan / Goal 任务流 | ✅ 可用 |
| 统一核心能力链 | ✅ 可用 |
| 安全的跨端 Provider / 模型配置 | ✅ 可用 |
| 主模型 + 兜底多模态路由 | ✅ 可用 |
| MCP · 插件 · 技能 | ✅ 可用 |
| Automation（定时 Agent） | ✅ 可用 |
| 任务派发与验收（云端调度 + 用户验收） | ✅ 可用 |

### 进行中

| 领域 | 状态 |
| --- | --- |
| 更广泛的 marketplace 生态 | 🚧 建设中 |
| 跨平台加固 / 打包 | 🚧 持续推进 |

### 规划中 —— 尚未实现

以下是**方向，不是交付承诺**。当前 beta 中**不可用**。

| 领域 | 意图 |
| --- | --- |
| **记忆体系** | 超越单线程的持久、受治理记忆 —— 偏好、项目事实与本地检索，并保持权限意识。 |
| **更强的自我闭环** | 更紧的验证 / 调整循环、更丰富的成功标准，以及长目标的续跑连续性。 |
| **自进化 / 自迭代** | 基于 Evidence 安全改进工作流、技能与 playbook 的闭环 —— 始终可审阅。 |
| **多 Agent 协作** | 在同一任务流下协调专家 Agent（探索 / 实现 / 审阅），共享 Evidence 与清晰交接。 |
| **Agent swarm** | 在主导任务下的有预算并行探索 / 验证 —— 不是失控 swarm。 |
| **Canvas 创作体系** | 与对话并列的空间画布，用于计划、图示与中间产物。 |

---

## 🤝 参与贡献

欢迎 Issue、讨论与 PR。

1. Fork 并创建分支
2. 改动保持聚焦；优先走协议 / 运行时 seam，而不是一次性旁路
3. 触及契约、权限或工具执行时，补充或更新测试
4. 开 PR 时写清问题陈述与验证说明

请**不要**扩大 renderer 对 `fs` / `child_process` 的直接访问、绕过 Runtime Projection，或以自由文本替代 Evidence。

---

## 📄 许可证

[MIT](LICENSE) © 2026 梁音

---

<p align="center">
  <sub>为那些希望 AI 能动手 —— 并要授权、任务流与 Evidence 的人而建。</sub>
</p>
