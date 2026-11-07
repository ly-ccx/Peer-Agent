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

## Safe HTTP diagnostics and request budgets

`createOpenAICompatibleProvider` uses `encodeOpenAICompatibleRequest(request)` from `@peer-agent/runtime-node/models` for both preflight inspection and actual sending. Measure the encoded UTF-8 bytes when a host imposes a request budget; JSON bytes are not model tokens. The host owns its durable active history and compaction policy.

`ModelProviderHttpError` retains `status` and `providerId` and adds optional safe diagnostic facts. HTTP error reads are bounded to 64 KiB and 1.5 seconds. Object and string JSON errors, known error codes and recognized provider assertions produce fixed diagnostic labels; unknown plaintext, HTML, request echoes and credentials are not copied to the exception or trace. Responses and chat adapter HTTP failures use the same reader. Cancellation of the request still propagates as cancellation.

A host talking to its own authenticated gateway may set `trustGatewayErrors: true` to accept the documented `gateway_validation` budget codes and numeric limits. Leave this disabled for arbitrary upstream services. Diagnostics do not authorize retries, provider failover, tool replay or history deletion. An error may have no detail when the response cannot be safely categorized.
