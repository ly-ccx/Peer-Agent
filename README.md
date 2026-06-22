# Peer Agent

**The AI agent that lives on your machine, not in someone's cloud.**

Local-first. Permission-gated. Evidence-backed.

> Most AI assistants run their "tools" on a server you can't see, with access you can't audit. Peer Agent flips that: every capability runs locally, every action asks for your authorization, and every result leaves a verifiable trace. Your AI gets hands — you keep the keys.

Peer Agent is a privacy-first desktop AI assistant built on a general local-agent platform. It combines a rich desktop shell with a local capability runtime, so an AI agent can read files, run commands, call tools, and automate work **on your computer** — under explicit, auditable control.

> [!NOTE]
> Peer Agent is in early development (`v0.0.1`). The capability runtime and desktop shell are usable; the local LLM runtime is in progress (see [Roadmap](#-roadmap)).

## ✨ Why Peer Agent

- 🔒 **Privacy-first by architecture** — Capabilities execute on your machine. Your files, commands, and data don't get shipped to a third-party tool server.
- ✅ **Permission-gated execution** — No tool runs without a `PermissionGrant`. Authorization is enforced by the runtime, not by a polite prompt.
- 🧾 **Evidence-backed accountability** — Every capability call returns structured Evidence (artifacts, logs, metadata) you can inspect and audit after the fact.
- 🧩 **One runtime for every capability** — Bash, file edits, web fetch, MCP, plugins, and skills all flow through a single governed chain. No hidden side doors.
- 🖥️ **Codex-like desktop experience** — Task threads, a composer, review cards, and project indexing in a native desktop shell.

## 🧠 The Design Philosophy

Peer Agent is built on one principle — the **Capability Agent** model:

```text
Local owns capability.
Interface owns expression.
Contract owns boundaries.
Evidence owns governance.
```

Every local action flows through a single non-negotiable runtime chain:

```text
Capability Provider
  → Manifest
    → Runtime Projection
      → Tool Call
        → PermissionGrant
          → Evidence
```

This is what keeps model intent, local execution, user authorization, and factual results separate and traceable — instead of letting an LLM quietly do whatever it wants on your disk.

## 🚀 What You Can Do

**Work with your machine**
- 📂 **File operations** — Read, search, and edit files in your workspace with scoped permissions.
- 💻 **Shell execution** — Run builds, tests, and scripts; results return as inspectable artifacts.
- 🌐 **Web fetch & search** — Pull in web pages and search results as governed context.

**Extend the agent**
- 🔌 **MCP integration** — Connect Model Context Protocol servers as first-class capabilities.
- 🧩 **Plugins & Skills** — Add new capabilities through manifests, not by patching the core.

**Stay in control**
- 🔐 **Authorize per action** — Grant or deny capability requests as they happen.
- 🧾 **Audit everything** — Review the Evidence trail for what the agent actually did.

## 📦 Tech Stack

```text
Electron Rich Client Shell
  + Local Capability Runtime
  + Local Agent Runtime (WIP)
```

- **Electron Shell** — Codex-like task threads, composer, review cards, project indexing, and desktop experience.
- **Local Capability Runtime** — Capability declaration, authorization, execution, Evidence, and audit.
- **Local Agent Runtime** — Local LLM inference (in development).

## 🏁 Quick Start

**Prerequisites:** Node.js + [pnpm](https://pnpm.io/), and the [Rust toolchain](https://rustup.rs/) (for the local capability core).

```bash
# Install dependencies
pnpm install

# Type-check, build the workspace, and build the Rust core
pnpm typecheck
pnpm build
cargo build --workspace
```

Start development mode:

```bash
pnpm dev
```

## 🗂️ Project Structure

```text
peer_agent/
├── apps/
│   └── desktop/          # Electron desktop application
├── packages/
│   ├── protocol/         # Shared cross-layer contract types
│   ├── chat-kernel/      # Conversation kernel
│   ├── task-thread/      # Task-thread state
│   ├── i18n/             # Internationalization
│   └── ui/               # Base UI components
├── crates/
│   └── cu-proxy-core/    # Rust local capability core
├── capabilities/         # Capability manifest JSON
└── docs/architecture/    # Engineering contract & ADRs
```

## 📚 Architecture Docs

The architecture docs are part of the engineering contract, not just background reading.

- [Engineering Philosophy](./docs/architecture/00-engineering-philosophy.md)
- [Project Structure](./docs/architecture/01-project-structure.md)
- [Architecture Governance](./docs/architecture/20-architecture-governance.md)
- [Plugin / Skill / MCP System](./docs/architecture/15-plugin-skill-mcp-system.md)
- [Skill Call Lifecycle](./docs/architecture/16-skill-call-lifecycle.md)
- [System Prompt & Context Architecture](./docs/architecture/19-system-prompt-context-architecture.md)

The full set of ADRs lives in [`docs/architecture/`](./docs/architecture/).

## 🗺️ Roadmap

- [x] Local capability runtime — manifest, permission grants, Evidence
- [x] Electron desktop shell — task threads, composer, review cards
- [x] MCP connection & authentication
- [ ] **Local Agent Runtime** — on-device LLM inference
- [ ] Expanded plugin & skill ecosystem

## 📄 License

[MIT](./LICENSE) © 2026 梁音
