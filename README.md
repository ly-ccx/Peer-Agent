<p align="center">
  <img src="docs/logo.png" alt="Peer Agent" width="120" />
</p>

<h1 align="center">Peer Agent</h1>

<p align="center">
  <strong>A fully open-source, local-first Task Flow Agent — work moves through task handoff, continuity, and follow-up questions; authorized, planned, and proven on your machine.</strong>
</p>

<p align="center">
  Fully open source (MIT) · Local-first · Permission-gated · Evidence-backed · Task flow by default
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
  <a href="#-task-flow-handoff-continuity-follow-up">Task Flow</a> ·
  <a href="#-what-you-can-do">Features</a> ·
  <a href="#-architecture-at-a-glance">Architecture</a> ·
  <a href="#-product-vision">Vision</a> ·
  <a href="#-roadmap">Roadmap</a>
</p>

---

Many coding agents already run tools on your machine. That alone is no longer a differentiator.

**Peer Agent is fully open source (MIT)** — not an "open shell around a closed core": Desktop, TUI, CLI, the runtime, the protocol, and every capability manifest ship under the same [LICENSE](LICENSE). Audit every line of permission code, fork your own branch, or embed the runtime in your own host.

**Peer Agent is about what happens after local execution:** goals are accepted with boundaries, ambiguity is clarified instead of guessed, work is planned by complexity, and completion is proven with Evidence — under one permissioned capability chain across Desktop, TUI, and CLI.

Three first-class shells share one unified core runtime:

| Surface | What it is |
| --- | --- |
| **Desktop** | Task threads, composer, review cards, Workbench, tray |
| **TUI** | Full terminal agent (`peer`) with the same runtime |
| **CLI** | Installable `@peer-agent/cli` — scriptable entry to the same machine |

> [!NOTE]
> Current stable release: **`0.0.5`** (npm `latest`); latest published beta channel **`0.0.5-beta.4`**. Desktop, TUI/CLI, Agent/Plan/Goal workflows, Automation, MCP, Skills, and the Open Runtime are available today — see [Roadmap](#-roadmap).

---

## ✨ Why Peer Agent

| | |
| --- | --- |
| 📜 **Fully open source (MIT)** | The entire chain — Desktop, TUI, CLI, runtime, protocol, capability manifests — ships under one MIT license. Auditable, forkable, embeddable; no "open shell around a closed core". |
| 🎯 **Task flow, not tool chat** | Goals are accepted with boundaries, clarified when needed, planned by complexity, and closed against explicit success criteria. |
| ✅ **Definition of Done as code** | `successCriteria`, `criterionResults`, and `evidenceRefs` turn “done” into a verifiable gate — not an assistant claim. |
| 🔒 **Local execution, explicit trust** | Tools run on *your* machine under `PermissionGrant`. Cognition can come from any model provider — capability power stays local and auditable. |
| 🔐 **OS-backed encrypted secrets** | The OS keychain stores the vault master key; Provider API keys and OAuth tokens stay in a local AES-256-GCM encrypted vault, never in plain settings files. |
| 🌐 **Bring any model** | Use official APIs, OAuth/subscription channels, Coding Plans, or a custom OpenAI / Anthropic-compatible endpoint with your own `baseUrl`, model ID, and capability metadata. |
| 🧑‍🏫 **Main + fallback model routing** | Keep your preferred model in charge; if it cannot read images, an optional fallback vision model interprets them and silently hands text back to the main model. |
| 🧾 **Evidence is a first-class result** | Artifacts, logs, metadata, denial, timeout, and failure remain structured facts that UI and automation can inspect. |
| 🧩 **One governed capability chain** | Shell, files, browser, MCP, plugins, and skills all flow through Manifest → Projection → Permission → Evidence. No hidden side doors. |
| 🔌 **Embeddable Open Runtime** | Public, host-neutral `protocol`, `runtime-core`, and `runtime-sdk` packages let another Node host embed the same governed runtime without Electron. |
| 🔁 **Long-task continuity** | Goal state, pause/resume, `waiting_user`, compact summaries, context checksums, and continuity sources let work survive interruptions without treating a summary as proof. |
| 🖥️ **One core, multiple surfaces** | Desktop, TUI, and the `peer` CLI share runtime, System Context, and data under `~/.peer-agent`; the interfaces do not fork the execution truth. |

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

## 🧠 Task Flow: Handoff, Continuity, Follow-up

Peer Agent treats multi-step work as a **task**, not a free-form chat turn. Tasks are first-class citizens — each with its own objective, boundaries, success criteria, and lifecycle.

### Handoff — a task has a lifecycle

From acceptance to closure, a task walks an explicit chain:

```text
Accept (objective + boundaries + success criteria) → Clarify → Plan (L0–L3 depth) → Execute → Verify → Acceptance & close
```

- **Planning depth scales with complexity**: L0 answers directly; L1 runs a short plan before acting; L2 drives a self-directed GoalPlan with trackable subtasks; L3 high-risk / irreversible work goes through an explicit **Plan** review before any side effect.
- **Agent is the default**; **Plan** is the brake when you want review first.
- **Dispatch–acceptance loop**: tasks can be dispatched (e.g. cloud-scheduled execution) — but only after you approve or reject the dispatch. The dispatched run walks an explicit `dispatching → acked → running → result_received` state chain; results pass a quality self-check, then wait for **your acceptance** before they count as delivered — not "the model says it's done".
- Subtasks and success criteria close only with real tool results and Evidence — not "done" prose.

### Continuity — interruption is not the end

Real work gets interrupted: contexts fill up, processes restart, you step away for lunch. Peer Agent treats these as first-class scenarios:

- **Persistent Goal state**: the plan graph, subtask status, success criteria, and Evidence are all persisted — tasks survive across sessions.
- **Pause / resume / `waiting_user`**: a task can park on "waiting for your reply" and continue from the breakpoint when you return, without losing context.
- **Compact summaries + context checksums**: long-task context is compacted into a continuity summary to keep going — but a summary is **continuity context, not proof**. Closing a task always requires real tool results.
- Read-only Explorer workers may investigate in parallel, while the lead task flow retains scope, budget, and completion ownership.

### Follow-up — ask when stuck, never guess

When material information is missing, Peer Agent's rule is **ask, don't guess**:

- **Structured follow-up**: the `request_user_input` tool asks with clickable options — you pick instead of typing a paragraph. Your reply is recorded as a persistent state transition.
- **Ask at the right moment**: only critical ambiguity, risky trade-offs, or missing permissions interrupt you; routine execution stays quiet.
- **Answers belong to the task**: follow-up replies attach to the task itself — on the next resume or the next dispatch, the answer is still there.

Task flow and the capability chain each govern their own half: task flow decides *what work is accepted and when it's finished*; local execution always goes through one chain:

```text
Capability Provider → Manifest → Runtime Projection → Tool Call → PermissionGrant → Evidence
```

The capability chain decides *how* local power is authorized and proven.

---

## 🚀 What You Can Do

### 📡 Multi-channel access — any entry point, same machine

It doesn't matter where work enters — config, permissions, and Evidence are always the same:

| Channel | What it covers |
| --- | --- |
| **Surface channels** | 🖥️ Desktop (task threads, review cards, Workbench + embedded Browser) · ⌨️ TUI / `peer` CLI · ⚡ Quick Chat lightweight global chat |
| **Model channels** | Official APIs · OAuth / subscription sign-in · Coding Plan templates · custom OpenAI / Anthropic-compatible endpoints — freely mixed; model IDs, headers, reasoning, vision, cache, and pricing metadata are all configurable |
| **Integration channels** | ⏰ Automation scheduled / recurring runs · 🔌 MCP servers (stdio / HTTP / SSE) · 🌐 web fetch and browser interaction |

> “Shared across surfaces” means the same user and data home on one machine. Peer does not claim cloud synchronization of secrets across devices.

### 🧩 Rich pluggability — capabilities snap into one contract

- 🔌 **MCP as a first-class citizen** — external MCP servers plug straight in and go through the same permission + Evidence pipeline as built-ins; no side door
- 🏪 **Plugin & skill marketplace** — Marketplace-style install, enable/disable, and updates; skills trigger workflows on demand
- 🧱 **Declarative capability manifests** — every capability is described by a manifest (permissions, entry points, parameters) and projected uniformly into model-visible tools
- 🔌 **Open Runtime SDK** — `@peer-agent/protocol` / `runtime-core` / `runtime-sdk` let any Node host embed the same governed capability pipeline; host-neutral, not tied to Electron
- 📎 **Governed context admission** — attachments, files, and web content enter context through explicit admission paths, not free-form prompt injection

### 📋 Task dispatch & acceptance — work can be delegated, the accountability chain cannot

- ✅ **Dispatch needs your consent** — dispatching a task (e.g. cloud-scheduled execution) requires your approve/reject first; nothing ships out silently
- 🔗 **Explicit state chain** — `dispatching → acked → running → result_received`, every step observable
- 🧪 **Quality self-check + user acceptance** — results pass a quality self-check, then wait in a pending-acceptance state; it counts as delivered only after you accept
- 🌿 **Isolated runs** — repository jobs can run in a dedicated Git worktree and return commit / diff artifact refs and a receipt, never silently mutating your active checkout
- 🗣️ **Roundtable** — multi-participant sessions under a governance mode; interject into the current roundtable at any time

### 🔐 Own your model stack & credentials

- 🔐 **One secure credential vault** — macOS Keychain, Windows Credential Manager, or Linux Secret Service protects a random 32-byte master key; Provider secrets are encrypted locally with AES-256-GCM
- 🧑‍🏫 **Main + fallback vision** — Choose any main model for reasoning and optionally pair it with a vision-capable fallback; image recognition stays a supporting role and the main model continues the task

### 🛡️ Control the machine (safely)

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
peer exec "summarize this repo"
```

The npm package downloads the platform `peer` binary from GitHub Releases on install. macOS arm64 (`peer-darwin-arm64.tar.gz`) is first-class today; other platforms fail clearly in postinstall until multi-platform CLI builds ship.

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

The architecture starts from a single point: the **agent runtime**. Everything else is a layer peeled off it.

### Layer 1: The runtime core — capability, authorization, evidence

The bottom layer answers one question: *when the model wants a local capability, on what authority does it run, and how is it proven?*

```text
Capability Provider → Manifest → Runtime Projection → Tool Call → PermissionGrant → Evidence
```

`@peer-agent/runtime-core` is the pure implementation of this core: capability registry, manifests, projection, authorization, and Evidence primitives, plus context compaction and accounting. It knows nothing of Electron, terminals, or any product shape — only contracts. `@peer-agent/protocol` defines the contracts themselves (chat, execution, goal, system-context, automation, compaction — 13 domains) as cross-layer types, so every layer speaks the same language.

**No side doors.** Bash, files, search, MCP, plugins, skills — every capability flows through the same chain. That is the non-negotiable part of this architecture.

### Layer 2: System Context — what the model sees

The runtime executes capabilities, but the model first needs *context*. `@peer-agent/system-context` is the canonical assembler for System Context: prompt-source registration, layering, checksums, and snapshots. Project instructions, mode reminders, tool prompts, and compact summaries enter through explicit Context Sources — not scattered string concatenation. Tool output and file content are factual context and are never promoted into system instructions.

### Layer 3: The task-flow kernel — how work moves

Above capability and context sits the machinery of tasks: `@peer-agent/chat-kernel` (reducer-driven conversation state machine) and `@peer-agent/task-thread` (task-thread event model) carry handoff, continuity, and follow-up; the goal contract defines GoalPlans, subtasks, and success criteria; `@peer-agent/conversation-store` persists it all so tasks survive across sessions.

### Layer 4: The Node host — landing on a real machine

`@peer-agent/runtime-node` lands the core in a Node environment: MCP server integration, the Automation scheduler, the chat runtime, and encrypted credentials (with `@peer-agent/credential-helper` and the system Secret Service). `@peer-agent/runtime-sdk` opens the same orchestration to any Node host for embedding.

### The surface layer: expression and interaction

Desktop (`apps/desktop`), TUI, and CLI (`apps/tui` + `@peer-agent/cli`) do expression and interaction only — they hold no execution truth. Host-neutrality is not a slogan, it is a dependency fact: the TUI depends on no UI packages, only on `protocol + runtime-core + runtime-node + runtime-sdk + system-context`; Desktop additionally uses `chat-kernel / task-thread / ui / i18n`. One machine, one `~/.peer-agent` — different surfaces, one truth.

```text
┌──────────────────────────────────────────────────────────┐
│  Desktop / TUI / CLI        (expression + interaction)  │
└───────────────────────────┬──────────────────────────────┘
                            │ protocol / IPC
┌───────────────────────────▼──────────────────────────────┐
│  Agent Runtime                                            │
│  ① runtime-core + protocol   capability chain · auth · Evidence │
│  ② system-context            Context Sources · assembly  │
│  ③ chat-kernel + task-thread task flow · goal · persistence │
│  ④ runtime-node              MCP · Automation · credentials │
│  ⑤ runtime-sdk               host embedding              │
└───────────────────────────┬──────────────────────────────┘
                            │ provider routing / model API
┌───────────────────────────▼──────────────────────────────┐
│  Cognition (your model stack)  Official · OAuth/subscription · Coding Plan · custom │
└──────────────────────────────────────────────────────────┘
```

### Repository layout

```text
peer_agent/
├── apps/            # Desktop, TUI/CLI product shells
├── packages/        # protocol · runtime-core/node/sdk · system-context
│                    # chat-kernel · task-thread · conversation-store
│                    # credential-helper · i18n · ui · npm-cli
├── capabilities/    # Capability manifests (local.shell.* / local.web.* / …)
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
| Secure shared Provider/model configuration | ✅ Available |
| Main model + fallback vision routing | ✅ Available |
| MCP · Plugins · Skills | ✅ Available |
| Automation (scheduled agents) | ✅ Available |
| Task dispatch & acceptance (cloud scheduling + user acceptance) | ✅ Available |

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
