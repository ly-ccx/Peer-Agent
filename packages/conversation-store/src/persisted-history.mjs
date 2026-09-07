import { readFileSync } from 'node:fs';

function fail(code, cause) {
  throw Object.assign(new Error(code, { cause }), { code });
}

function readText(file, missingAllowed) {
  try { return readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && missingAllowed) return null;
    fail(error.code === 'ENOENT' ? 'BACKGROUND_HISTORY_MISSING' : 'BACKGROUND_READ_FAILED', error);
  }
}

/** Strict snapshot input, separate from tolerant UI history recovery. */
export function readPersistedHistoryFiles({ historyFile, sidecarFile, conversationId, contentRevision }) {
  // New conversations legitimately have no JSONL until their first message.
  const text = readText(historyFile, contentRevision === 0);
  let messages;
  try {
    messages = (text ?? '').split('\n').filter((line) => line.trim()).map((line) => {
      const message = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
      return message;
    });
    if (contentRevision > 0 && messages.length === 0) throw new Error('Empty history with nonzero revision');
  } catch (error) { fail('BACKGROUND_HISTORY_CORRUPT', error); }
  const sidecarText = readText(sidecarFile, true);
  let activeMessageId = null;
  if (sidecarText !== null) {
    try {
      const sidecar = JSON.parse(sidecarText);
      if (sidecar?.version !== 1 || sidecar.conversationId !== conversationId
        || typeof sidecar.messageId !== 'string' || !sidecar.messageId
        || !sidecar.patch || typeof sidecar.patch !== 'object' || Array.isArray(sidecar.patch)) {
        throw new Error('Invalid streaming marker');
      }
      activeMessageId = sidecar.messageId;
    } catch (error) { fail('BACKGROUND_STREAM_STATE_INVALID', error); }
  }
  const provisionalIndex = activeMessageId ? messages.findIndex((message) => message.id === activeMessageId) : -1;
  // Cannot infer the committed prefix when a streaming marker has no target.
  if (activeMessageId && provisionalIndex < 0) fail('BACKGROUND_STREAM_TARGET_MISSING');
  return {
    conversationId,
    contentRevision,
    messages: provisionalIndex >= 0 ? messages.slice(0, provisionalIndex) : messages,
    excludedFromMessageId: activeMessageId,
    requiresRuntimeCheck: true,
  };
}
