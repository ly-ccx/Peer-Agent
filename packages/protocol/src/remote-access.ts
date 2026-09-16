/** ADR 75: preflight checks only. Passing does not grant tool execution permission. */
export const REMOTE_PROTOCOL_VERSION = 1 as const;

export interface RemoteReadRequest {
  readonly protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  readonly type: 'task.submit';
  readonly requestId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly workspaceId: string;
  readonly bindingVersion: number;
  readonly connectionEpoch: number;
  readonly delegationVersion: number;
  readonly expiresAt: number;
  readonly operation: 'task.read';
  readonly taskId: string;
}

/** Constructed by the authenticated host, never from a request payload. */
export interface RemoteReadContext {
  readonly now: number;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly bindingVersion: number;
  readonly connectionEpoch: number;
  readonly online: boolean;
  readonly bindingRevoked: boolean;
  readonly delegation: {
    readonly version: number;
    readonly expiresAt: number;
    readonly revoked: boolean;
    readonly workspaceIds: readonly string[];
    readonly allowTaskRead: boolean;
    readonly allowResultExport: boolean;
  };
  /** Resolve from the local task store; caller must not trust client task ownership. */
  readonly task: {
    readonly taskId: string;
    readonly ownerId: string;
    readonly workspaceId: string;
  } | null;
}

export type RemoteReadRejection =
  | 'INVALID_REQUEST' | 'PROTOCOL_UNSUPPORTED' | 'IDENTITY_UNBOUND'
  | 'DEVICE_OFFLINE' | 'STALE_CONNECTION' | 'REQUEST_EXPIRED'
  | 'DELEGATION_EXPIRED' | 'WORKSPACE_DENIED' | 'CAPABILITY_DENIED'
  | 'EXPORT_DENIED' | 'TASK_DENIED';
export type RemoteReadAdmission =
  | { readonly ok: true; readonly request: RemoteReadRequest }
  | { readonly ok: false; readonly code: RemoteReadRejection };

const fields = new Set([
  'protocolVersion', 'type', 'requestId', 'ownerId', 'deviceId', 'workspaceId',
  'bindingVersion', 'connectionEpoch', 'delegationVersion', 'expiresAt', 'operation', 'taskId',
]);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Strict wire shape: M1 deliberately has no shell, path, arbitrary arguments, or writes. */
export function parseRemoteReadRequest(value: unknown): RemoteReadAdmission {
  const reject = (code: RemoteReadRejection): RemoteReadAdmission => ({ ok: false, code });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('INVALID_REQUEST');
  const r = value as Record<string, unknown>;
  if (r.protocolVersion !== REMOTE_PROTOCOL_VERSION) return reject('PROTOCOL_UNSUPPORTED');
  if (Object.keys(r).length !== fields.size || Object.keys(r).some(key => !fields.has(key))) {
    return reject('INVALID_REQUEST');
  }
  if (r.type !== 'task.submit' || r.operation !== 'task.read'
      || !['requestId', 'ownerId', 'deviceId', 'workspaceId', 'taskId'].every(key => identifier(r[key]))
      || !['bindingVersion', 'connectionEpoch', 'delegationVersion', 'expiresAt'].every(key => integer(r[key]))) {
    return reject('INVALID_REQUEST');
  }
  return { ok: true, request: { ...r } as unknown as RemoteReadRequest };
}

/** New submissions only. Duplicate receipt lookup belongs to the persistent host ledger. */
export function admitRemoteRead(value: unknown, context: RemoteReadContext): RemoteReadAdmission {
  const parsed = parseRemoteReadRequest(value);
  if (!parsed.ok) return parsed;
  const r = parsed.request;
  const deny = (code: RemoteReadRejection): RemoteReadAdmission => ({ ok: false, code });
  if (context.bindingRevoked || r.ownerId !== context.ownerId || r.deviceId !== context.deviceId
      || r.bindingVersion !== context.bindingVersion) return deny('IDENTITY_UNBOUND');
  const d = context.delegation;
  if (!Number.isFinite(context.now) || !Number.isFinite(d.expiresAt)
      || d.revoked || d.expiresAt <= context.now || r.delegationVersion !== d.version) {
    return deny('DELEGATION_EXPIRED');
  }
  if (!d.workspaceIds.includes(r.workspaceId)) return deny('WORKSPACE_DENIED');
  if (!d.allowTaskRead) return deny('CAPABILITY_DENIED');
  if (!d.allowResultExport) return deny('EXPORT_DENIED');
  if (!context.task || context.task.taskId !== r.taskId || context.task.ownerId !== r.ownerId
      || context.task.workspaceId !== r.workspaceId) return deny('TASK_DENIED');
  if (!context.online) return deny('DEVICE_OFFLINE');
  if (r.connectionEpoch !== context.connectionEpoch) return deny('STALE_CONNECTION');
  if (r.expiresAt <= context.now || r.expiresAt - context.now > 30_000) return deny('REQUEST_EXPIRED');
  return parsed;
}
