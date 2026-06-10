# Peer Agent Development Rules

This file governs the entire repository. All future code changes in this repository must follow these rules unless the user explicitly asks to change the architecture decision itself.

## Architecture Baseline

Peer Agent follows the 端云能力代理设计原则:

```text
云端负责认知。
本地负责能力。
界面负责表达。
契约负责边界。
证据负责治理。
```

The detailed governance baseline is in `docs/architecture/20-architecture-governance.md`. Existing architecture context is in:

- `docs/architecture/00-engineering-philosophy.md`
- `docs/architecture/01-project-structure.md`
- `docs/architecture/15-plugin-skill-mcp-system.md`
- `docs/architecture/16-skill-call-lifecycle.md`
- `docs/architecture/19-system-prompt-context-architecture.md`

These documents are part of the engineering contract, not background reading. When a code change touches chat runtime, prompt assembly, tool execution, permissions, Evidence, compaction, attachments, provider request lowering, or runtime projection, update the relevant architecture document in the same change unless the document already matches the new behavior.

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

- Cloud Runtime owns cognition, planning, tool choice, governance, and execution ledger state.
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
