# @peer-agent/runtime-node

Reusable Node host adapter and governed local Provider Bundle for `@peer-agent/runtime-sdk`.

## Public boundary

`createNodeRuntimeHostAdapter()` translates generic Runtime SDK ports into Node-host conventions:

- enrich provider execution with session, locale, workspace, and request identifiers;
- translate `PreToolUse` `ask` decisions into a host permission prompt;
- preserve denied approval grants and reasons;
- create fail-closed blocked executions and unsupported-capability fallbacks;
- attach Hook Evidence without depending on Electron.

`createNodeProviderBundle()` adds the first host-neutral Node capability set:

- `local.file.read` and `local.file.list`, limited to the configured workspace;
- `local.file.write`, guarded by an explicit `capability-approval`;
- `local.shell.exec`, with read-only auto-allow, risky-command approval, destructive-command denial, timeout, cancellation, and bounded output;
- a Runtime Projection and a Pipeline Tool Executor that resolve projected tools before calling `runtime.execute()`.

The Bundle uses the runtime-core Capability Registry as its only Provider router. It does not expose a parallel `fs` or `spawn` shortcut. The governed chain remains:

```text
Runtime Projection
  -> Runtime SDK
    -> PreToolUse Hook
      -> Hook Approval
        -> Capability Provider
          -> Capability Approval
            -> Node execution
              -> PostToolUse Hook
                -> Evidence
```

Hook approval and capability approval are separate prompts. Either gate may tighten or block execution. Workspace path validation checks lexical traversal and symbolic-link escapes. Shell cancellation terminates the spawned process group when the platform supports it.

Electron, renderer state, terminal UI, secret storage, concrete Hook process execution, and interactive approval presentation remain outside this package. Desktop and the future TUI supply those host adapters through the public ports.
