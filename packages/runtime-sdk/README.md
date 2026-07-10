# @peer-agent/runtime-sdk

Public, host-neutral orchestration boundary for Peer Agent Runtime.

The SDK owns execution ordering and emits structured runtime events. A host supplies capability execution, Hook adapters, human approval, failure-result creation, and Evidence attachment. The package must not depend on Electron, filesystem APIs, child processes, or UI frameworks.

## Version and distribution policy

- The SDK has its own SemVer and is maintained in the Peer Agent monorepo.
- During boundary stabilization it remains private and uses `0.x` versions.
- Desktop and TUI depend on an exact resolved SDK version and bundle it into their own release artifacts; users do not install or download the SDK at runtime.
- Desktop, TUI, and SDK product versions do not need to match. Compatibility is governed by the Runtime protocol and shared contract tests.
- Workspace development uses `workspace:*`; release metadata must record the resolved SDK version and Git SHA.

## TUI policy

Peer Agent builds its own TUI product layer on an open-source terminal framework. OpenTUI is the primary candidate and Ink is the fallback. The project will not maintain a long-lived fork of a complete third-party agent product and will not reimplement terminal rendering from ANSI primitives. Framework types stay behind a TUI adapter and never enter this SDK's public interfaces.

## First public slice

```ts
import { createRuntimeSdk } from '@peer-agent/runtime-sdk';

const runtime = createRuntimeSdk({
  host: {
    executeProvider: (request, context) => providerRegistry.execute(request, context),
    createBlockedExecution: ({ request, decision, reason }) =>
      makeBlockedExecution(request, decision, reason),
    hookRunner,
    approvalPort,
    appendHookEvidence,
  },
});

runtime.subscribe((event) => render(event));
await runtime.execute(request, context);
```

The first migrated Desktop slice preserves this order:

```text
tool.started
  -> PreToolUse Hook
  -> optional human approval
  -> Capability Provider
  -> PostToolUse Hook
  -> Evidence attachment
  -> tool.completed
```
