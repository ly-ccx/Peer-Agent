<p align="center">
  <img src="docs/logo.png" alt="Peer Agent" width="120" />
</p>

<h1 align="center">Peer Agent</h1>

<p align="center">
  <strong>跑在你机器上的 AI Agent —— 而不是别人的云端。</strong>
</p>

<p align="center">
  本地优先 · 权限门控 · 证据可追溯 · 默认任务流
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
  <a href="#-任务流">任务流</a> ·
  <a href="#-你能做什么">功能</a> ·
  <a href="#-架构一览">架构</a> ·
  <a href="#-路线图">路线图</a>
</p>

---

大多数 AI 助手把「工具」跑在你看不见、也审不了的服务器上。

**Peer Agent 反过来做。** 每项能力都在**本地**执行，每个动作都需要你的**授权**，每个结果都留下**可验证痕迹**。AI 有手，钥匙在你这里。

三种一等入口，共享同一套本地运行时：

| 入口 | 是什么 |
| --- | --- |
| **Desktop** | 任务线程、输入框、审阅卡片、Workbench、托盘 |
| **TUI** | 终端完整 Agent（`peer`），同一套运行时 |
| **CLI** | 可安装的 `@peer-agent/cli` —— 脚本化进入同一台机器 |

> [!NOTE]
> 当前系列：**`0.0.2-beta`**（预发布；`0.0.1` 仍为 stable / latest）。Desktop、TUI/CLI、Agent/Plan 工作流、Automation、MCP 现已可用。端侧 LLM（Local Agent Runtime）仍在推进 —— 见 [路线图](#-路线图)。

---

## ✨ 为什么选 Peer Agent

| | |
| --- | --- |
| 🔒 **隐私优先** | 能力在*你的*机器上执行。文件、命令、本地状态不会送到第三方工具服务器。 |
| ✅ **权限门控** | 没有 `PermissionGrant` 就不跑工具。授权由运行时强制执行，而不是靠一句礼貌提示。 |
| 🧾 **证据可追溯** | 每次能力调用都返回结构化 Evidence（产物、日志、元数据），事后可查。 |
| 🧩 **统一受治理运行时** | Shell、文件、网页/浏览器、MCP、插件、技能都走同一条链。没有暗门。 |
| 🖥️ **多端一体** | Desktop GUI、终端 TUI 与 `peer` CLI 共享 `~/.peer-agent` 数据与同一本地运行时。 |
| 🎯 **默认任务流** | 先签收目标，需要时澄清，按复杂度规划，用 Evidence 收尾。 |

---

## 🧭 设计哲学

Peer Agent 建立在清晰的职责拆分上：

| 角色 | 负责 |
| --- | --- |
| **模型** | 认知 —— 理解、规划、决定下一步。这是*角色*，不是部署位置：今天可以是云端，以后可以是端侧。 |
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

## 🧠 任务流

Peer Agent 把多步工作当成**任务**，而不是一次自由发挥的聊天回合。

动手前，它会把你的请求整理成可审阅的目标、边界与成功标准。若缺了关键信息 —— 产品决策、高风险取舍、或权限 —— 会先问，而不是猜。规划深度随复杂度缩放：

| 深度 | 何时 | 行为 |
| --- | --- | --- |
| **L0** | 简单问答 | 直接回答 |
| **L1** | 小范围改动 | 短计划后执行 |
| **L2** | 多步工作 | 自驱 GoalPlan，可跟踪子任务 |
| **L3** | 高风险 / 不可逆 | 显式 **Plan** 审阅后再产生副作用 |

**Agent** 是默认模式。**Plan** 是你希望先审再做时的刹车。子任务与成功标准只在有真实工具结果与 Evidence 时关闭 —— 而不是靠「done」话术。

本地执行仍走同一条链：

```text
Capability Provider → Manifest → Runtime Projection → Tool Call → PermissionGrant → Evidence
```

任务流决定*接什么活、何时算完*。能力链决定*本地权力如何授权与证明*。

---

## 🚀 你能做什么

### 按你的工作方式

- 🖥️ **Desktop 应用** —— 任务线程、输入框、审阅卡片、Workbench、托盘/生命周期
- ⌨️ **TUI / CLI（`peer`）** —— 完整终端 Agent；经 `@peer-agent/cli` 安装或源码构建
- ⚡ **Quick Chat** —— 轻量全局对话，不必打开完整任务线程
- 🎯 **Agent 与 Plan 模式** —— Agent 按 L0–L3 自动规划并执行；Plan 在副作用前要求审阅
- 📋 **Goal runner** —— 可跟踪子任务、卡住时澄清、用证据收尾

### 连接工具与知识

- 🔌 **MCP** —— 把外部 MCP 服务器（stdio / HTTP / SSE）当作一等能力接入
- 🧩 **插件与技能** —— 类 marketplace 安装、启停，以及技能触发的工作流
- 📎 **附件与上下文** —— 文件等内容经受治理的准入路径进入（不是随意拼进 prompt）
- 🌐 **网页与浏览器** —— 在同一套权限 + Evidence 模型下抓取、导航、交互
- ⏰ **Automation** —— 定时 / 周期 Agent 运行，并可查看运行结果

### 安全地控制本机

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

```text
┌─────────────────────────────────────────────────────────────┐
│  Desktop / TUI / CLI  （仅表达与交互）                         │
└────────────────────────────┬────────────────────────────────┘
                             │ protocol / IPC
┌────────────────────────────▼────────────────────────────────┐
│  本地运行时                                                   │
│  · 能力发现与 Runtime Projection                              │
│  · PermissionGrant 强制执行                                   │
│  · 工具执行 + Evidence                                         │
│  · Agent / Plan / Goal runner（任务流）                       │
│  · MCP · 插件 · 技能 · Automation                             │
└────────────────────────────┬────────────────────────────────┘
                             │ 模型 API（云端或未来端侧）
┌────────────────────────────▼────────────────────────────────┐
│  认知（角色，不是位置）                                        │
│  今天是云端服务商 · 之后可是端侧 Local Agent Runtime            │
└─────────────────────────────────────────────────────────────┘
```

### 仓库结构

```text
peer_agent/
├── apps/            # Desktop、CLI/TUI 产品壳
├── packages/        # 共享运行时、协议、UI、服务商、CLI 发布包
├── capabilities/    # 能力包 / 清单
├── crates/          # Rust 原生组件
├── marketplace/     # 插件 / 技能 marketplace 资源
├── skills/          # 内置技能
├── docs/            # 站点资源（logo、页面）
└── scripts/         # 构建 / 发布工具
```

---

## 🗺️ 路线图

### 现已可用

| 领域 | 状态 |
| --- | --- |
| 本地能力运行时 + Evidence | ✅ 可用 |
| Desktop · TUI · CLI | ✅ 可用 |
| Agent / Plan / Goal 任务流 | ✅ 可用 |
| MCP · 插件 · 技能 | ✅ 可用 |
| Automation（定时 Agent） | ✅ 可用 |

### 进行中

| 领域 | 状态 |
| --- | --- |
| 端侧 LLM（Local Agent Runtime） | 🚧 进行中 |
| 更广泛的 marketplace 生态 | 🚧 建设中 |

### 规划中 —— 尚未实现

以下是**方向，不是交付承诺**。当前 beta 中**不可用**。

| 领域 | 意图 |
| --- | --- |
| **记忆体系** | 超越单线程的持久、受治理记忆 —— 偏好、项目事实与本地检索，并保持权限意识。 |
| **多 Agent 协作** | 在同一任务流下协调专家 Agent（探索 / 实现 / 审阅），共享 Evidence 与清晰交接 —— 不是失控的 agent 群。 |
| **Canvas 画图体系** | 与对话并列的空间画布，用于计划、图示与中间产物 —— 看得见、可编辑的思考。 |
| **自进化 / 自迭代** | 基于 Evidence 安全改进工作流、技能与 playbook 的闭环 —— 始终可审阅，绝不静默改写信任边界。 |

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
  <sub>为那些希望 AI 能动手 —— 却不想交出机器的人而建。</sub>
</p>
