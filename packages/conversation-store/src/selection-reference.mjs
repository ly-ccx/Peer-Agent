import { createHash } from 'node:crypto';

export const MAX_SELECTION_CHARACTERS = 8000;

function reject(code) {
  throw Object.assign(new Error(code), { code });
}

export function selectionTextHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function splitsSurrogate(text, offset) {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * Validate against an authoritative, committed canonical text block.
 * The caller must resolve this block from storage, never trust renderer text.
 * Range offsets are UTF-16; the product length limit counts Unicode code points.
 * Only explicit fields are retained: no permissions, runtime state or DOM data.
 */
export function validateSelectionReference(selection, source) {
  if (!selection || !source || typeof source.text !== 'string') reject('INVALID_SELECTION');
  if (!source.committed) reject('SOURCE_NOT_COMMITTED');
  if (!['user', 'assistant'].includes(source.role)) reject('SOURCE_NOT_SELECTABLE');
  for (const field of ['conversationId', 'messageId', 'blockId']) {
    if (typeof source[field] !== 'string' || !source[field]
      || selection[field] !== source[field]) reject('SOURCE_MISMATCH');
  }
  if (!Number.isSafeInteger(source.revision) || source.revision < 0
    || selection.revision !== source.revision) reject('SOURCE_VERSION_CHANGED');
  const { start, end } = selection;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end <= start || end > source.text.length
    || splitsSurrogate(source.text, start) || splitsSurrogate(source.text, end)) {
    reject('INVALID_SELECTION_RANGE');
  }
  const exactText = source.text.slice(start, end);
  if (!exactText.trim()) reject('EMPTY_SELECTION');
  if ([...exactText].length > MAX_SELECTION_CHARACTERS) reject('SELECTION_TOO_LARGE');
  if (selection.exactText !== exactText
    || selection.sourceTextHash !== selectionTextHash(source.text)) reject('SOURCE_TEXT_CHANGED');
  const identity = [source.conversationId, source.messageId, source.blockId, source.revision, start, end];
  const textHash = selectionTextHash(exactText);
  return {
    schemaVersion: 1,
    id: selectionTextHash(JSON.stringify([...identity, textHash])),
    sourceConversationId: source.conversationId,
    sourceMessageId: source.messageId,
    blockId: source.blockId,
    sourceRevision: source.revision,
    sourceRole: source.role,
    start,
    end,
    exactText,
    textHash,
    sourceTextHash: selection.sourceTextHash,
  };
}
