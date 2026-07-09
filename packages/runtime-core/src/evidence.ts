import type {
  EvidenceRecord,
  EvidenceRef,
  RuntimeDecision,
  RuntimeJsonObject,
} from './contracts.ts';

export type EvidenceRedactor = (record: EvidenceRecord) => EvidenceRecord;

export type RuntimeEvidenceObject = Readonly<Record<string, unknown>>;

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
