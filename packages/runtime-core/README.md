# @peer-agent/runtime-core

Host-neutral capability, permission, projection, and Evidence primitives for Peer Agent runtimes.

## Install

```bash
npm install @peer-agent/runtime-core
```

Use it to build a capability provider registry, project host capabilities into model-visible tools, merge grants/hooks, pack already-admitted Evidence for export, and create/validate Evidence without depending on Electron, TUI, filesystem, or Shell implementations.

```js
import {
  createCapabilityProviderRegistry,
  createEvidenceExportDocument,
} from '@peer-agent/runtime-core';

const registry = createCapabilityProviderRegistry();
registry.register(provider);
registry.replace(nextProvider);
```

## Boundary

- **Public:** capability/provider interfaces, projection, permission/grant logic, Evidence primitives.
- **Not included:** Node file/Shell adapters (`@peer-agent/runtime-node` is private), Desktop IPC, UI, model credentials.

## Version policy

Follows the repository root `VERSION` and the same release tag as protocol / runtime-sdk / CLI / Desktop during beta.
