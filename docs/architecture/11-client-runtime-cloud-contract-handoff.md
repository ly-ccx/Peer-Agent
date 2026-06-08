# Client Runtime Cloud Contract Handoff

Date: 2026-05-14
Branch: `dev/0.0.1`
Status: cloud implementation required

This document is the cloud-side handoff for the remaining `0.0.1` client-cloud parity blockers. The desktop client already keeps cognition in the cloud and only acts as a local capability proxy. The missing piece is the cloud contract that lets the cloud runtime assign client tool calls over a client-initiated polling loop and receive Evidence back.

## Boundary

The cloud remains the source of truth for cognition, planning, tool choice, governance, and execution ledger.

The client only does:

- Publish a local Runtime Projection after local consent.
- Carry the accepted Runtime Projection id into future local task polling.
- Poll the cloud for `client_tool_call` tasks through an outbound client-initiated request.
- Ask the local user for permission before execution.
- Execute registered local capabilities.
- Return redacted Evidence and execution result to the cloud.

The cloud must not call local ports directly.

## Current Production Probe

Run:

```bash
ZEUS_ATLAS_CLOUD_GATEWAY_URL=https://cbu-xiaoer-service.alibaba-inc.com \
npx --yes pnpm@10.22.0 prod-e2e:probe-contract
```

For backend handoff, write the same probe as JSON:

```bash
ZEUS_ATLAS_CLOUD_GATEWAY_URL=https://cbu-xiaoer-service.alibaba-inc.com \
npx --yes pnpm@10.22.0 prod-e2e:probe-contract --out docs/architecture/cloud-contract-probe.<date>.json
```

Observed on 2026-05-14:

Machine-readable snapshot: `docs/architecture/cloud-contract-probe.2026-05-14.json`

| Contract | Route | Current Prod Result | Required |
|---|---|---:|---|
| Runtime Projection publish | `POST /api/client/runtime/projection` | `404` | Route exists and returns accepted projection result |
| Client task poll | `POST /api/client/runtime/tasks/poll` | `404` | Route exists and returns poll result |
| Client Evidence return | `POST /api/chat/client-tool/result` | `404` | Route exists and records result/Evidence |
| Chat Statistics export | `POST /api/chat/statistics/export` | `200` | Already route-ready |
| OpenClaw catalog | `GET /api/openclaw-governance/catalog` | timeout | Route returns data, empty data, or auth/validation response |
| OpenClaw conversation effective config | `GET /api/openclaw-governance/effective-agent-config/resolve-conversation?conversationId=0` | `500` | Route must not 500 on validation probe |
| OpenClaw Studio current scene | `GET /api/openclaw-studio/scene/current` | timeout | Route returns data, empty data, or auth/validation response |

For unauthenticated contract probes, `400`, `401`, `403`, `405`, and `422` are acceptable route-existence signals. `404`, `501`, `5xx`, and timeout block production acceptance.

## Required Contracts

### 1. Runtime Projection Publish

`POST /api/client/runtime/projection`

Purpose: register the current client's local capability projection for a cloud session.

Request shape:

```ts
interface RuntimeProjectionPublishRequest {
  projection: RuntimeProjection;
  session: ClientSessionState;
  workspace?: WorkspaceProject;
  publishedAt: string;
}
```

Minimum response shape:

```ts
interface RuntimeProjectionPublishResult {
  accepted: boolean;
  projectionId: string;
  expiresAt?: string;
  message?: string;
}
```

Acceptance:

- `accepted: true` for a valid authenticated user/session.
- `projectionId` echoes or maps to the active cloud-side projection.
- Invalid unauthenticated probe should return `401`, `403`, `400`, or `422`, not `404`.
- Store projection with TTL; expired projections must not receive client tool calls.

### 2. Client Tool Call Poll

`POST /api/client/runtime/tasks/poll`

Purpose: client-initiated long/short polling for cloud-assigned local capability work.

The desktop client sends the accepted Runtime Projection id from the latest successful projection publish as `projectionId`. The field remains optional at the protocol level so the cloud can return a validation/auth status for first-run or expired-projection clients, but production acceptance should treat a valid authenticated poll without an active projection as not eligible for local work.

Request shape:

```ts
interface ClientToolCallPollRequest {
  sessionId: string;
  projectionId?: string;
  conversationId?: number;
  cursor?: string;
  limit?: number;
  polledAt: string;
}
```

Response shape:

```ts
interface ClientToolCallPollResult {
  calls: ClientToolCall[];
  cursor?: string;
  idleUntil?: string;
}
```

`ClientToolCall` shape:

```ts
interface ClientToolCall {
  toolCallId: string;
  capabilityId: string;
  displayName: string;
  reason: string;
  argumentsPreview: Record<string, unknown>;
  riskLevel: CapabilityRiskLevel;
  dataLevel: DataLevel;
  requestedAt: string;
}
```

Acceptance:

- Empty queue returns `{ calls: [] }`, optionally with `cursor` and `idleUntil`.
- A poll with an accepted Runtime Projection id is scoped to that active projection.
- The cloud only returns calls allowed by the latest Runtime Projection and cloud policy.
- `toolCallId` must be stable and idempotent.
- A client must never receive calls for another user, session, or tenant.
- Missing/expired projection returns `401`, `403`, `409`, or `422`, not `404`.

### 3. Client Tool Result / Evidence Return

`POST /api/chat/client-tool/result`

Purpose: return local execution result and Evidence to the cloud runtime ledger.

Request shape:

```ts
interface ClientToolResultReport {
  conversationId?: number;
  streamId?: string;
  call: ClientToolCall;
  grant: PermissionGrant;
  result: ClientToolResult;
  reportedAt: string;
}
```

Important nested shapes:

```ts
interface PermissionGrant {
  grantId: string;
  toolCallId: string;
  granted: boolean;
  duration: PermissionDuration;
  scope?: string;
  decidedAt: string;
}

interface ClientToolResult {
  toolCallId: string;
  status: 'success' | 'denied' | 'failed' | 'cancelled';
  outputPreview: Record<string, unknown>;
  evidence: Evidence;
  completedAt: string;
}

interface Evidence {
  evidenceId: string;
  toolCallId: string;
  summary: string;
  locale: LocaleCode;
  returnedToCloud: boolean;
  dataLevel: DataLevel;
  redactions: string[];
  artifactRefs: string[];
}
```

Acceptance:

- Result is idempotent by `toolCallId` plus `evidenceId`.
- The cloud records grant, result status, redaction metadata, and Evidence summary.
- The cloud resumes or updates the relevant execution/thread after result receipt.
- A denied result is a valid terminal local execution result, not a transport error.
- Invalid unauthenticated probe should return `401`, `403`, `400`, or `422`, not `404`.

## OpenClaw Read Contracts

The desktop client already lazy-loads OpenClaw panels, but production acceptance still needs route-level readiness.

Required behavior:

- `GET /api/openclaw-governance/catalog` must return `200` with data/empty data, or auth/validation status for unauthenticated probes. Timeout blocks acceptance.
- `GET /api/openclaw-governance/effective-agent-config/resolve-conversation` must validate missing/invalid `conversationId` with `400` or `422`, not `500`.
- `GET /api/openclaw-studio/scene/current` must return `200` with data/empty data, or auth/validation status for unauthenticated probes. Timeout blocks acceptance.

## Security Gates

Cloud-side implementation must enforce these gates before returning any `ClientToolCall`:

| Gate | Owner | Requirement |
|---|---|---|
| Organization policy | Cloud | User, tenant, role, and business context allow local capability use |
| Projection pruning | Cloud | Capability exists in the active Runtime Projection |
| Local consent | Client | User approves the specific tool call before local execution |
| Adapter enforcement | Client | Local adapter enforces risk/data/evidence policy during execution |
| Evidence ledger | Cloud | Result/Evidence is written to cloud execution history |

## Production Acceptance

Cloud-side completion is not accepted until all are true:

1. `pnpm prod-e2e:probe-contract` returns `blockerCount: 0`.
2. Local Proxy polling receives either an empty poll result or a real `client_tool_call`.
3. A real local permission review is shown before local execution.
4. Evidence return writes to the cloud ledger without a `404`, `5xx`, or timeout.
5. `pnpm prod-e2e:create-report --with-contract-probe` produces a report whose `cloudContractProbe.blockerCount` is `0`.
6. `pnpm prod-e2e:validate <report.json>` passes on the current `dev/0.0.1` HEAD.

Until then, `parity:completion-audit` must remain blocked and the active goal must not be marked complete.
