<p align="center"><img src="docs/logo.png" alt="Peer" width="96"></p>

<h1 align="center">Peer Agent</h1>

<p align="center"><strong>把工作交给 Peer，只在真正需要你的时候回来。</strong></p>
<p align="center">每个项目一个 Bot，理解目标、组织 Agent 执行、跟进过程问题并核对结果。</p>
<p align="center">MIT 完全开源 · 本地执行与授权 · Desktop 与 CLI</p>
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong> · <a href="https://ly-ccx.github.io/Peer-Agent/">官网</a> · <a href="https://ly-ccx.github.io/Peer-Agent/docs.html">使用文档</a> · <a href="https://github.com/ly-ccx/Peer-Agent/releases">下载</a></p>

Peer 是面向代码、文档与研究工作的本地工作委托系统。把目标和边界交给项目 Bot，由它了解项目、安排有范围的执行、协调补充与工作疑问，再核对返回的工作。

你保留重要判断和授权。任务、计划与成功标准在项目对话背后组织执行。

> **先选择对应版本。** 项目 Bot 体验属于 **0.1 预览版**，当前为 **0.1.0-rc.29**；正式版 **0.0.18** 使用经典界面。RC29 已包含近期持久监督与撤回收口补正。版本与 npm 通道事实核对于 2026-10-29。

![真实项目 Bot 界面，使用虚构的官网、文档与研究项目](docs/screenshots/project-bot-showcase-light.jpg)

截图来自真实 0.1 Desktop renderer，使用虚构项目与示意对话。它展示交互界面，不代表真实模型执行或安装版本验收。

## 为什么选 Peer

- **围绕项目持续协作。** 文件夹、目标、记忆和历史可以随着工作继续读取。
- **保持一个沟通对象。** 主 Bot 协调工作 Agent，把补充交给对应的工作。
- **结果带着依据交回。** 说明实际改动、执行过的检查和仍未确认的部分。
- **执行权掌握在本机。** 工具经过本地能力与授权契约；模型回复不能产生权限或证据。
- **开放的基础。** Desktop、CLI、运行时、协议与能力清单采用同一 MIT 许可。

<a id="-任务流流转继承追问"></a>

## 怎样一起工作

1. **交代目标和边界。** 例如：“查清这个请求为什么慢；改动公开接口之前先说明原因。”
2. **由项目 Bot 组织执行。** 工作 Agent 接收有范围的目标和成功标准，独立工作可以并行推进。
3. **过程中继续沟通。** 在项目对话中补充信息、纠正方向，或要求停止指定工作。
4. **关键节点由你决定。** 授权、重要范围取舍和真正需要你回答的问题仍交给你。
5. **查看结果与核对依据。** Bot 说明改了什么、核对了什么、哪些还不确定，报告、Diff 和证据可以按需打开。

普通工作疑问应先交主 Bot 协调。技术中断、任务暂停和工具结果未知是不同事实；恢复保留上下文与已有工作，不盲目重放未知操作。

RC29 强化了持久监督与撤回收口。撤回委托保留历史，也可能保留未知的历史结果，不证明外部副作用已经回滚。安装版本实际包含的能力，以对应发布说明为准。

## 可以委托什么

| 工作 | 示例目标 | 交回时查看什么 |
| --- | --- | --- |
| 问题定位与修复 | 查清请求变慢的原因并修复根因 | 原因、改动 Diff 与实际执行的检查 |
| 工程改造 | 跨文件完成一项功能，同时保持兼容 | 关联改动、核验结论与剩余缺口 |
| 研究与文档 | 比较几种方案，整理建议 | 结论、来源引用与待澄清问题 |

0.1 预览版的“工作区”可以在对话旁打开网页、文档、代码、目录与 Diff。阅读结果、授权修改、签收工作和 Git 合回分别处理。

<a id="-快速开始"></a>

## 开始使用

### 项目 Bot Desktop 预览版

1. 打开 [0.1.0-rc.29 发布页](https://github.com/ly-ccx/Peer-Agent/releases/tag/v0.1.0-rc.29)，选择可用的平台安装包，阅读升级说明。
2. 在设置中添加模型服务，并选择适合当前工作的模型。
3. 绑定文件夹，或新建受管项目 Bot。
4. 给出目标与边界；想先了解项目时，可以从只读问题开始。
5. 在主对话中补充要求和作决定；需要材料时，再打开任务详情或工作区。

升级前备份完整数据目录。Desktop、CLI/TUI 与 Gateway 按同一版本说明升级，回退按对应发布说明恢复备份。

[正式版 0.0.18](https://github.com/ly-ccx/Peer-Agent/releases/tag/v0.0.18) 使用经典工作流。Linux 的 AppImage 依赖和显示服务要求，以发布说明为准。

### CLI / TUI

预览通道：

    npm install -g @peer-agent/cli@rc
    peer --version
    peer

正式通道：

    npm install -g @peer-agent/cli

npm 包安装对应平台的二进制及 helper；可用平台与安装包以对应发布页为准。npm beta 标签属于较早的 beta 通道，不是当前 RC。模式与脚本用法见 [CLI 文档](https://ly-ccx.github.io/Peer-Agent/docs.html#cli)。

### 从 0.1 源码启动

使用 Node.js 25（当前 CI 版本）、pnpm 10.22.0 和 Rust 工具链。TUI 还需要 Bun；原生凭证存储需要对应操作系统的构建依赖。

    git clone --branch PeerAgent/dev/0.1.0 https://github.com/ly-ccx/Peer-Agent.git
    cd Peer-Agent
    pnpm install --frozen-lockfile
    pnpm dev

启动 TUI：

    pnpm --filter @peer-agent/tui dev

## 本地控制与证据

模型负责认知，可以来自云端服务。Peer 本地负责能力执行、授权判断和证据。模型能收到什么，取决于所选 Provider 和允许纳入的上下文；本地优先不代表内容绝不会离开电脑。

项目 Bot 保持读取与协调角色。工作 Agent 通过本地能力链和已授予的范围执行；主 Bot 不能替你批准权限。

一条回复结束，不等于整件委托完成。核验、签收与合回依宿主的结构化事实和适用策略处理。连续性摘要用于接续上下文，不替代工具结果与证据。

## 扩展能力

| 能力 | 入口 |
| --- | --- |
| 模型服务与路由 | [连接模型](https://ly-ccx.github.io/Peer-Agent/docs.html#model) |
| 外部工具服务 | [MCP](https://ly-ccx.github.io/Peer-Agent/docs.html#mcp) |
| 可复用指令包 | [Skills](https://ly-ccx.github.io/Peer-Agent/docs.html#skill) |
| 能力包与本地适配器 | [Plugins](https://ly-ccx.github.io/Peer-Agent/docs.html#plugin) |
| 嵌入受治理运行时 | [Runtime SDK](packages/runtime-sdk/README.md) |
| 终端与脚本访问 | [CLI](packages/npm-cli/README.md) |

扩展仍遵守同一条能力、投影、授权与证据链，不产生独立的执行旁路。

<a id="-架构一览"></a>

## 架构一览


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

### 第三层：委托工作背后的执行生命周期

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

## 当前阶段与方向

| 阶段 | 代表什么 |
| --- | --- |
| 正式版 0.0.18 | 基于共享本地 Runtime 的经典 Desktop 与终端工作流 |
| 预览版 0.1.0-rc.29 | 项目 Bot、工作委托、记忆、目标与并排工作区 |
| 开发线 | 最新预览版之后合入的改动，不代表安装包已经发布 |

当前重点是把个人项目委托做可靠：行动归属清楚，执行有边界，中断可恢复，结果有依据。后续协作或自动化设想不构成正式版已有能力的承诺。

具体版本事实见 [Releases](https://github.com/ly-ccx/Peer-Agent/releases)、[更新日志](https://ly-ccx.github.io/Peer-Agent/changelog.html)和[使用文档](https://ly-ccx.github.io/Peer-Agent/docs.html)。

## 参与贡献

欢迎提交 Issue 和 PR。修改代码前请阅读 [AGENTS.md](AGENTS.md)，遵循本地能力链，将授权、执行、证据与界面表达分开。

架构与持久设计知识维护在配套 [Peer-Knowledge](https://github.com/ly-ccx/Peer-Knowledge) 仓库。软件版本发布遵循仓库发布门禁；官网更新不等于安装包验收或软件发版。

## 许可证

Peer Agent 采用 [MIT License](LICENSE)，完全开源。
