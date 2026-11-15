/** Source references only; this object never proves a capability result. */
export interface CompactionHistorySelection {
  readonly version: 1;
  readonly compactionEpoch: number;
  readonly retainedMessageIds: readonly string[];
}
/** Checked against the language-neutral resource by native CLI conformance. */
export const COMPACTION_HISTORY_SELECTION_LIMITS = Object.freeze({
  version: 1, projectorVersion: 3, maxRetained: 4096, maxIdBytes: 200, maxSelectionBytes: 65536,
});
export function normalizeCompactionHistorySelection(value: unknown): CompactionHistorySelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(k => !['version', 'compactionEpoch', 'retainedMessageIds'].includes(k))
      || row.version !== 1 || !Number.isSafeInteger(row.compactionEpoch) || Number(row.compactionEpoch) <= 0
      || !Array.isArray(row.retainedMessageIds) || row.retainedMessageIds.length > COMPACTION_HISTORY_SELECTION_LIMITS.maxRetained) return null;
  const seen = new Set<string>(); const encoder = new TextEncoder(); let bytes = 0;
  for (const id of row.retainedMessageIds) {
    if (typeof id !== 'string' || !id || seen.has(id)) return null;
    if ([...id].some(c => {const point = c.codePointAt(0)!; return point >= 0xD800 && point <= 0xDFFF;})) return null;
    const size = encoder.encode(id).length;
    if (size > COMPACTION_HISTORY_SELECTION_LIMITS.maxIdBytes) return null;
    bytes += size; seen.add(id);
  }
  if (bytes > COMPACTION_HISTORY_SELECTION_LIMITS.maxSelectionBytes) return null;
  return {version: 1, compactionEpoch: Number(row.compactionEpoch), retainedMessageIds: [...seen]};
}
