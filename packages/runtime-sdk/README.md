# @peer-agent/runtime-sdk

Public host-neutral orchestration SDK for embedding Peer Agent Runtime in a custom Node host.

## Install

```bash
npm install @peer-agent/runtime-sdk
```

The SDK depends on the matching public `@peer-agent/protocol` and `@peer-agent/runtime-core` versions.

## Main APIs

```js
import {
  createRuntimeSdk,
  createRuntimeSessionController,
  createRuntimePipeline,
} from '@peer-agent/runtime-sdk';
```

| API | Purpose |
|-----|---------|
| `createRuntimeSdk` | execute governed tool calls through a host port; emit runtime lifecycle events |
| `createRuntimeSessionController` | own session / turn / cancel / complete / fail state |
| `createRuntimePipeline` | sequence model turns, projected tool execution, and tool-result feedback |

## Host boundary

Your host implements environment-specific ports (provider execution, authorization/blocking, optional hooks, model adapter and tool executor). The SDK does not require:

- Desktop / Electron
- `@peer-agent/cli` or the `peer` binary
- TUI / OpenTUI
- `@peer-agent/runtime-node`

A runnable external-host example lives at [`examples/external-host`](../../examples/external-host). It shows provider hot-replace and packing already-admitted Evidence refs into an export document.

## Product vs SDK

| Need | Install |
|------|---------|
| Run terminal product | `npm i -g @peer-agent/cli` |
| Embed runtime | `npm i @peer-agent/runtime-sdk` |
| Desktop GUI | Desktop release |

These are parallel product surfaces, not dependency chains.

## Version policy

During beta, protocol / runtime-core / runtime-sdk follow the repository root `VERSION` and publish with the same npm dist-tag as CLI/Desktop releases.
