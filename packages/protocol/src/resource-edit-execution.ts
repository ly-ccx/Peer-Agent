import { normalizeResourceEditOperation, resourceEditToken, resourceEditDigest, type ResourceEditOperation, type ResourceEditReceipt } from './resource-edit.ts';
import { normalizeResourceFileReplacePreview, normalizeResourceFileReplaceInput, RESOURCE_FILE_REPLACE_CAPABILITY, RESOURCE_FILE_REPLACE_PROVIDER, RESOURCE_FILE_REPLACE_TOOL, type ResourceFileReplacePreview, type ResourceFileReplaceInput } from './resource-file-replace.ts';
import type { PermissionGrant } from './index.ts';
export const RESOURCE_EDIT_EXECUTION_BYTES = 32768;
export const RESOURCE_EDIT_POSTLUDE_BYTES = 16384;
export const RESOURCE_EDIT_EXECUTION_TOTAL_BYTES = 8 * 1024 * 1024;
/** Stored facts have their own schema; they never contain the complete Tool Call arguments. */
export interface ResourceEditExecutionRecord {
  readonly schemaVersion: 1; readonly workspaceId: string; readonly requestId: string; readonly payloadHash: string;
  readonly projectionId: string; readonly sessionId: string;
  readonly call: { readonly toolCallId: string; readonly capabilityId: typeof RESOURCE_FILE_REPLACE_CAPABILITY; readonly toolName: typeof RESOURCE_FILE_REPLACE_TOOL; readonly argumentsDigest: string; readonly occurredAt: string; readonly permissionCallId?: string };
  readonly grant: Omit<PermissionGrant, 'scope'> & { readonly scope?: typeof RESOURCE_FILE_REPLACE_CAPABILITY | null };
  readonly result: { readonly toolCallId: string; readonly status: 'success' | 'failed' | 'denied' | 'cancelled'; readonly completedAt: string;
    readonly observation?: ResourceFileReplacePreview; readonly blockedReason?: string;
    readonly evidence: { readonly evidenceId: string; readonly toolCallId: string; readonly summary: string; readonly locale: string; readonly returnedToCloud: false; readonly dataLevel: 'D2_sensitive'; readonly redactions: readonly string[]; readonly artifactRefs: readonly string[] } };
}
export interface ResourceEditHookFact {
  readonly id?: string; readonly event?: 'PreToolUse' | 'PostToolUse'; readonly decision: 'allow' | 'ask' | 'deny'; readonly reason?: string;
  readonly outcome?: string; readonly durationMs?: number; readonly exitCode?: number | null;
}
export interface ResourceEditPostlude {
  readonly schemaVersion: 1; readonly requestId: string; readonly payloadHash: string; readonly completedAt: string;
  readonly status: 'recorded' | 'unconfirmed'; readonly reason?: string; readonly hookFinalDecision?: 'allow' | 'ask' | 'deny'; readonly hooks?: readonly ResourceEditHookFact[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(key => allowed.includes(key));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const timestamp = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
function bounded(raw: unknown, max: number) { try { return new TextEncoder().encode(JSON.stringify(raw)).byteLength <= max; } catch { return false; } }
const strings = (v: unknown, maxItems: number, maxChars: number): v is string[] => Array.isArray(v) && v.length <= maxItems && v.every(item => text(item, maxChars));
export function resourceFileReplaceArgumentPayload(raw: ResourceFileReplaceInput): string {
  const input = normalizeResourceFileReplaceInput(raw); if (!input) throw TypeError('INVALID_RESOURCE_EDIT_ARGUMENTS');
  return JSON.stringify(input);
}
export function normalizeResourceEditExecutionRecord(raw: unknown): ResourceEditExecutionRecord | undefined {
  if (!object(raw) || !bounded(raw, RESOURCE_EDIT_EXECUTION_BYTES) || !keys(raw, ['schemaVersion', 'workspaceId', 'requestId', 'payloadHash', 'projectionId', 'sessionId', 'call', 'grant', 'result'])
    || raw.schemaVersion !== 1 || !resourceEditToken(raw.workspaceId) || !resourceEditToken(raw.requestId) || !resourceEditDigest(raw.payloadHash)
    || raw.projectionId !== `resource-edit:${raw.requestId}` || !text(raw.sessionId, 256) || !object(raw.call) || !object(raw.grant) || !object(raw.result)) return;
  const call = raw.call, grant = raw.grant, result = raw.result;
  if (!keys(call, ['toolCallId', 'capabilityId', 'toolName', 'argumentsDigest', 'occurredAt', 'permissionCallId']) || call.toolCallId !== `resource-edit:${raw.requestId}`
    || call.permissionCallId !== undefined && ![call.toolCallId, `chat-permission:${call.toolCallId}`].includes(call.permissionCallId as string)
    || call.capabilityId !== RESOURCE_FILE_REPLACE_CAPABILITY || call.toolName !== RESOURCE_FILE_REPLACE_TOOL || !resourceEditDigest(call.argumentsDigest) || !timestamp(call.occurredAt)
    || !keys(grant, ['grantId', 'toolCallId', 'granted', 'duration', 'scope', 'decidedAt', 'policyRevision']) || !resourceEditToken(grant.grantId) || grant.toolCallId !== call.toolCallId
    || typeof grant.granted !== 'boolean' || !['once', 'task', 'session', 'scope', 'persistent', 'denied'].includes(grant.duration as string)
    || grant.granted && (grant.duration === 'denied' || grant.scope !== call.capabilityId)
    || !grant.granted && grant.scope !== undefined && grant.scope !== null && grant.scope !== call.capabilityId || !timestamp(grant.decidedAt)
    || grant.policyRevision !== undefined && !text(grant.policyRevision, 512)
    || !keys(result, ['toolCallId', 'status', 'completedAt', 'observation', 'blockedReason', 'evidence']) || result.toolCallId !== call.toolCallId || !timestamp(result.completedAt)
    || !['success', 'failed', 'denied', 'cancelled'].includes(result.status as string) || !object(result.evidence)) return;
  const observation = result.observation === undefined ? undefined : normalizeResourceFileReplacePreview(result.observation);
  if (result.observation !== undefined && !observation || observation && (observation.requestId !== raw.requestId || observation.status !== result.status
    || observation.permissionCallId !== undefined && (![call.toolCallId, `chat-permission:${call.toolCallId}`].includes(observation.permissionCallId)
      || call.permissionCallId !== undefined && observation.permissionCallId !== call.permissionCallId)
    || observation.outcome === 'applied' && !grant.granted)
    || !observation && (!['denied', 'cancelled'].includes(result.status as string) || grant.granted || !text(result.blockedReason, 2048))
    || observation && result.blockedReason !== undefined) return;
  const evidence = result.evidence;
  if (!keys(evidence, ['evidenceId', 'toolCallId', 'summary', 'locale', 'returnedToCloud', 'dataLevel', 'redactions', 'artifactRefs']) || !resourceEditToken(evidence.evidenceId)
    || evidence.toolCallId !== call.toolCallId || !text(evidence.summary, 4096) || !text(evidence.locale, 32) || evidence.returnedToCloud !== false || evidence.dataLevel !== 'D2_sensitive'
    || !strings(evidence.redactions, 32, 256) || !strings(evidence.artifactRefs, 32, 2048)) return;
  return { schemaVersion: 1, workspaceId: raw.workspaceId, requestId: raw.requestId, payloadHash: raw.payloadHash, projectionId: raw.projectionId as string, sessionId: raw.sessionId,
    call: { toolCallId: call.toolCallId as string, capabilityId: RESOURCE_FILE_REPLACE_CAPABILITY, toolName: RESOURCE_FILE_REPLACE_TOOL, argumentsDigest: call.argumentsDigest, occurredAt: call.occurredAt,
      ...(call.permissionCallId !== undefined || observation?.permissionCallId !== undefined ? { permissionCallId: (call.permissionCallId ?? observation?.permissionCallId) as string } : {}) },
    grant: { grantId: grant.grantId, toolCallId: grant.toolCallId as string, granted: grant.granted, duration: grant.duration as PermissionGrant['duration'],
      ...(grant.scope !== undefined ? { scope: grant.scope as typeof RESOURCE_FILE_REPLACE_CAPABILITY | null } : {}),
      decidedAt: grant.decidedAt, ...(grant.policyRevision !== undefined ? { policyRevision: grant.policyRevision as string } : {}) },
    result: { toolCallId: result.toolCallId as string, status: result.status as ResourceEditExecutionRecord['result']['status'], completedAt: result.completedAt,
      ...(observation ? { observation } : { blockedReason: result.blockedReason as string }), evidence: { evidenceId: evidence.evidenceId, toolCallId: evidence.toolCallId as string,
        summary: evidence.summary, locale: evidence.locale, returnedToCloud: false, dataLevel: 'D2_sensitive', redactions: [...evidence.redactions], artifactRefs: [...evidence.artifactRefs] } } };
}
export function resourceEditExecutionMatches(record: ResourceEditExecutionRecord, raw: ResourceEditOperation): boolean {
  const op = normalizeResourceEditOperation(raw), value = record.result.observation;
  return !!op && op.providerId === RESOURCE_FILE_REPLACE_PROVIDER && op.requestId === record.requestId && op.target.recipient.workspaceId === record.workspaceId && op.payloadHash === record.payloadHash && record.sessionId === (op.target.reference.task?.sessionId ?? op.target.recipient.conversationId)
    && (!value || value.path === op.target.reference.path && value.resourceId === op.target.base.resourceId && value.expectedVersion === op.target.base.contentVersion && value.proposedVersion === op.proposedVersion);
}
/** Caller must have obtained this record from the actual host execution index, never model text. */
export function resourceEditExecutionReceipt(record: ResourceEditExecutionRecord, operation: ResourceEditOperation): ResourceEditReceipt | undefined {
  if (!resourceEditExecutionMatches(record, operation)) return;
  const outcome = record.result.observation?.outcome ?? (record.result.status === 'cancelled' ? 'cancelled' : 'denied');
  if (outcome === 'uncertain') return;
  return { outcome, toolCallId: record.call.toolCallId, evidenceRef: `tool-result://${record.call.toolCallId}`,
    ...(record.result.observation?.observedVersion ? { observedVersion: record.result.observation.observedVersion } : {}) };
}
export function normalizeResourceEditPostlude(raw: unknown): ResourceEditPostlude | undefined {
  if (!object(raw) || !bounded(raw, RESOURCE_EDIT_POSTLUDE_BYTES) || !keys(raw, ['schemaVersion', 'requestId', 'payloadHash', 'completedAt', 'status', 'reason', 'hookFinalDecision', 'hooks'])
    || raw.schemaVersion !== 1 || !resourceEditToken(raw.requestId) || !resourceEditDigest(raw.payloadHash) || !timestamp(raw.completedAt) || !['recorded', 'unconfirmed'].includes(raw.status as string)
    || raw.status === 'unconfirmed' && !text(raw.reason, 2048) || raw.reason !== undefined && !text(raw.reason, 2048) || raw.hookFinalDecision !== undefined && !['allow', 'ask', 'deny'].includes(raw.hookFinalDecision as string)
    || raw.hooks !== undefined && (!Array.isArray(raw.hooks) || raw.hooks.length > 64)) return;
  const hooks: ResourceEditHookFact[] = [];
  for (const item of (raw.hooks ?? []) as unknown[]) {
    if (!object(item) || !keys(item, ['id', 'event', 'decision', 'reason', 'outcome', 'durationMs', 'exitCode']) || !['allow', 'ask', 'deny'].includes(item.decision as string)
      || item.id !== undefined && !text(item.id, 512) || item.event !== undefined && !['PreToolUse', 'PostToolUse'].includes(item.event as string)
      || item.reason !== undefined && !text(item.reason, 2048) || item.outcome !== undefined && !text(item.outcome, 128)
      || item.durationMs !== undefined && (typeof item.durationMs !== 'number' || !Number.isFinite(item.durationMs) || item.durationMs < 0)
      || item.exitCode !== undefined && item.exitCode !== null && !Number.isSafeInteger(item.exitCode)) return;
    hooks.push({ ...item } as unknown as ResourceEditHookFact);
  }
  return { schemaVersion: 1, requestId: raw.requestId, payloadHash: raw.payloadHash, completedAt: raw.completedAt, status: raw.status as ResourceEditPostlude['status'],
    ...(raw.reason !== undefined ? { reason: raw.reason as string } : {}), ...(raw.hookFinalDecision !== undefined ? { hookFinalDecision: raw.hookFinalDecision as 'allow' | 'ask' | 'deny' } : {}), ...(raw.hooks !== undefined ? { hooks } : {}) };
}
