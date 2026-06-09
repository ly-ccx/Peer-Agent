# Peer Agent

Current development version: `0.0.1`.

Peer Agent 是一个本地 AI Agent 桌面客户端。

```text
Electron Rich Client Shell
  + Local Capability Runtime
  + Local Agent Runtime (WIP)
```

其中：

- Electron Shell 负责 Codex-like 的任务线程、Composer、Review card、项目索引和桌面体验。
- Local Capability Runtime 负责本地能力声明、授权、执行、Evidence 和审计。
- Local Agent Runtime 计划接入本地 LLM 推理能力（即将开发）。

## Architecture Docs

- [工程哲学](./docs/architecture/00-engineering-philosophy.md)
- [工程结构设计](./docs/architecture/01-project-structure.md)
- [i18n 架构设计](./docs/architecture/02-i18n-architecture.md)
- [版本管理](./docs/architecture/06-version-management.md)

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
cargo build --workspace
```

启动开发模式：

```bash
pnpm dev
```

## Project Structure

```text
peer_agent/
├── apps/
│   └── desktop/          # Electron 桌面应用
├── packages/
│   ├── protocol/         # 端内共享契约类型
│   ├── chat-kernel/      # 对话内核
│   ├── task-thread/      # 任务线程状态
│   ├── i18n/             # 国际化
│   └── ui/               # 基础 UI 组件
├── crates/
│   └── cu-proxy-core/    # Rust 本地能力核心
└── capabilities/         # 能力 Manifest JSON
```
