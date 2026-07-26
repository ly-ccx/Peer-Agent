# External host example (open runtime only)

This sample shows how to consume Peer Agent **open runtime** packages without installing Desktop or CLI.

## What you install

```bash
npm install @peer-agent/protocol @peer-agent/runtime-core @peer-agent/runtime-sdk
```

Or pin the product version (same as `VERSION` / CLI / Desktop tag):

```bash
npm install @peer-agent/runtime-sdk@0.0.1-beta.41
```

## What you do **not** need

- Electron / Desktop App
- `@peer-agent/cli` / `peer` binary
- `@peer-agent/runtime-node` (private host adapter; not public product surface)

## Run from this monorepo

```bash
# from repo root
pnpm --filter @peer-agent/protocol build
pnpm --filter @peer-agent/runtime-core build
pnpm --filter @peer-agent/runtime-sdk build

cd examples/external-host
npm install
npm start
```

Expected: JSON with `"ok": true` and completed session/pipeline statuses.

## What this proves

| Package | Role in the sample |
|---------|--------------------|
| `@peer-agent/protocol` | Shared contracts (types; often transitive via sdk) |
| `@peer-agent/runtime-core` | Capability registry primitives |
| `@peer-agent/runtime-sdk` | `createRuntimeSdk` / session / pipeline orchestration |

Your host only implements environment ports (provider execution, blocking, optional hooks).  
The open runtime owns ordering, turn lifecycle, and event sequencing.

## Product vs library install

| Want | Install |
|------|---------|
| Terminal product (`peer`) | `npm i -g @peer-agent/cli` |
| Embed runtime in your host | `npm i @peer-agent/runtime-sdk` (+ protocol/core as resolved) |
| Desktop GUI | Desktop release artifacts |

These are **parallel product surfaces**, not nested dependencies.
