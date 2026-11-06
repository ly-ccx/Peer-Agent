import { normalizeResourceEditTarget, resourceEditDigest, resourceEditToken, validResourceEditText, type ResourceEditTarget } from './resource-edit.ts';
export const RESOURCE_FILE_REPLACE_CAPABILITY = 'local.file.replace';
export const RESOURCE_FILE_REPLACE_PROVIDER = 'local.file.conditional';
export const RESOURCE_FILE_REPLACE_TOOL = 'replace_file_if_version';
/** Host-hydrated Tool Call input. Submit IPC must not accept this object or a caller-supplied permission. */
export interface ResourceFileReplaceInput {
  readonly requestId: string; readonly target: ResourceEditTarget; readonly content: string; readonly proposedVersion: string;
}
export type ResourceFileReplaceOutcome = 'applied' | 'conflict' | 'denied' | 'cancelled' | 'failed' | 'uncertain';
export function normalizeResourceFileReplaceInput(raw: unknown): ResourceFileReplaceInput | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['requestId', 'target', 'content', 'proposedVersion'].includes(key)) || !resourceEditToken(value.requestId)
    || !validResourceEditText(value.content) || !resourceEditDigest(value.proposedVersion)) return;
  const target = normalizeResourceEditTarget(value.target); if (!target) return;
  return { requestId: value.requestId, target, content: value.content, proposedVersion: value.proposedVersion };
}

/** A structured Provider observation, not a permission, Evidence record or task acceptance. */
export interface ResourceFileReplacePreview {
  readonly kind: 'resource_file_replace_result'; readonly requestId: string; readonly path: string; readonly resourceId: string;
  readonly expectedVersion: string; readonly proposedVersion: string; readonly observedVersion?: string;
  readonly status: 'success' | 'failed' | 'denied' | 'cancelled'; readonly outcome: ResourceFileReplaceOutcome; readonly effectStarted: boolean;
  readonly reason?: string; readonly permissionCallId?: string; readonly bytesBefore?: number; readonly bytesAfter?: number;
  readonly diffPreview?: string; readonly diffPreviewTruncated?: boolean; readonly additions?: number; readonly deletions?: number; readonly previewOnly?: true;
}
export function normalizeResourceFileReplacePreview(raw: unknown): ResourceFileReplacePreview | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const value = raw as Record<string, unknown>, keys = ['kind', 'requestId', 'path', 'resourceId', 'expectedVersion', 'proposedVersion', 'observedVersion', 'status', 'outcome', 'effectStarted', 'reason', 'permissionCallId', 'bytesBefore', 'bytesAfter', 'diffPreview', 'diffPreviewTruncated', 'additions', 'deletions', 'previewOnly'];
  const text = (v: unknown, limit: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= limit && !/[\u0000-\u001f]/.test(v);
  if (Object.keys(value).some(key => !keys.includes(key)) || value.kind !== 'resource_file_replace_result' || !resourceEditToken(value.requestId)
    || !text(value.path, 8192) || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value.path) || !resourceEditDigest(value.resourceId)
    || !resourceEditDigest(value.expectedVersion) || !resourceEditDigest(value.proposedVersion) || typeof value.effectStarted !== 'boolean'
    || !['applied', 'conflict', 'denied', 'cancelled', 'failed', 'uncertain'].includes(value.outcome as string)) return;
  const outcome = value.outcome as ResourceFileReplaceOutcome, status = outcome === 'applied' ? 'success' : outcome === 'denied' ? 'denied' : outcome === 'cancelled' ? 'cancelled' : 'failed';
  if (value.status !== status || value.observedVersion !== undefined && !resourceEditDigest(value.observedVersion)
    || outcome === 'applied' && (value.observedVersion !== value.proposedVersion || !value.effectStarted && (value.reason !== 'no_change' || value.expectedVersion !== value.proposedVersion))
    || !['applied', 'uncertain'].includes(outcome) && value.effectStarted
    || value.reason !== undefined && !text(value.reason, 2048) || value.permissionCallId !== undefined && !text(value.permissionCallId, 1024)
    || ['bytesBefore', 'bytesAfter', 'additions', 'deletions'].some(key => value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0 || Number(value[key]) > (key.startsWith('bytes') ? 1048576 : 1048577)))
    || value.diffPreview !== undefined && (typeof value.diffPreview !== 'string' || value.diffPreview.length > 4000)
    || value.diffPreviewTruncated !== undefined && typeof value.diffPreviewTruncated !== 'boolean'
    || value.previewOnly !== undefined && value.previewOnly !== true) return;
  return { kind: value.kind, requestId: value.requestId, path: value.path, resourceId: value.resourceId, expectedVersion: value.expectedVersion, proposedVersion: value.proposedVersion,
    status, outcome, effectStarted: value.effectStarted,
    ...Object.fromEntries(keys.filter(key => !['kind', 'requestId', 'path', 'resourceId', 'expectedVersion', 'proposedVersion', 'status', 'outcome', 'effectStarted'].includes(key) && value[key] !== undefined).map(key => [key, value[key]])) } as ResourceFileReplacePreview;
}
