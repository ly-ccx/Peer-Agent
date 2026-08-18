# Peer Agent Development Rules

This file governs the entire repository. All future code changes in this repository must follow these rules unless the user explicitly asks to change the architecture decision itself.

## Architecture Baseline

Peer Agent follows the 端云能力代理设计原则:

```text
模型负责认知。
本地负责能力。
界面负责表达。
契约负责边界。
证据负责治理。
```

`模型` names a role, not a deployment location: cognition may come from a cloud provider or from a future on-device runtime. Capability execution, authorization, and Evidence remain local either way.

Architecture knowledge lives in the companion knowledge base `peer-knowledge` (not in this code repo). The detailed governance baseline is in `peer-knowledge/knowledge/architecture/20-architecture-governance.md`. Existing architecture context is in:

- `peer-knowledge/knowledge/architecture/00-engineering-philosophy.md`
- `peer-knowledge/knowledge/architecture/01-project-structure.md`
- `peer-knowledge/knowledge/decisions/15-plugin-skill-mcp-system.md`
- `peer-knowledge/knowledge/decisions/16-skill-call-lifecycle.md`
- `peer-knowledge/knowledge/architecture/19-system-prompt-context-architecture.md`

These documents are part of the engineering contract, not background reading. Treat them as read-only reference material by default.

Companion knowledge identity (not a machine path):

- Remote: `https://github.com/ly-ccx/Peer-Knowledge`
- Local directory aliases: `Peer-Knowledge`, `peer-knowledge`

Resolve the knowledge root in this order. Never commit a user-specific absolute path.

1. Environment variable `PEER_KNOWLEDGE_ROOT` if it points at an existing directory.
2. Optional gitignored file `.peer-workspace.local.json` in this repo root (`peerKnowledgeRoot`).
3. A sibling directory of this repo that matches a knowledge alias.
4. An already-open multi-root workspace folder that is the knowledge repo.

If none resolve, ask. Do not invent a home-directory path or write one into git.

## Workspace Entry

This code repo is the default daily entry. Open it as the primary workspace root. Mount `peer-knowledge` beside it when review or durable knowledge writes are needed.

- C-level: edit this repo directly.
- B-level: edit this repo and state the architecture impact. Write back to `peer-knowledge` if a boundary actually moved.
- A-level: review and update the architecture document or ADR in `peer-knowledge` first, then implement here.

Starting a session in the knowledge repo does not make the knowledge repo the delivery target. Commits follow the change: code here, decisions there. The short intake playbook is `peer-knowledge/playbook/change-intake.md`.

## User Repository Preference: Architecture Docs Live in peer-knowledge

Do not recreate, stage, or submit architecture / design knowledge under `docs/architecture/*` or other knowledge trees in this code repo unless the user explicitly asks. If a code change would normally require architecture documentation, explain the architecture impact in the response and write durable knowledge into `peer-knowledge` instead.

## Non-Negotiable Runtime Chain

All local capabilities must flow through:

```text
Capability Provider
  -> Manifest
    -> Runtime Projection
      -> Tool Call
        -> PermissionGrant
          -> Evidence
```

Do not create separate execution paths for Bash, file operations, MCP, Plugin, Skill, attachments, app automation, or future multimodal capabilities.

## Layer Rules

- The desktop client owns local discovery, local authorization, local execution, and Evidence return.
- Renderer owns presentation and user interaction only.
- Protocol owns cross-layer contracts.
- Evidence owns factual accountability.
- System Context owns context admission, not tool execution.

## System Context Rules

- System prompt construction must be treated as System Context assembly, not ad hoc string concatenation.
- New project instructions, mode reminders, tool prompts, compact summaries, Skill hints, Plugin hints, and MCP capability hints must enter through an explicit Context Source or documented temporary adapter.
- Tool output, file content, webpage content, and attachment content are factual/user context. Do not promote them to system instructions.
- Provider-specific request formatting belongs behind a provider encoder seam. Do not scatter OpenAI / Anthropic message-shape decisions across unrelated modules.
- Compact summaries are continuity context only. They do not replace Tool Result, Evidence, artifact refs, or rerunnable retrieval hints.

## Hard Bans

- Do not let renderer directly use `fs`, `child_process`, MCP lifecycle, or secret storage.
- Do not store permission truth only in renderer state.
- Do not render textual `[Tool call]` or `[Tool result]` claims as real tool execution.
- Do not let assistant text stand in for structured Tool Result or Evidence.
- Do not bypass Runtime Projection when exposing model-visible tools.
- Do not rely on prompt instructions as the only enforcement for permissions or capability limits.
- Do not add ad hoc cross-process payloads when a protocol object should exist.
- Do not keep growing god modules such as chat runtime, tool runtime, prompt assembly, or large React surfaces when a deeper Module seam is needed.

## Module Design Rules

Use these terms in architecture work:

- Module: anything with an Interface and Implementation.
- Interface: everything a caller must know, including types, invariants, ordering, errors, permissions, and config.
- Implementation: the code inside the Module.
- Depth: high leverage behind a small Interface.
- Seam: where behavior can be replaced.
- Adapter: a concrete implementation at a Seam.
- Leverage: what callers gain.
- Locality: where change and debugging stay concentrated.

New Modules must increase Locality or Leverage. Avoid shallow pass-through wrappers.

## Change Discipline

Before implementing a non-trivial change, classify it:

- A-level: changes runtime contracts, capability exposure, permissions, Evidence, System Context ordering, or storage boundaries. Write or update an architecture document or ADR first.
- B-level: changes chat runtime, tool runtime, prompt assembly, compaction, task-thread event model, or IPC surfaces. Explain the architecture impact.
- C-level: local UI, styles, copy, tests, or small bug fixes. Keep it scoped, but upgrade to A/B if it touches capability, permission, Evidence, protocol, or prompt boundaries.

## Implementation Expectations

- Prefer existing protocol types, reducers, registries, providers, and stores.
- Add a Provider adapter instead of adding `capabilityId` branches to central hosts.
- Add reducer/kernel logic instead of growing a large React component.
- Add a prompt/context source instead of concatenating new system prompt strings in multiple places.
- Add attachment or multimodal handling as governed context admission, not as hidden prompt injection.
- Preserve structured cancellation, denial, timeout, failure, and Evidence paths.
- Add focused tests when changing contracts, reducers, permission behavior, compaction, prompt assembly, or tool execution.

## Legacy Code

Some existing code may still violate this governance baseline. When touching legacy code:

- Do not expand the violation.
- Move the touched path toward the governed seam when practical.
- If full cleanup is too large, isolate the change and leave the next seam explicit in docs or tests.

The goal is not abstract purity. The goal is a system where model intent, local execution, user authorization, and factual Evidence stay separate and traceable.

## Cursor Cloud specific instructions

This section captures non-obvious environment/runtime caveats for Cloud Agents. Standard commands live in `README.md` and the `scripts` of the root/`apps/*` `package.json`; this section only adds what is not obvious there. The startup update script only runs `pnpm install --frozen-lockfile`; everything else below is already baked into the VM snapshot or must be run on demand.

### Toolchains (already provisioned in the snapshot)

- Node: use the nvm-managed Node (currently v22.23.2), not the `/exec-daemon/node` (v22.14) that is first on the raw `PATH`. `~/.bashrc` prepends the nvm `node`/`pnpm` (corepack) so a login/interactive shell resolves the right one. Node must be `>= 22.18` because several packages run TypeScript test files directly via `node --test src/*.test.ts` (native type stripping); the exec-daemon Node 22.14 fails these with `ERR_UNKNOWN_FILE_EXTENSION`.
- `pnpm` (10.22.0, pinned by `packageManager`) is provided through corepack on the nvm Node.
- Bun is installed (`~/.bun/bin`, on `PATH` via `~/.bashrc`) and is required by `apps/tui` (`pnpm --filter @peer-agent/tui dev|build|test`).
- Rust: the default toolchain is stable `>= 1.85` (the `peer-credential-helper` crate is `edition = "2024"`). The system lib `libdbus-1-dev` (+ `pkg-config`) is installed because the Linux `keyring`/`dbus-secret-service` crate needs it to compile.

### Building and testing

- Automated tests import each workspace package's built `dist/`, so run a build before `pnpm test` (e.g. `pnpm build`, or the per-package `pnpm --filter <pkg> build` chain). A clean checkout without `dist/` fails tests with `ERR_MODULE_NOT_FOUND` for `@peer-agent/*`.
- `pnpm test` runs every package's tests in parallel (`pnpm -r`). Timing-sensitive desktop tests (fake timers / readiness timeouts) can flake as `cancelledByParent` ("Promise resolution is still pending…") under that load. Re-run the single file/package in isolation (`node --test <file>`) to get a stable result.
- Known pre-existing failures on `main` (NOT caused by the environment — do not chase them during setup): 5 desktop tests fail deterministically (`full-disk-access-drag-float`, `goal-plan-store` ×2, `qoder-private-adapter`, `task-overview-aggregator`); `pnpm typecheck` reports one error in `packages/protocol/src/goal.test.ts`; `pnpm architecture:check` reports 2 local `@keyframes` CSS violations.

### Running the apps

- Desktop (primary product): `pnpm dev` (root) → builds the runtime packages + credential helper, then runs Vite (`127.0.0.1:5173`) + Electron. It needs a display: `export DISPLAY=:1` (the same X server used by computer-use). The `dbus/bus.cc … Failed to connect to the bus` and `GpuControl.CreateCommandBuffer` errors in the logs are benign in this headless container.
- The credential vault relies on the OS Secret Service / keychain, which is unavailable headless. Adding an API-key provider in the UI fails with a credential-store error. For UI flows that need a configured model channel, use the "Qoder (本机 CLI)" local provider, which does not persist a secret.
- App data lives in `~/.peer-agent`. Remove or rename that directory to reset the app to first-run onboarding (0 channels · 0 models).
- TUI/CLI: `apps/tui/dist/peer` is the compiled binary (`peer --version`); `pnpm --filter @peer-agent/tui dev` runs it from source via Bun.
