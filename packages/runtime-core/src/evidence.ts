import type {
  EvidenceRecord,
  EvidenceRef,
  RuntimeCapabilityId,
  RuntimeDecision,
  RuntimeJsonObject,
} from './contracts.ts';

export type EvidenceRedactor = (record: EvidenceRecord) => EvidenceRecord;

export type RuntimeEvidenceObject = Readonly<Record<string, unknown>>;

export interface CollectToolEvidenceRefsOptions {
  readonly toolCallId?: unknown;
  readonly execution?: unknown;
}

function asEvidenceObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function addEvidenceRefStrings(target: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim()) {
    target.add(value.trim());
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) target.add(item.trim());
  }
}

/**
 * Collect the canonical refs exposed by a governed tool execution.
 *
 * The collector deliberately reads only known Tool Result fields. It never scans
 * arbitrary model-visible output for URI-looking strings, so untrusted output
 * cannot register itself as Evidence.
 */
export function collectToolEvidenceRefs(
  options: CollectToolEvidenceRefsOptions = {},
): string[] {
  const refs = new Set<string>();
  if (typeof options.toolCallId === 'string' && options.toolCallId.trim()) {
    refs.add(`tool-result://${options.toolCallId.trim()}`);
  }

  const execution = asEvidenceObject(options.execution);
  const result = asEvidenceObject(execution?.result);
  const evidence = asEvidenceObject(result?.evidence);
  addEvidenceRefStrings(refs, evidence?.artifactRefs);

  const outputPreview = asEvidenceObject(result?.outputPreview);
  addEvidenceRefStrings(refs, outputPreview?.artifactRef);
  addEvidenceRefStrings(refs, outputPreview?.artifactRefs);

  const localToolResultRef = asEvidenceObject(outputPreview?.localToolResultRef);
  addEvidenceRefStrings(refs, localToolResultRef?.artifactRef);
  addEvidenceRefStrings(refs, localToolResultRef?.artifactRefs);

  return [...refs];
}

export interface CreateEvidenceBundleOptions {
  readonly evidenceId?: string;
  readonly toolCallId?: string;
  readonly summary?: string;
  readonly locale?: string;
  readonly returnedToCloud?: boolean;
  readonly dataLevel?: string;
  readonly redactions?: readonly string[];
  readonly artifactRefs?: readonly EvidenceRef[];
  readonly records?: readonly EvidenceRecord[];
  readonly refs?: readonly EvidenceRef[];
  readonly metadata?: RuntimeJsonObject;
}

export interface AppendEvidenceRecordsOptions {
  readonly refs?: readonly EvidenceRef[];
  readonly metadata?: RuntimeJsonObject;
}

export interface HookEvidenceRecordSource {
  readonly id?: string;
  readonly hookId?: string;
  readonly event?: string;
  readonly decision?: RuntimeDecision;
  readonly reason?: string;
  readonly outcome?: string;
  readonly durationMs?: number;
  readonly exitCode?: number | null;
}

export interface HookEvidenceRecord {
  readonly id?: string;
  readonly event?: string;
  readonly decision?: RuntimeDecision;
  readonly reason?: string;
  readonly outcome?: string;
  readonly durationMs?: number;
  readonly exitCode?: number | null;
}

export interface AppendHookEvidenceOptions {
  readonly recordedAt?: string;
  readonly now?: () => string;
}

function isEvidenceObject(value: unknown): value is RuntimeEvidenceObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asReadonlyArray<T = unknown>(value: unknown): readonly T[] {
  return Array.isArray(value) ? value : [];
}

export const EVIDENCE_EXPORT_KIND = 'peer.evidence.export';
export const EVIDENCE_EXPORT_SCHEMA_VERSION = 1;

export interface EvidenceExportSource {
  readonly planId?: string;
  readonly conversationId?: string;
  readonly capabilityId?: RuntimeCapabilityId;
  readonly toolCallId?: string;
}

export interface CreateEvidenceExportDocumentOptions {
  readonly exportedAt?: string;
  readonly source?: EvidenceExportSource;
  readonly summary?: string;
  readonly refs?: readonly EvidenceRef[];
  readonly records?: readonly EvidenceRecord[];
  readonly metadata?: RuntimeJsonObject;
}

export interface EvidenceExportDocument {
  readonly kind: typeof EVIDENCE_EXPORT_KIND;
  readonly schemaVersion: typeof EVIDENCE_EXPORT_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly source: EvidenceExportSource;
  readonly summary?: string;
  readonly refs: readonly EvidenceRef[];
  readonly records: readonly EvidenceRecord[];
  readonly metadata?: RuntimeJsonObject;
}

/**
 * Pack already-admitted refs and records into a portable JSON document.
 * This does not scan model output or enlarge the Evidence whitelist.
 */
export function createEvidenceExportDocument(
  options: CreateEvidenceExportDocumentOptions = {},
): EvidenceExportDocument {
  const refs: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const ref of options.refs ?? []) {
    if (typeof ref !== 'string') continue;
    const trimmed = ref.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    refs.push(trimmed);
  }
  const document: EvidenceExportDocument = {
    kind: EVIDENCE_EXPORT_KIND,
    schemaVersion: EVIDENCE_EXPORT_SCHEMA_VERSION,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    source: options.source ?? {},
    refs,
    records: [...(options.records ?? [])],
  };
  const summary = typeof options.summary === 'string' ? options.summary.trim() : '';
  return {
    ...document,
    ...(summary ? { summary } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

export function serializeEvidenceExportDocument(document: EvidenceExportDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function createEvidenceBundle(
  options: CreateEvidenceBundleOptions = {},
): RuntimeEvidenceObject {
  return {
    evidenceId: options.evidenceId,
    toolCallId: options.toolCallId,
    summary: options.summary,
    locale: options.locale,
    returnedToCloud: options.returnedToCloud ?? false,
    dataLevel: options.dataLevel ?? 'D0_public',
    redactions: [...asReadonlyArray<string>(options.redactions)],
    artifactRefs: [...asReadonlyArray<EvidenceRef>(options.artifactRefs)],
    ...(options.records ? { records: [...options.records] } : {}),
    ...(options.refs ? { refs: [...options.refs] } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

export function applyEvidenceRedactors(
  record: EvidenceRecord,
  redactors: readonly EvidenceRedactor[] = [],
): EvidenceRecord {
  return redactors.reduce((current, redact) => redact(current), record);
}

export function appendEvidenceRecords<T extends { readonly evidence?: unknown }>(
  result: T,
  records: readonly EvidenceRecord[] = [],
  options: AppendEvidenceRecordsOptions = {},
): T {
  if (!result || !Array.isArray(records) || records.length === 0) return result;

  const existingEvidence = isEvidenceObject(result.evidence) ? result.evidence : {};
  const existingRecords = asReadonlyArray<EvidenceRecord>(existingEvidence.records);
  const nextEvidence: Record<string, unknown> = {
    ...existingEvidence,
    records: [
      ...existingRecords,
      ...records,
    ],
  };

  if (options.refs && options.refs.length > 0) {
    nextEvidence.refs = [
      ...asReadonlyArray<EvidenceRef>(existingEvidence.refs),
      ...options.refs,
    ];
  }

  if (options.metadata) {
    nextEvidence.metadata = {
      ...(isEvidenceObject(existingEvidence.metadata) ? existingEvidence.metadata : {}),
      ...options.metadata,
    };
  }

  return {
    ...result,
    evidence: nextEvidence,
  } as T;
}

export function sanitizeHookEvidenceRecord(record: HookEvidenceRecordSource): HookEvidenceRecord {
  return {
    id: record.id ?? record.hookId,
    event: record.event,
    decision: record.decision,
    reason: record.reason,
    outcome: record.outcome,
    durationMs: record.durationMs,
    exitCode: record.exitCode,
  };
}

export function appendHookEvidence<T extends { readonly evidence?: unknown }>(
  result: T,
  hookRecords: readonly HookEvidenceRecordSource[] = [],
  finalDecision: RuntimeDecision | undefined = undefined,
  options: AppendHookEvidenceOptions = {},
): T {
  if (!result || !Array.isArray(hookRecords) || hookRecords.length === 0) return result;

  const existingEvidence = isEvidenceObject(result.evidence) ? result.evidence : {};
  const existingHooks = asReadonlyArray<HookEvidenceRecord>(existingEvidence.hooks);
  const recordedAt = options.recordedAt ?? options.now?.();
  const nextEvidence: Record<string, unknown> = {
    ...existingEvidence,
    hooks: [
      ...existingHooks,
      ...hookRecords.map(sanitizeHookEvidenceRecord),
    ],
    hookFinalDecision: finalDecision ?? existingEvidence.hookFinalDecision,
  };

  if (recordedAt) {
    nextEvidence.hookRecordedAt = recordedAt;
  }

  return {
    ...result,
    evidence: nextEvidence,
  } as T;
}
