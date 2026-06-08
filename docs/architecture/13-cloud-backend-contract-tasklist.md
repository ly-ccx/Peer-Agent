# Cloud Backend Contract Tasklist

Date: 2026-05-14
Branch: `dev/0.0.1`
Status: backend implementation merged to master; production deployment required

This is the backend tasklist for unblocking the `0.0.1` client-cloud parity goal. The desktop client already implements the client-side Runtime Projection, Local Capability Proxy polling, permission review, local execution Evidence, and retryable Evidence return path. Production completion is blocked until the Cloud Gateway exposes the contracts below.

## Backend Implementation Branch

The first backend implementation branch has been created in `cbu-xiaoer-node-service` and pushed to `origin/master`:

- Repository: `git@gitlab.alibaba-inc.com:cbu-star-link/cbu-xiaoer-node-service.git`
- Branch: `codex/zeus-atlas-client-runtime-contracts`
- Implementation code commit: `5c8272e Cover client runtime validation status`
- Current branch and `origin/master` head: `9a4cdda Document Zeus Atlas contract probe alignment`

This branch adds the P0 client runtime routes, route-ready fallbacks for the P1 OpenClaw read probes, a first Evidence ledger bridge that persists client-tool Evidence to existing `ai_chat_tool_calls` rows when the cloud `toolCallId` is known, `422` validation for malformed Runtime Projection, polling, and Evidence-return payloads, and controller coverage proving those validation failures set the HTTP status observed by production probes. Production acceptance now requires deployment to `https://cbu-xiaoer-service.alibaba-inc.com` and a fresh `prod-e2e:probe-contract` result with `blockerCount: 0`.

Latest backend branch verification from the local checkout on 2026-05-14:

```bash
./node_modules/.bin/jest --config jest.config.js --runInBand src/controller/__tests__/clientRuntime.test.ts src/service/clientRuntime/__tests__/ClientRuntimeService.test.ts src/controller/__tests__/openclawGovernance.test.ts src/controller/__tests__/openclawStudio.test.ts
npm run build
```

Result: targeted contract/controller/service coverage passed (`10` suites, `114` tests), and `mwtsc --cleanOutDir` completed successfully. The production probe still reports the same `6` blockers until this backend branch is deployed.

## Current Live Probe

Latest manual probe from a clean `dev/0.0.1` workspace at `0d8b195 Update backend contract evidence head`, after `cbu-xiaoer-node-service` `origin/master` was pushed to `9a4cdda`:

```bash
npx --yes pnpm@10.22.0 prod-e2e:probe-contract --json
```

Result summary:

| Priority | Contract | Route | Current class | Required class |
|---|---|---|---|---|
| P0 | Runtime Projection publish | `POST /api/client/runtime/projection` | `missing` / `404` | `ok` or route-exists validation |
| P0 | Runtime Gateway WS | `GET /api/client/runtime/ws` | `missing` / `404` | `ok`, `426`, or route-exists validation |
| P0 | Client task poll | `POST /api/client/runtime/tasks/poll` | `missing` / `404` | `ok` or route-exists validation |
| P0 | Client Evidence return | `POST /api/chat/client-tool/result` | `missing` / `404` | `ok` or route-exists validation |
| P1 | OpenClaw catalog | `GET /api/openclaw-governance/catalog` | `unreachable` / timeout | `ok` or route-exists validation |
| P1 | OpenClaw conversation effective config | `GET /api/openclaw-governance/effective-agent-config/resolve-conversation?conversationId=0` | `server_error` / `500` | `ok` or `400` / `422` validation |
| P1 | OpenClaw Studio current scene | `GET /api/openclaw-studio/scene/current` | `unreachable` / timeout | `ok` or route-exists validation |

`POST /api/chat/statistics/export` already returns `200` and is not a blocker.

For unauthenticated contract probes, `400`, `401`, `403`, `405`, `422`, and WebSocket upgrade `426` count as route-exists validation. `404`, `501`, any `5xx`, timeout, and unexpected status block production acceptance.

## P0 Local Runtime Loop

### 1. Runtime Projection publish

Route:

```text
POST /api/client/runtime/projection
```

Minimum behavior:

- Validate BUC user, tenant, organization policy, and session context.
- Accept the client's `RuntimeProjectionPublishRequest`.
- Store the active projection with TTL.
- Return `{ accepted: true, projectionId, expiresAt? }` for valid authenticated input.
- Return `400`, `401`, `403`, or `422` for invalid probes instead of `404`.

Backend acceptance:

- Projection ids are scoped to user, tenant, session, and cloud policy.
- Expired or revoked projections cannot receive local tool calls.
- The route is idempotent for the same active session/projection.

### 2. Client task poll

Route:

```text
POST /api/client/runtime/tasks/poll
```

Minimum behavior:

- Validate BUC user, tenant, session, and optional `projectionId`.
- Return an empty queue as `{ calls: [] }` when no local work is assigned.
- Return only `client_tool_call` tasks allowed by the active Runtime Projection and cloud policy.
- Keep `toolCallId` stable and idempotent.
- Return `401`, `403`, `409`, or `422` for missing, expired, or invalid projections instead of `404`.

Backend acceptance:

- A client never receives calls for another user, tenant, session, conversation, or projection.
- The cloud remains the source of tool choice and scheduling.
- The cloud does not call local ports directly. The client must pull work outbound.

### 3. Client Evidence return

Route:

```text
POST /api/chat/client-tool/result
```

Minimum behavior:

- Validate BUC user, tenant, session, and related `toolCallId`.
- Accept `success`, `denied`, `failed`, and `cancelled` results.
- Store `PermissionGrant`, result status, redaction metadata, artifact refs, and Evidence summary in the cloud execution ledger.
- Treat denied local execution as a valid terminal local result, not as transport failure.
- Return `400`, `401`, `403`, or `422` for invalid probes instead of `404`.

Backend acceptance:

- Result writes are idempotent by `toolCallId` plus `evidenceId`.
- Cloud execution/thread state can resume or update after Evidence receipt.
- Re-posting the same local Evidence does not duplicate ledger artifacts.

## P1 OpenClaw Read Readiness

These routes are lazy-loaded by the desktop UI, but production acceptance still requires route readiness:

- `GET /api/openclaw-governance/catalog`
- `GET /api/openclaw-governance/effective-agent-config/resolve-conversation`
- `GET /api/openclaw-studio/scene/current`

Minimum behavior:

- Return `200` with data or empty data when authenticated and authorized.
- Return `401` / `403` for unauthenticated or unauthorized probes.
- Return `400` / `422` for invalid validation probes.
- Do not timeout.
- Do not return `500` for `conversationId=0`; validate it as invalid input.

## Verification

Backend is not accepted until all commands below pass on the current `dev/0.0.1` HEAD:

```bash
npx --yes pnpm@10.22.0 prod-e2e:probe-contract
npx --yes pnpm@10.22.0 prod-e2e:create-report --tester <work_id> --out docs/architecture/prod-e2e-report.<date>.json --with-contract-probe
npx --yes pnpm@10.22.0 prod-e2e:validate docs/architecture/prod-e2e-report.<date>.json
npx --yes pnpm@10.22.0 parity:completion-audit
```

Expected acceptance state:

- `prod-e2e:probe-contract` prints `Prod cloud contract probe passed.`
- Embedded `cloudContractProbe.blockerCount` is `0`.
- `prod-e2e:validate` passes against the current HEAD commit.
- `parity:completion-audit` has no blocked items.

## Backend Issue Checklist

- [ ] Implement `POST /api/client/runtime/projection`.
- [ ] Implement `GET /api/client/runtime/ws`.
- [ ] Implement `POST /api/client/runtime/tasks/poll`.
- [ ] Implement `POST /api/chat/client-tool/result`.
- [ ] Fix `GET /api/openclaw-governance/catalog` timeout.
- [ ] Fix `GET /api/openclaw-governance/effective-agent-config/resolve-conversation?conversationId=0` 500.
- [ ] Fix `GET /api/openclaw-studio/scene/current` timeout.
- [ ] Run `prod-e2e:probe-contract` and attach output with `blockerCount: 0`.
- [ ] Produce and validate a production E2E report on `dev/0.0.1`.

The active parity goal must remain incomplete until this checklist is green.
