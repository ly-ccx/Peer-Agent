<p align="center">
  <img src="docs/logo.png" alt="Peer Agent" width="120" />
</p>

<h1 align="center">Peer Agent</h1>

<p align="center">
  <strong>A local-first Task Flow Agent — authorized, planned, and proven on your machine.</strong>
</p>

<p align="center">
  Local-first · Permission-gated · Evidence-backed · Task flow by default
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/ly-ccx/Peer-Agent/stargazers"><img src="https://img.shields.io/github/stars/ly-ccx/Peer-Agent?style=for-the-badge&logo=github&label=Stars" alt="GitHub Stars" /></a>
  <a href="https://www.npmjs.com/package/@peer-agent/cli"><img src="https://img.shields.io/npm/v/@peer-agent/cli?style=for-the-badge&logo=npm&label=npm%20%40peer-agent%2Fcli" alt="npm version" /></a>
  <a href="https://github.com/ly-ccx/Peer-Agent/releases"><img src="https://img.shields.io/github/v/release/ly-ccx/Peer-Agent?include_prereleases&style=for-the-badge&label=Release" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-why-peer-agent">Why</a> ·
  <a href="#-design-philosophy">Philosophy</a> ·
  <a href="#-task-flow">Task Flow</a> ·
  <a href="#-what-you-can-do">Features</a> ·
  <a href="#-architecture-at-a-glance">Architecture</a> ·
  <a href="#-product-vision">Vision</a> ·
  <a href="#-roadmap">Roadmap</a>
</p>

---

Many coding agents already run tools on your machine. That alone is no longer a differentiator.

**Peer Agent is about what happens after local execution:** goals are accepted with boundaries, ambiguity is clarified instead of guessed, work is planned by complexity, and completion is proven with Evidence — under one permissioned capability chain across Desktop, TUI, and CLI.

Three first-class shells share one unified core runtime:

| Surface | What it is |
| --- | --- |
| **Desktop** | Task threads, composer, review cards, Workbench, tray |
| **TUI** | Full terminal agent (`peer`) with the same runtime |
| **CLI** | Installable `@peer-agent/cli` — scriptable entry to the same machine |

> [!NOTE]
> Current series: **`0.0.2-beta`** (prerelease; `0.0.1` remains stable / latest). Desktop, TUI/CLI, Agent/Plan workflows, Automation, and MCP are usable today — see [Roadmap](#-roadmap).

---

## ✨ Why Peer Agent

| | |
| --- | --- |
| 🔒 **Local execution, explicit trust** | Tools run on *your* machine under `PermissionGrant`. Cognition can come from any model provider — capability power stays local and auditable. |
| ✅ **Permission-gated** | No tool runs without a `PermissionGrant`. Authorization is enforced by the runtime — not by a polite prompt. |
| 🧾 **Evidence-backed** | Every capability call returns structured Evidence (artifacts, logs, metadata) you can inspect after the fact. |
| 🧩 **One governed runtime** | Shell, files, web/browser, MCP, plugins, and skills all flow through a single chain. No hidden side doors. |
| 🖥️ **Multi-surface** | Desktop GUI, terminal TUI, and `peer` CLI share `~/.peer-agent` data and the same local runtime. |
| 🎯 **Task flow by default** | Accept the goal, clarify when needed, plan by complexity, finish with Evidence. |

---

## 🧭 Design Philosophy

Peer Agent is built around a simple split of responsibility:

| Role | Owns |
| --- | --- |
| **Model** | Cognition — understanding, planning, deciding what to try next. A *role* supplied by your chosen model provider. |
| **Local runtime** | Capability — discovery, permission, execution, and Evidence on your machine. |
| **Interface** | Expression — Desktop / TUI / CLI present work; they do not hold permission truth. |
| **Contract** | Boundaries — protocol types, Runtime Projection, and hard bans between layers. |
| **Evidence** | Governance — what actually happened, inspectable after the fact. |

Product principles we try not to violate:

- **Elegance first** — Prefer one clear concept over two overlapping ones; refuse “good enough” seams that will rot.
- **Task over chat** — Multi-step work is accepted as a goal with boundaries and success criteria, not freelanced mid-conversation.
- **Ask when blocked** — Material ambiguity and high-risk trade-offs interrupt; silent guessing does not.
- **Prove completion** — Done means tool results and Evidence, not assertive prose.
- **One capability chain** — Shell, files, browser, MCP, plugins, and skills all pass through the same permission + Evidence path.

These ideas shape both the product surface (Agent / Plan / Goal) and the engineering baseline in the companion knowledge base.

---

## 🧠 Task Flow

Peer Agent treats multi-step work as a **task**, not a free-form chat turn.

Before acting, it turns your request into an objective, boundaries, and success criteria you can review. If something material is missing — a product choice, a risky trade-off, or a permission — it asks instead of guessing. Planning depth scales with complexity:

| Depth | When | Behavior |
| --- | --- | --- |
| **L0** | Simple Q&A | Answer directly |
| **L1** | Small scoped change | Short plan, then act |
| **L2** | Multi-step work | Self-driven GoalPlan with trackable subtasks |
| **L3** | High-risk / irreversible | Explicit **Plan** review before side effects |

**Agent** is the default. **Plan** is the brake when you want review first. Subtasks and success criteria close only with real tool results and Evidence — not “done” prose.

Local execution still goes through one chain:

```text
Capability Provider → Manifest → Runtime Projection → Tool Call → PermissionGrant → Evidence
```

Task flow decides *what* work is accepted and when it is finished. The capability chain decides *how* local power is authorized and proven.

---

## 🚀 What You Can Do

### Work the way that fits

- 🖥️ **Desktop app** — Task threads, composer, review cards, Workbench, tray/lifecycle, glass-style shell
- ⌨️ **TUI / CLI (`peer`)** — Full terminal agent; install via `@peer-agent/cli` or build from source
- ⚡ **Quick Chat** — Lightweight global chat without opening a full task thread
- 🎯 **Agent & Plan modes** — Agent auto-plans and executes (L0–L3); Plan requires review before side effects
- 📋 **Goal runner** — Trackable subtasks, clarification when blocked, evidence-backed completion

### Connect tools and knowledge

- 🔌 **MCP** — Connect external MCP servers (stdio / HTTP / SSE) as first-class capabilities
- 🧩 **Plugins & Skills** — Marketplace-style install, enable/disable, and skill-triggered workflows
- 📎 **Attachments & context** — Files and other context admitted through governed paths (not free-form prompt injection)
- 🌐 **Web & browser** — Fetch, navigate, and interact under the same permission + Evidence model
- ⏰ **Automation** — Scheduled / recurring agent runs with run-result viewing

### Control the machine (safely)

- 📁 Files · 💻 Shell · 🔍 Search · 🧰 Local tooling — always via Runtime Projection + PermissionGrant + Evidence

---

## 🏁 Quick Start

### Option A — Desktop (recommended for most users)

1. Download a release from **[GitHub Releases](https://github.com/ly-ccx/Peer-Agent/releases)**
2. Install and open Peer Agent
3. Add a model provider / API key in settings
4. Start a conversation — or hand it a real goal and let **Agent** mode drive

### Option B — CLI / TUI via npm

```bash
npm install -g @peer-agent/cli
peer --version
peer
```

The npm package downloads the platform `peer` binary from GitHub Releases on install (macOS / Linux, arm64 / x64).

### Option C — Build from source

```bash
# Prerequisites: Node.js 20+, pnpm, Rust toolchain (for native pieces)

git clone https://github.com/ly-ccx/Peer-Agent.git
cd Peer-Agent
pnpm install

# Desktop (Electron)
pnpm --filter @peer-agent/desktop dev

# Terminal agent (TUI)
pnpm --filter @peer-agent/tui dev
```

Workspace packages live under `apps/` (product shells) and `packages/` (runtime, protocol, CLI publish package `@peer-agent/cli`).

---

## 🏗️ Architecture at a Glance

```text
┌─────────────────────────────────────────────────────────────┐
│  Desktop / TUI / CLI  (expression + interaction only)         │
└────────────────────────────┬────────────────────────────────┘
                             │ protocol / IPC
┌────────────────────────────▼────────────────────────────────┐
│  Local runtime                                              │
│  · Capability discovery & Runtime Projection                │
│  · PermissionGrant enforcement                              │
│  · Tool execution + Evidence                                │
│  · Agent / Plan / Goal runner (task flow)                   │
│  · MCP · Plugins · Skills · Automation                      │
└────────────────────────────┬────────────────────────────────┘
                             │ model API
┌────────────────────────────▼────────────────────────────────┐
│  Cognition (model provider)                                 │
│  Your chosen cloud / API provider                           │
└─────────────────────────────────────────────────────────────┘
```

### Repository layout

```text
peer_agent/
├── apps/            # Desktop, CLI/TUI product shells
├── packages/        # Shared runtime, protocol, UI, providers, CLI publish package
├── capabilities/    # Capability packs / manifests
├── crates/          # Rust native components
├── marketplace/     # Plugin / skill marketplace assets
├── skills/          # Bundled skills
├── docs/            # Site assets (logo, pages)
└── scripts/         # Build / release tooling
```

---

## 🔭 Product Vision

Peer Agent aims to be a **cross-platform agent OS for real work** — not another chat window that can shell out.

The long-term product spine:

| Pillar | Meaning |
| --- | --- |
| **Cross-platform** | Same product truth on macOS first, then broader desktop / environment coverage without forking the core model. |
| **Unified core flow** | Desktop, TUI, CLI, Automation, MCP, plugins, and skills share one runtime chain: projection → permission → execution → Evidence. |
| **Task flow** | Work is accepted, clarified, planned, executed, and closed as a governed task — not freelanced chat. |
| **Self-closed loop** | Explore → plan → act → verify → adjust, with success criteria and Evidence as the completion gate. |
| **Self-evolution** | Improve playbooks, skills, and workflows from prior Evidence — reviewable iteration, never silent rewrite of trust boundaries. |
| **Multi-agent collaboration** | Specialist roles under one task (explore / implement / review) with explicit handoffs and shared Evidence. |
| **Agent swarm** | Optional larger parallel fan-out for exploration and verification — still budgeted, owned by a lead task flow, not an unconstrained crowd. |
| **Canvas creation system** | A spatial surface for plans, diagrams, and intermediate artifacts — thinking and creation you can see and edit next to the conversation. |
| **Memory system** | Durable, permission-aware memory beyond a single thread: preferences, project facts, and retrieval that stay local. |

Philosophy stays fixed while the surface grows: **cognition is pluggable; authorization and Evidence stay local.**

---

## 🗺️ Roadmap

### Available now

| Area | Status |
| --- | --- |
| Local capability runtime + Evidence | ✅ Available |
| Desktop · TUI · CLI shells | ✅ Available |
| Agent / Plan / Goal task flow | ✅ Available |
| Unified core capability chain | ✅ Available |
| MCP · Plugins · Skills | ✅ Available |
| Automation (scheduled agents) | ✅ Available |

### In progress

| Area | Status |
| --- | --- |
| Broader marketplace ecosystem | 🚧 Growing |
| Cross-platform hardening / packaging | 🚧 Ongoing |

### Planned — not implemented yet

These are **direction, not shipping claims**. They are **not** available in the current beta.

| Area | Intent |
| --- | --- |
| **Memory system** | Durable, governed memory beyond a single thread — preferences, project facts, and retrieval that stays local and permission-aware. |
| **Stronger self-closed loops** | Tighter verify/adjust cycles, richer success criteria, and resume continuity across longer goals. |
| **Self-evolution / self-iteration** | Safe loops where the agent improves workflows, skills, and playbooks from Evidence — always reviewable. |
| **Multi-agent collaboration** | Coordinated specialist agents under one task flow (explore / implement / review), with shared Evidence and clear handoffs. |
| **Agent swarm** | Budgeted parallel exploration / verification workers under a lead task — not unconstrained swarms. |
| **Canvas creation system** | Spatial canvas for plans, diagrams, and intermediate artifacts alongside the conversation. |

---

## 🤝 Contributing

Issues, discussions, and PRs are welcome.

1. Fork and create a branch
2. Keep changes scoped; prefer protocol/runtime seams over one-off branches
3. Add or update tests when you touch contracts, permissions, or tool execution
4. Open a PR with a clear problem statement and verification notes

Please do **not** expand renderer direct `fs` / `child_process` access, bypass Runtime Projection, or replace Evidence with free-form assistant text.

---

## 📄 License

[MIT](LICENSE) © 2026 梁音

---

<p align="center">
  <sub>Built for people who want AI that can act — with authorization, task flow, and Evidence.</sub>
</p>
