import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';

const PORTABLE_HISTORY_BYTES = 8 * 1024 * 1024;
const conversationIdAllowed = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const fileRevision = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

function fail(code, cause) {
  throw Object.assign(new Error(code, { cause }), { code });
}

function readText(file, missingAllowed, maxBytes, readBudget) {
  try {
    if (maxBytes === undefined) return readFileSync(file, 'utf8');
    const revision = lstatSync(file, { bigint: true });
    if (!revision.isFile() || revision.size > BigInt(maxBytes)) fail('BACKGROUND_HISTORY_LIMIT');
    const bufferSize = Number(revision.size) + 1;
    if (readBudget) {
      if (!Number.isSafeInteger(readBudget.remainingBytes) || readBudget.remainingBytes < bufferSize) fail('BACKGROUND_HISTORY_LIMIT');
      readBudget.remainingBytes -= bufferSize;
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      if (fileRevision(fstatSync(fd, { bigint: true })) !== fileRevision(revision)) fail('BACKGROUND_VERSION_CHANGED');
      const body = Buffer.alloc(bufferSize);
      let bytes = 0;
      while (bytes < body.length) {
        const count = readSync(fd, body, bytes, body.length - bytes, null);
        if (!count) break;
        bytes += count;
      }
      if (bytes !== body.length - 1 || fileRevision(lstatSync(file, { bigint: true })) !== fileRevision(revision)) fail('BACKGROUND_VERSION_CHANGED');
      return new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, bytes));
    } finally { closeSync(fd); }
  } catch (error) {
    if (error.code === 'ENOENT' && missingAllowed) return null;
    if (error.code?.startsWith('BACKGROUND_')) throw error;
    fail(error.code === 'ENOENT' ? 'BACKGROUND_HISTORY_MISSING' : 'BACKGROUND_READ_FAILED', error);
  }
}

/** Strict snapshot input, separate from tolerant UI history recovery. */
export function readPersistedHistoryFiles({ historyFile, sidecarFile, conversationId, contentRevision, maxBytes, readBudget }) {
  // New conversations legitimately have no JSONL until their first message.
  const text = readText(historyFile, contentRevision === 0, maxBytes, readBudget);
  let messages;
  try {
    messages = (text ?? '').split('\n').filter((line) => line.trim()).map((line) => {
      const message = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
      return message;
    });
    if (contentRevision > 0 && messages.length === 0) throw new Error('Empty history with nonzero revision');
  } catch (error) { fail('BACKGROUND_HISTORY_CORRUPT', error); }
  const sidecarText = readText(sidecarFile, true, maxBytes, readBudget);
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

/** Read an already-imported work conversation without constructing a migrating store. */
export function readStoredWorkHistory(storeDir, { workspaceId, parentConversationId, conversationId, sessionId }, readBudget) {
  if (![parentConversationId, conversationId].every(conversationIdAllowed) || parentConversationId === conversationId) return null;
  const indexFile = path.join(storeDir, 'index.jsonl');
  const historyFile = path.join(storeDir, `${conversationId}.jsonl`), sidecarFile = path.join(storeDir, `${conversationId}.stream.json`);
  const revision = file => {
    try { return fileRevision(lstatSync(file, { bigint: true })); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const files = [indexFile, historyFile, sidecarFile];
  const before = files.map(revision);
  const index = readText(indexFile, true, PORTABLE_HISTORY_BYTES, readBudget);
  if (!index) return null;
  const rows = index.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const parent = rows.filter(row => row?.id === parentConversationId), work = rows.filter(row => row?.id === conversationId);
  const meta = work[0];
  if (parent.length !== 1 || parent[0].role !== 'project_agent' || parent[0].workspaceId !== workspaceId || work.length !== 1
    || meta.role !== 'work_session' || meta.workspaceId !== workspaceId || meta.parentConversationId !== parentConversationId
    || meta.delegation?.sessionId !== sessionId) return null;
  const contentRevision = meta.contentRevision ?? 0;
  if (!Number.isSafeInteger(contentRevision) || contentRevision < 0) fail('BACKGROUND_HISTORY_CORRUPT');
  const history = readPersistedHistoryFiles({ historyFile, sidecarFile, conversationId, contentRevision, maxBytes: PORTABLE_HISTORY_BYTES, readBudget });
  if (files.some((file, offset) => revision(file) !== before[offset])) fail('BACKGROUND_VERSION_CHANGED');
  return history;
}
