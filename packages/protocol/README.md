# @peer-agent/protocol

Host-neutral protocol contracts for Peer Agent runtimes, hosts, and clients.

## Install

```bash
npm install @peer-agent/protocol
```

`@peer-agent/protocol` contains the cross-host contract layer: runtime tool calls/results, capability manifests, grants, Evidence, Goal/task contracts, session/runtime snapshots, and related TypeScript types.

It does **not** execute local tools, access Electron, or install the `peer` CLI.

## Who should use it

- custom Peer Agent hosts / adapters
- integrations that exchange runtime events or tool contracts
- TypeScript libraries that need stable host-neutral types

Most external hosts can install `@peer-agent/runtime-sdk`; it brings protocol transitively. Install protocol directly when you only need contracts/types.

## Version policy

The public Open Runtime packages follow the repository root `VERSION` and the same release tag as Desktop / CLI during beta.
