<p align="center">
  <img src="docs/logo.png" alt="Peer Agent" width="120" />
</p>

<h1 align="center">Peer Agent</h1>

<p align="center">
  <strong>The AI agent that lives on your machine — not in someone else's cloud.</strong>
</p>

<p align="center">
  Local-first · Permission-gated · Evidence-backed · Task-flow by default
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
  <a href="#-task-flow">Task Flow</a> ·
  <a href="#-what-you-can-do">Features</a> ·
  <a href="#-architecture-at-a-glance">Architecture</a> ·
  <a href="#-roadmap">Roadmap</a>
</p>

---

Most AI assistants run their “tools” on a server you can’t see, with access you can’t audit.

**Peer Agent flips that.** Every capability runs **locally**, every action needs your **authorization**, and every result leaves a **verifiable trace**. Your AI gets hands — you keep the keys.

Three first-class shells share one runtime:

| Surface | What it is |
| --- | --- |
| **Desktop** | Task threads, composer, review cards, Workbench, tray |
| **TUI** | Full terminal agent (`peer`) with the same runtime |
| **CLI** | Installable `@peer-agent/cli` — scriptable entry to the same machine |

> [!NOTE]
> Current series: **`0.0.2-beta`** (prerelease; `0.0.1` remains stable / latest). Desktop, TUI/CLI, Agent/Plan workflows, Automation, and MCP are usable today. On-device LLM inference (Local Agent Runtime) is still in progress — see [Roadmap](#-roadmap).

---

## ✨ Why Peer Agent

| | |
| --- | --- |
| 🔒 **Privacy-first** | Capabilities execute on *your* machine. Files, commands, and local state are not shipped to a third-party tool server. |
| ✅ **Permission-gated** | No tool runs without a `PermissionGrant`. Authorization is enforced by the runtime — not by a polite prompt. |
| 🧾 **Evidence-backed** | Every capability call returns structured Evidence (artifacts, logs, metadata) you can inspect after the fact. |
| 🧩 **One governed runtime** | Shell, files, web/browser, MCP, plugins, and skills all flow through a single chain. No hidden side doors. |
| 🖥️ **Multi-surface** | Desktop GUI, terminal TUI, and `peer` CLI share `~/.peer-agent` data and the same local runtime. |
| 🎯 **Task-flow by default** | Goals are **accepted**, ambiguity is **clarified**, work is **auto-planned**, and completion is **evidence-backed**. |

---

## 🧠 Task Flow

Peer Agent is a **Task Flow Agent** — not a chat bot that freelances on your disk.

```text
任务先签收，再开工。
模糊就追问，不猜着做。
按复杂度自动规划。
卡住才打断，完成靠证据。
```

```text
Goals are accepted before work starts.
Ambiguity triggers follow-up questions — no silent guessing.
Work is auto-planned by complexity (L0–L3).
Interrupt only when blocked; finish only with evidence.
```

### How it shows up

| Step | What happens |
| --- | --- |
| **1. Task acceptance / 任务签收** | A goal is rewritten into a clear objective, boundaries, and success criteria *before* side effects land. You can see what the agent took on. |
| **2. Follow-up questions / 追问澄清** | Missing decisions, risky trade-offs, or permission gaps surface as structured asks — not silent mid-run assumptions. |
| **3. Auto-planning / 自动规划** | **Agent** (default) picks depth: direct answers, micro-plans, self-driven GoalPlans, or gated Plan review. **Plan** is the explicit human brake for high-risk work. |
| **4. Evidence-backed completion** | Subtasks and success criteria close only with real tool/Evidence results — not “done” prose. |

Local power stays governed either way:

```text
Capability Provider
  → Manifest
    → Runtime Projection
      → Tool Call
        → PermissionGrant
          → Evidence
```

**Task flow** owns *how work is accepted and finished*.  
**The capability chain** owns *how local power is authorized and proven*.

---

## 🚀 What You Can Do

### Work the way that fits

- 🖥️ **Desktop app** — Task threads, composer, review cards, Workbench, tray/lifecycle, glass-style shell
- ⌨️ **TUI / CLI (`peer`)** — Full terminal agent; install via `@peer-agent/cli` or build from source
- ⚡ **Quick Chat** — Lightweight global chat without opening a full task thread
- 🎯 **Agent & Plan modes** — Agent auto-plans and executes (L0–L3); Plan requires review before side effects
- 📋 **Goal runner / task flow** — Accept the goal, clarify when stuck, track subtasks, close only with evidence

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
                             │ model API (cloud or future local)
┌────────────────────────────▼────────────────────────────────┐
│  Cognition (role, not location)                             │
│  Cloud provider today · on-device Local Agent Runtime later  │
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

## 🗺️ Roadmap

| Area | Status |
| --- | --- |
| Local capability runtime + Evidence | ✅ Available |
| Desktop · TUI · CLI shells | ✅ Available |
| Agent / Plan / Goal task flow | ✅ Available |
| MCP · Plugins · Skills | ✅ Available |
| Automation (scheduled agents) | ✅ Available |
| On-device LLM (Local Agent Runtime) | 🚧 In progress |
| Broader marketplace ecosystem | 🚧 Growing |

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
  <sub>Built for people who want AI that can act — without giving up the machine.</sub>
</p>
