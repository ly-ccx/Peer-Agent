# Peer Agent

**The AI agent that lives on your machine, not in someone's cloud.**

Local-first. Permission-gated. Evidence-backed.

> Most AI assistants run their "tools" on a server you can't see, with access you can't audit. Peer Agent flips that: every capability runs locally, every action asks for your authorization, and every result leaves a verifiable trace. Your AI gets hands — you keep the keys.

Peer Agent is a privacy-first local agent platform with three first-class shells — **Desktop**, **TUI**, and **CLI** — on one shared capability runtime. An agent can read files, run commands, drive a browser, call MCP tools, and automate work **on your computer**, under explicit, auditable control.

> [!NOTE]
> Current series: **`0.0.1-beta.47`**. The capability runtime, Desktop shell, TUI/CLI, Agent/Plan workflows, and MCP path are usable today. On-device LLM inference (Local Agent Runtime) is still in progress — see [Roadmap](#-roadmap).

---

## ✨ Why Peer Agent

- 🔒 **Privacy-first by architecture** — Capabilities execute on your machine. Files, commands, and local state are not shipped to a third-party tool server.
- ✅ **Permission-gated execution** — No tool runs without a `PermissionGrant`. Authorization is enforced by the runtime, not by a polite prompt.
- 🧾 **Evidence-backed accountability** — Every capability call returns structured Evidence (artifacts, logs, metadata) you can inspect after the fact.
- 🧩 **One runtime for every capability** — Shell, files, web/browser, MCP, plugins, and skills all flow through a single governed chain. No hidden side doors.
- 🖥️ **Multi-surface product** — Desktop GUI, terminal TUI, and installable `peer` CLI share the same local runtime and data under `~/.peer-agent`.
- 🎯 **Modes that match how you work** — **Agent** for self-driven execution, **Plan** for review-first planning, plus Goal runner / Quick Chat for longer or lighter tasks.

---

## 🧠 Design Philosophy

Peer Agent is built on the **Capability Agent** model:

```text
模型负责认知。
本地负责能力。
界面负责表达。
契约负责边界。
证据负责治理。
```

```text
The model owns cognition.
Local owns capability.
Interface owns expression.
Contract owns boundaries.
Evidence owns governance.
```

> "模型 / the model" is a **role, not a location**. It may be a cloud provider today, or the on-device Local Agent Runtime once it lands. Either way, capability execution, authorization, and Evidence stay on your machine.

Every local action flows through one non-negotiable runtime chain:

```text
Capability Provider
  → Manifest
    → Runtime Projection
      → Tool Call
        → PermissionGrant
          → Evidence
```

This keeps model intent, local execution, user authorization, and factual results separate and traceable — instead of letting an LLM quietly do whatever it wants on your disk.

---

## 🚀 What You Can Do

**Work in the way that fits**
- 🖥️ **Desktop app** — Task threads, composer, review cards, Workbench, tray/lifecycle, and a glass-style shell.
- ⌨️ **TUI / CLI (`peer`)** — Full terminal agent with the same runtime; install via `@peer-agent/cli` or build from source.
- ⚡ **Quick Chat** — Lightweight global chat for fast questions without opening a full task thread.
- 🎯 **Agent & Plan modes** — Self-driven Agent execution, or Plan-first review before side effects.
- 📋 **Goal runner** — Multi-step goals with trackable subtasks, evidence-backed completion, and resume continuity.

**Work with your machine**
- 📂 **File operations** — Read, search, and edit workspace files under scoped permissions.
- 💻 **Shell execution** — Run builds, tests, and scripts; results return as inspectable artifacts.
- 🌐 **Web fetch** — Pull pages into governed context.
- 🧭 **Visible browser / Workbench** — Navigate, click, type, screenshot, and read DOM in a conversation-bound browser surface.

**Extend the agent**
- 🔌 **MCP integration** — Connect Model Context Protocol servers (including OAuth-capable setups) as first-class capabilities.
- 🧩 **Plugins & Skills** — Add capabilities through manifests and skill packs, not by patching the core.
- ☁️ **Cloud cognition, local hands** — Plug in cloud providers for reasoning while tools still execute locally under your grants.

**Stay in control**
- 🔐 **Authorize per action** — Grant or deny capability requests as they happen.
- 🧾 **Audit everything** — Review the Evidence trail for what the agent actually did.
- 🧱 **Shared local state** — Settings, conversations, credentials, and runtime data live under `~/.peer-agent`.

---

## 📦 Surfaces & Tech Stack

```text
Desktop (Electron)     TUI / CLI (`peer`)
        \                 /
         \               /
          Local Capability Runtime
          (protocol · chat-kernel · runtime-*)
                 |
         PermissionGrant → Evidence
```

| Layer | What it is |
|-------|------------|
| **Desktop** (`apps/desktop`) | Electron shell: threads, composer, Workbench/browser, permissions UI, tray |
| **TUI** (`apps/tui`) | Terminal agent binary `peer`, shares runtime packages with Desktop |
| **CLI installer** (`packages/npm-cli` → `@peer-agent/cli`) | npm package that installs the platform `peer` binary from GitHub Releases |
| **Local Capability Runtime** | Manifest → projection → tool call → permission → Evidence |
| **Local Agent Runtime** | On-device LLM inference (**WIP**) |

---

## 🏁 Quick Start

| Entry | Who it's for | Install path |
|-------|--------------|--------------|
| **CLI / TUI (`peer`)** | Terminal-first use | `npm i -g @peer-agent/cli@beta` or build `apps/tui` |
| **Desktop app** | GUI shell | Dev: `pnpm --filter @peer-agent/desktop dev` · Release: GitHub Releases / `pnpm dist` |

Both share the same local Runtime and data under `~/.peer-agent` (settings, conversations, credentials).

### CLI / TUI (no Desktop required)

#### Option A — npm (beta)

```bash
npm install -g @peer-agent/cli@beta
# or: pnpm add -g @peer-agent/cli@beta

peer --version
peer
```

`postinstall` downloads `peer` + `peer-credential-helper` for your platform from the matching GitHub Release (`v0.0.1-beta.47` assets for this version). Requires **Node.js 20+**.

Supported installer platforms today: **macOS / Linux** (`darwin`/`linux` × `arm64`/`x64`). See [`packages/npm-cli/README.md`](./packages/npm-cli/README.md) for env overrides and manual tarball install.

#### Option B — from this monorepo

```bash
pnpm install
pnpm --filter @peer-agent/tui build
./apps/tui/dist/peer --version
./apps/tui/dist/peer
```

For day-to-day TUI development:

```bash
pnpm --filter @peer-agent/tui dev
```

### Desktop app

#### From source (developers)

```bash
pnpm install
pnpm --filter @peer-agent/desktop dev
# or from repo root:
pnpm dev
```

#### Packaged build

```bash
pnpm dist        # current host
pnpm dist:mac    # macOS
pnpm dist:win    # Windows
```

Release notes for each beta live under [`release-notes/`](./release-notes/) and in [`CHANGELOG.md`](./CHANGELOG.md).

---

## 🗂️ Repository Structure

```text
peer_agent/
├── apps/
│   ├── desktop/              # Electron Desktop shell
│   └── tui/                  # Terminal agent (`peer` binary)
├── packages/
│   ├── npm-cli/              # Public installer: @peer-agent/cli
│   ├── protocol/             # Cross-layer contracts
│   ├── chat-kernel/          # Chat / agent loop kernel
│   ├── runtime-core/         # Capability runtime core
│   ├── runtime-node/         # Node host adapters
│   ├── runtime-sdk/          # Runtime SDK surface
│   ├── system-context/       # System prompt / context assembly
│   ├── task-thread/          # Task-thread model
│   ├── conversation-store/   # Conversation persistence
│   ├── credential-helper/    # Credential helper bindings
│   ├── ui/                   # Shared UI primitives
│   └── i18n/                 # Shared strings
├── crates/
│   └── peer-credential-helper/  # Native credential helper
├── capabilities/             # Built-in capability manifests
├── skills/                   # Built-in skills
├── docs/                     # Product site static pages
├── release-notes/            # Per-version release notes
├── scripts/                  # Version, pack, architecture checks
├── CHANGELOG.md
├── VERSION                   # 0.0.1-beta.47
└── AGENTS.md                 # Repo engineering rules for agents
```

Architecture design docs are **not** stored in this code repo. They live in the companion knowledge base **`peer-knowledge`** (see below and `AGENTS.md`).

---

## 📚 Documentation

| Kind | Where |
|------|--------|
| **Product site (static)** | [`docs/`](./docs/) (`index.html`, `docs.html`, changelog page assets) |
| **Changelog** | [`CHANGELOG.md`](./CHANGELOG.md) |
| **Release notes** | [`release-notes/`](./release-notes/) |
| **CLI installer** | [`packages/npm-cli/README.md`](./packages/npm-cli/README.md) |
| **Repo agent rules** | [`AGENTS.md`](./AGENTS.md) |
| **Architecture & ADRs** | Companion repo **`peer-knowledge`** (not published inside this tree) |

### Knowledge base map (`peer-knowledge`)

When you have the knowledge workspace checked out next to this repo:

| Topic | Path in `peer-knowledge` |
|-------|---------------------------|
| Engineering philosophy | `knowledge/architecture/00-engineering-philosophy.md` |
| Project structure | `knowledge/architecture/01-project-structure.md` |
| Architecture governance | `knowledge/architecture/20-architecture-governance.md` |
| System prompt & context | `knowledge/architecture/19-system-prompt-context-architecture.md` |
| TUI/Desktop shared runtime | `knowledge/architecture/22-tui-desktop-shared-runtime-and-host-governance.md` |
| Plugin / Skill / MCP | `knowledge/decisions/15-plugin-skill-mcp-system.md` |
| Skill call lifecycle | `knowledge/decisions/16-skill-call-lifecycle.md` |
| Mode-scoped tools | `knowledge/decisions/35-mode-scoped-tool-projection.md` |
| Embedded browser | `knowledge/decisions/40-embedded-browser-and-agent-control.md` |

> Do not recreate architecture trees inside this code repository unless that decision is explicitly revisited.

---

## 🗺️ Roadmap

- [x] Local capability runtime (provider → permission → Evidence)
- [x] Electron Desktop shell
- [x] TUI + first-class CLI release (`peer` / `@peer-agent/cli`)
- [x] MCP connection & authentication
- [x] Agent / Plan modes and Goal runner
- [x] Quick Chat
- [x] Workbench + conversation-bound browser control
- [ ] **Local Agent Runtime** — on-device LLM inference
- [ ] Expanded plugin & skill ecosystem
- [ ] Broader multi-platform packaging parity

---

## 🤝 Contributing

Issues and PRs are welcome.

Before large changes, read `AGENTS.md` and the governance baseline in `peer-knowledge`. Prefer extending existing providers, protocol types, reducers, and context sources over adding ad-hoc execution paths.

Useful checks from the repo root:

```bash
pnpm typecheck
pnpm architecture:check
pnpm version:check
pnpm check
```

---

## 📄 License

[MIT](./LICENSE)

---

**Peer Agent** — local hands for AI, with keys you still hold.
