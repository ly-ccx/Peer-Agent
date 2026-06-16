# ADR 32: MCP Authentication and Credential Injection

Status: Accepted
Date: 2026-06-16

## Context

Peer Agent already treats MCP as a local capability provider: MCP server configuration is managed locally, discovered server tools become capability manifests, runtime projection controls model-visible tools, and execution still flows through PermissionGrant and Evidence.

The missing part is authentication. Many MCP servers need credentials:

- HTTP transports commonly require `Authorization: Bearer ...`, API keys, or custom headers.
- `stdio` transports commonly require secrets through environment variables.
- Future OAuth MCP servers require token refresh and redirect callback handling.

If credentials are stored directly in the MCP registry or exposed to the renderer, the MCP integration breaks the architecture baseline:

```text
Capability Provider
  -> Manifest
    -> Runtime Projection
      -> Tool Call
        -> PermissionGrant
          -> Evidence
```

Credentials are local execution material, not model-visible context and not renderer-owned state.

## Decision

Introduce a main-process MCP Credential Layer.

```text
Settings UI
  -> one-time credential input
    -> IPC contract
      -> Main MCP Credential Store
        -> opaque credentialRef in MCP registry
          -> MCP client credential resolver
            -> transport headers/env injection
              -> manifest discovery / tool execution
```

The renderer may create, replace, list metadata for, and delete MCP credentials, but it must never read secret values back. The MCP registry may only store opaque references and non-secret metadata.

## Supported authentication scope

Phase 1 implements non-interactive credentials:

1. `http_bearer`
   - Injects `Authorization: Bearer <secret>` for `streamable_http` and `sse` transports.
2. `http_header`
   - Injects a caller-defined header name with the secret as the value.
3. `stdio_env`
   - Injects a caller-defined environment variable for `stdio` transports.
4. `none`
   - Explicit unauthenticated mode.

OAuth is intentionally deferred. OAuth needs browser redirect handling, refresh-token rotation, expiry governance, and provider-specific scopes. It should be added as a new Credential Provider adapter at the same seam, not as ad hoc settings code.

## Contract

### MCP registry record

Server records may contain:

```ts
interface McpAuthBinding {
  mode: 'none' | 'http_bearer' | 'http_header' | 'stdio_env';
  credentialRef?: string;
  headerName?: string;
  envName?: string;
}
```

The registry stores the binding but never stores secret values.

### Credential metadata

The main process returns metadata only:

```ts
interface McpCredentialMetadata {
  id: string;
  label: string;
  kind: 'http_bearer' | 'http_header' | 'stdio_env';
  target: 'header' | 'env';
  headerName?: string;
  envName?: string;
  createdAt: string;
  updatedAt: string;
  lastFour?: string;
  storage: 'safeStorage' | 'file-fallback';
}
```

`lastFour` is a convenience hint only. It must never be enough to reconstruct the secret.

### Renderer operations

Renderer-accessible operations are limited to:

- `mcpListCredentials()`
- `mcpPutCredential({ ...metadata, secret })`
- `mcpDeleteCredential({ credentialRef })`

There is no `getCredentialSecret` API.

### Credential resolution

The MCP client receives a resolver function from main-process composition:

```ts
resolveMcpCredential(binding, server) => Promise<ResolvedMcpCredential | null>
```

The resolver may return transport injection material:

```ts
{ headers?: Record<string,string>; env?: Record<string,string> }
```

The resolver must validate binding/credential compatibility before injecting.

## Storage

The Credential Store is a main-process module.

Preferred backend:

- Electron `safeStorage` encryption when available.

Fallback backend:

- A local file under Peer Agent data home with restricted file mode where supported.
- The fallback is explicitly marked as `file-fallback` in metadata so the UI can warn users.

This keeps the seam replaceable. A future platform keychain adapter can replace the fallback without changing renderer, registry, MCP client, or runtime projection contracts.

## Runtime behavior

For MCP manifest refresh, resource read, prompt get, and tool execution:

1. Main process reads server registry record.
2. MCP client normalizes config.
3. Credential resolver resolves the server `auth` binding.
4. HTTP credentials are merged into request headers.
5. `stdio_env` credentials are merged into child-process environment.
6. Connection pooling is keyed by transport config plus auth binding identity to avoid reusing unauthenticated/authenticated transports incorrectly.
7. Tool execution continues through PermissionGrant and Evidence.

Credential values are not included in Evidence. Evidence may include credential metadata such as `authMode` and `credentialRef` presence, but not secrets.

## Security boundaries

- Renderer owns presentation and user interaction only.
- Main owns secret storage and credential resolution.
- Registry owns opaque references and non-secret auth binding.
- MCP client owns injection into transport config.
- Runtime Projection owns model-visible capability exposure and never sees secrets.
- PermissionGrant remains required for actual tool calls.
- Evidence remains factual, redacted, and non-secret.

## Alternatives considered

### Store raw headers/env in MCP registry

Rejected. It leaks secrets into normal config export/import paths and renderer-visible views.

### Let renderer keep credentials in component state/localStorage

Rejected. Renderer is presentation-only and is not a security boundary.

### Ask the model for credentials at tool-call time

Rejected. Secrets are not model context and must not be mediated by assistant text.

### Implement OAuth immediately

Rejected for the first auth layer because OAuth requires additional browser-flow and refresh-token governance. The accepted design leaves an adapter seam for OAuth.

## Consequences

Positive:

- MCP servers needing bearer tokens, API keys, or env secrets become usable.
- Secrets stay out of registry views, runtime projection, model context, and Evidence.
- Future keychain/OAuth adapters can plug into a clear seam.

Tradeoffs:

- `safeStorage` availability differs by platform/session; fallback must be clearly marked.
- Changing credentials should disconnect affected MCP clients so pooled transports do not retain old auth.
- Import/export of MCP registry cannot export secret values; users must re-enter credentials on another machine.

## Acceptance criteria

- A user can configure bearer/header/env credentials from MCP settings.
- MCP settings can bind a credential to a server without exposing the secret after save.
- HTTP MCP transports receive the configured Authorization/custom header.
- `stdio` MCP transports receive the configured environment variable.
- Registry and renderer views contain only opaque credential refs and status metadata.
- MCP tool execution through runtime projection uses the same credential resolver as manifest refresh.
- Tests cover credential store redaction, HTTP header injection, stdio env injection, and provider execution with credentials.
