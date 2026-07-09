# Hooks

Peer Agent Hooks are user-configurable lifecycle checks around local capability execution.
They are designed to tighten local execution boundaries without adding a separate execution path.

Runtime chain:

```text
Capability Provider
  -> Manifest
    -> Runtime Projection
      -> Tool Call
        -> PermissionGrant
          -> Evidence
```

Hooks run inside that chain:

- `PreToolUse` runs before the Provider executes.
- `PostToolUse` runs after the Provider returns a result.
- Hook decisions and outcomes are recorded into Tool Result Evidence.

## Configuration files

Peer Agent loads Hook configuration from two locations, in order:

1. Global config: `<userDataPath>/hooks/hooks.json`
2. Workspace config: `<workspaceRoot>/.peer/hooks.json`

Both files use the same shape. Workspace hooks are appended after global hooks.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "id": "block-dangerous-shell",
        "match": {
          "capabilityId": "local.shell.exec",
          "argumentsPattern": "rm -rf*"
        },
        "command": "node .peer/hooks/block-dangerous-shell.mjs",
        "timeoutMs": 3000,
        "onError": "fail-closed"
      }
    ],
    "PostToolUse": [
      {
        "id": "audit-local-tools",
        "match": {
          "capabilityId": "*"
        },
        "command": "node .peer/hooks/audit.mjs",
        "timeoutMs": 3000,
        "onError": "fail-open"
      }
    ]
  }
}
```

## Hook fields

| Field | Required | Description |
| --- | --- | --- |
| `id` | No | Stable identifier shown in Evidence. Defaults to `command` when omitted. |
| `match.capabilityId` | No | Capability ID to match. `*` matches all capabilities. |
| `match.argumentsPattern` | No | Glob-like pattern matched against serialized tool arguments. |
| `command` | Yes | External command to execute. Hook payload is written to stdin as JSON. |
| `timeoutMs` | No | Per-hook timeout in milliseconds. |
| `onError` | No | `fail-closed` or `fail-open`. Defaults to `fail-closed`. |

## Hook stdin payload

`PreToolUse` receives JSON like:

```json
{
  "sessionId": "session-1",
  "projectionId": "projection-1",
  "conversationId": "conversation-1",
  "call": {
    "toolCallId": "tool-call-1",
    "capabilityId": "local.shell.exec",
    "arguments": {
      "command": "pwd"
    }
  }
}
```

For Shell capabilities, a second fine-grained `PreToolUse` runs after Shell classification and includes:

```json
{
  "shell": {
    "command": "pwd",
    "cwd": "/repo",
    "classification": {
      "category": "read-only",
      "riskLevel": "L1_local_read",
      "dataLevel": "D1_internal",
      "reason": "read_only_auto_allowed"
    }
  }
}
```

`PostToolUse` receives the same base payload plus `result`.

## Hook stdout contract

A Hook may print JSON to stdout:

```json
{
  "decision": "ask",
  "reason": "needs human approval"
}
```

Supported decisions:

| Decision | Meaning |
| --- | --- |
| `allow` | Continue unless another Hook or runtime rule is stricter. |
| `ask` | Enter the existing local permission confirmation path when available. |
| `deny` | Block execution. |

When multiple Hook records exist, Peer Agent uses the most restrictive decision:

```text
deny > ask > allow
```

## Ask confirmation behavior

Host-level `PreToolUse` with `ask` enters the existing chat permission gate through `requestPermission`.

- If the user approves, Provider execution continues.
- If the user rejects, the result fails with the rejection reason.
- If no confirmation path is available, Peer Agent fails closed with `hook_approval_required`.

Shell-level Hook `ask` is merged with Shell's existing permission decision and enters the same Shell approval path.

## Safety rules

Hooks may only tighten permissions.

- A Hook `deny` blocks even if the runtime would normally allow.
- A Hook `allow` cannot override Shell ask or deny decisions.
- Destructive Shell commands remain blocked or gated even when a Hook returns `allow`.
- Hook failures default to `fail-closed` unless the hook explicitly sets `onError: "fail-open"`.

## Evidence

Hook outcomes are appended to Tool Result Evidence under `evidence.hooks`.

Recorded fields include:

- `id`
- `event`
- `decision`
- `reason`
- `outcome`
- `durationMs`
- `exitCode`

The final Hook decision is recorded as `evidence.hookFinalDecision`.
