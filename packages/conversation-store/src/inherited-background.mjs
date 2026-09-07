import { selectionTextHash } from './selection-reference.mjs';

function reject(code) { throw Object.assign(new Error(code), { code }); }

/** Build data, never provider messages. Runtime must attest revision/liveness.
 * Attachment and tool material need a separate governed resolver; omissions are explicit.
 */
export function buildInheritedBackground(history, { expectedRevision, runtimeState, maxCharacters = 64000, capturedAt }) {
  if (!history || !Array.isArray(history.messages)) reject('BACKGROUND_HISTORY_MISSING');
  if (!Number.isSafeInteger(expectedRevision) || history.contentRevision !== expectedRevision) reject('BACKGROUND_VERSION_CHANGED');
  if (!runtimeState || runtimeState.conversationId !== history.conversationId
    || runtimeState.contentRevision !== expectedRevision
    || !['idle', 'running'].includes(runtimeState.status)) reject('BACKGROUND_RUNTIME_UNCONFIRMED');
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) reject('BACKGROUND_INVALID_BUDGET');
  if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))) reject('BACKGROUND_INVALID_TIME');
  let rows = history.messages;
  let excludedFromMessageId = history.excludedFromMessageId ?? null;
  if (runtimeState.status === 'running') {
    const active = runtimeState.activeMessageId;
    if (typeof active !== 'string' || !active) reject('BACKGROUND_RUNTIME_UNCONFIRMED');
    const index = rows.findIndex((m) => m.id === active);
    if (index >= 0) { rows = rows.slice(0, index); excludedFromMessageId = active; }
    else if (excludedFromMessageId !== active) reject('BACKGROUND_RUNTIME_UNCONFIRMED');
  }
  let summaryIndex = -1;
  rows.forEach((row, index) => { if (row?._compaction) summaryIndex = index; });
  if (summaryIndex >= 0 && (rows[summaryIndex].role !== 'user'
    || typeof rows[summaryIndex].content !== 'string' || !rows[summaryIndex].content.trim())) reject('BACKGROUND_SUMMARY_INVALID');
  const coveredMessageIds = summaryIndex >= 0 ? rows.slice(0, summaryIndex).map((m) => m.id) : [];
  const effectiveRows = summaryIndex >= 0 ? rows.slice(summaryIndex) : rows;
  const missingItems = [];
  const entries = [];
  for (const row of effectiveRows) {
    if (typeof row.id !== 'string' || !row.id) reject('BACKGROUND_MESSAGE_ID_MISSING');
    if (!['user', 'assistant', 'tool', 'system', 'developer'].includes(row.role)) reject('BACKGROUND_MESSAGE_INVALID');
    if (row.role === 'system' || row.role === 'developer') continue;
    if (row.role === 'tool') {
      missingItems.push({ sourceMessageId: row.id, reason: 'tool_result_requires_evidence_resolver' });
      continue;
    }
    if (row.tool_calls?.length || row.segments?.some((segment) => segment.type !== 'text' && segment.type !== 'thinking')) {
      missingItems.push({ sourceMessageId: row.id, reason: 'tool_material_requires_evidence_resolver' });
    }
    if (row.attachments?.length || (row.content != null && typeof row.content !== 'string')) {
      missingItems.push({ sourceMessageId: row.id, reason: 'attachment_material_requires_resolver' });
    }
    if (typeof row.content === 'string' && row.content.trim()) {
      entries.push({ sourceMessageId: row.id, sourceRole: row.role,
        kind: row._compaction ? 'summary' : 'text', text: row.content });
    }
  }
  const characterCount = entries.reduce((sum, entry) => sum + [...entry.text].length, 0);
  if (characterCount > maxCharacters) reject('BACKGROUND_BUDGET_EXCEEDED');
  const data = { schemaVersion: 1, sourceConversationId: history.conversationId,
    sourceRevision: expectedRevision, capturedAt, excludedFromMessageId,
    coveredMessageIds, entries, missingItems, characterCount,
    status: missingItems.length ? 'partial' : summaryIndex >= 0 ? 'compacted' : 'full',
    requiresMissingConfirmation: missingItems.length > 0 };
  return { ...data, contentHash: selectionTextHash(JSON.stringify(data)) };
}
