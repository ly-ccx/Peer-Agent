# @peer-agent/runtime-sdk

Public, host-neutral orchestration SDK for Peer Agent Runtime.

The SDK owns execution ordering, session and turn lifecycle, structured cancellation, Runtime Event sequencing, Hook coordination, approval flow, Provider dispatch, and Evidence attachment. Hosts supply environment-specific implementations. The package does not depend on Electron, filesystem APIs, child processes, network clients, or UI frameworks.

## Package family

Install the SDK and its public package dependencies:

```bash
npm install @peer-agent/runtime-sdk
```

The published Runtime family is:

| Package | Responsibility |
| --- | --- |
| `@peer-agent/protocol` | Serializable contracts shared by runtimes and clients |
| `@peer-agent/runtime-core` | Capability, projection, permission, Hook, and Evidence primitives |
| `@peer-agent/runtime-sdk` | Host-neutral orchestration, events, pipeline, and session lifecycle |

`@peer-agent/runtime-node` is a host adapter and is not part of the initial public package family.

## Requirements

- Node.js 20 or newer
- ESM
- TypeScript 5.x when consuming type declarations

Use package root exports only. Deep imports into `src` or `dist` are not public API.

## Runtime Host Adapter

A host provides capability execution and failure-result construction. Hook execution, human approval, and Evidence attachment are optional ports.

```ts
import {
  createRuntimeSdk,
  type RuntimeSdkHostAdapter,
} from '@peer-agent/runtime-sdk';

const host: RuntimeSdkHostAdapter = {
  executeProvider: (request, context) => providerRegistry.execute(request, context),
  createBlockedExecution: ({ request, decision, reason }) =>
    makeBlockedExecution(request, decision, reason),
  hookRunner,
  approvalPort,
  appendHookEvidence,
};

const runtime = createRuntimeSdk({ host });
runtime.subscribe((event) => renderRuntimeEvent(event));
const execution = await runtime.execute(request, context);
```

The governed tool path is:

```text
tool.started
  -> PreToolUse Hook
  -> optional human approval
  -> Capability Provider
  -> PostToolUse Hook
  -> Evidence attachment
  -> tool.completed
```

A Hook may tighten a decision from `allow` to `ask` or `deny`; it must not bypass a stricter permission decision. If `ask` has no approval port, execution fails closed.

## Session Controller

`RuntimeSessionController` owns stable session identity, monotonic turn indexes, turn IDs, and the AbortSignal used by Provider work.

```ts
import { createRuntimeSessionController } from '@peer-agent/runtime-sdk';

const sessions = createRuntimeSessionController();

const firstTurn = sessions.start({
  sessionId: 'conversation-42',
  conversationId: 'conversation-42',
  streamId: 'stream-1',
});
await runProvider({ signal: firstTurn.signal });
firstTurn.complete();

const resumedTurn = sessions.resume({
  sessionId: 'conversation-42',
  streamId: 'stream-2',
});
resumedTurn.cancel('user_aborted');
```

Rules:

- A session has at most one active turn.
- `resume` keeps the session identity and increments `turnIndex`.
- `cancel` and `fail` abort the SDK-owned signal.
- A late `complete` cannot overwrite an existing `cancelled` or `failed` terminal state.
- UI stream reattachment and replay remain host concerns; they are not Runtime resume semantics.

## Runtime Pipeline

`createRuntimePipeline` runs model turns and projected tool calls while preserving structured cancellation. A host adapter converts `cancelled` into platform-specific behavior such as Desktop `AbortError` or terminal UI state.

```ts
import { createRuntimePipeline } from '@peer-agent/runtime-sdk';

const pipeline = createRuntimePipeline({
  modelTurnRunner,
  toolExecutor,
  eventSink,
});

const result = await pipeline.run(turnContext, { signal });
if (result.status === 'cancelled') {
  // Convert only at the host boundary.
}
```

## Runtime Event protocol

Runtime Event v1 is identified by `RUNTIME_EVENT_PROTOCOL_VERSION`. One Runtime emitter assigns a monotonically increasing `sequence` to all emitted events. Session resume must continue on the same emitter when a host needs cross-turn ordering.

Subscribers are observational: a subscriber failure does not interrupt Provider execution or delivery to other subscribers.

## Compatibility policy

- `@peer-agent/protocol`, `@peer-agent/runtime-core`, and `@peer-agent/runtime-sdk` follow SemVer independently from the Desktop and TUI products.
- The initial public package family is versioned `0.1.0`.
- The SDK declares compatible Protocol and Core ranges as normal package dependencies.
- Breaking public root-export, event, session, or host-port changes require a SemVer minor bump while the packages remain `0.x`.
- Runtime Event protocol changes require an explicit protocol version change and compatibility notes.
- Source file paths, test helpers, Desktop adapters, and Node host internals are not public API.

## Release verification

The monorepo validates the exact tarballs rather than relying on workspace symlinks:

```bash
pnpm runtime:pack-check
pnpm runtime:pack-smoke
```

These checks build and pack all three public packages, reject leaked source/test/Desktop files, install the tarballs into an empty offline project, run an ESM consumer, compile an external strict TypeScript consumer, verify dependency ranges, and confirm deep imports are blocked.

Package metadata is prepared for public npm access, but registry publication is a separate explicit operation requiring scope permission, credentials, version, and dist-tag confirmation.
