# @peer-agent/protocol

Host-neutral TypeScript contracts shared by Peer Agent runtimes and clients.

## Install

```bash
npm install @peer-agent/protocol
```

## Scope

This package owns serializable cross-layer contracts such as capability projection, permission grants, tool calls and results, execution records, chat messages, goals, memory, system context, and updater state.

It contains no Electron, filesystem, child-process, network, or UI implementation.

```ts
import type {
  ClientToolCall,
  ClientToolResult,
  PermissionGrant,
  RuntimeExecuteRequest,
} from '@peer-agent/protocol';
```

Use the package root export only. Deep imports into `src` or `dist` are not public API.

## Compatibility

`@peer-agent/protocol` follows SemVer independently from the Peer Agent Desktop application. Runtime packages in the same `0.x` minor line declare their supported protocol range explicitly.

See `@peer-agent/runtime-sdk` for host-neutral orchestration.
