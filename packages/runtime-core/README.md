# @peer-agent/runtime-core

Host-neutral governance primitives for Peer Agent runtimes.

## Install

```bash
npm install @peer-agent/runtime-core
```

## Scope

This package provides the reusable primitives behind the Runtime governance chain:

- capability provider registry
- projection and projection materializers
- permission decisions
- Hook decision merging
- Evidence bundles

```ts
import {
  createCapabilityProviderRegistry,
  createEvidenceBundle,
  mostRestrictiveHookDecision,
} from '@peer-agent/runtime-core';
```

`@peer-agent/runtime-core` does not execute external commands and does not depend on Electron, filesystem APIs, child processes, network clients, or UI frameworks. Host-specific implementations belong in adapters such as `@peer-agent/runtime-node`.

Use the package root export only. Deep imports into `src` or `dist` are not public API.

## Compatibility

This package follows SemVer independently from the Peer Agent Desktop application. `@peer-agent/runtime-sdk` declares its supported core range as a normal package dependency.
