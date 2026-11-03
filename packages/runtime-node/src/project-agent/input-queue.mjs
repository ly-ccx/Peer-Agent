import { createHash, randomUUID } from 'node:crypto';
import { normalizeResourceFeedbackList, restoreResourceFeedbackTransport, encodeResourceFeedbackTransport, isInteractiveFeedbackAttachment } from '@peer-agent/protocol';
/**
 * 项目输入队列。所有入口把用户输入追加到 input-queue.jsonl。
 * 只有宿主按游标消费：写入机器人对话（消息 id 由 inputId 派生），再推进游标，然后通知唤醒。
 * 同一 inputId 再提交返回第一次的结果。对话已写入但游标未推进时，重放不产生第二条消息。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { INPUT_ATTACHMENT_LIMIT, normalizeUserUpload } from './input-attachments.mjs';
import { pathOf } from '../data-store.mjs';

const WORKSPACE_DIR = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const INPUT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SURFACES = new Set(['desktop', 'quick_chat', 'tui', 'remote']);
const STORED_INPUT_FIELDS = new Set(['inputId', 'workspaceId', 'surface', 'text', 'anchorRefs', 'quoteRefs', 'attachmentRefs',
  'attachments', 'resourceFeedback', 'createdAt', 'answerTo', 'historyRef', 'historySnapshotId', 'historyConfirmed']);
const LOCK_STALE_MS = 10_000;

export function inputMessageId(inputId) {
  const text = typeof inputId === 'string' ? inputId.trim() : '';
  if (!INPUT_ID.test(text)) throw new TypeError('inputId is invalid');
  return `input-${text}`;
}

export function createInputQueue({
  rootDir = null,
  now = () => new Date().toISOString(),
  holdsLease = null,
  resolveConversationId = null,
  hasMessage = null,
  appendMessage = null,
  onCommitted = null,
  validateInteractiveFeedback = null,
} = {}) {
  function admit(input, workspaceId) {
    for (const row of input.resourceFeedback ?? []) if (row.resource.kind === 'interactive') {
      try { if (validateInteractiveFeedback?.(row, workspaceId) !== true) throw Error('not admitted'); }
      catch (error) { if (/INTERACTIVE_FEEDBACK/.test(error?.code ?? '')) throw error;
        throw Object.assign(Error('INTERACTIVE_FEEDBACK_UNAVAILABLE'), { code: 'INTERACTIVE_FEEDBACK_UNAVAILABLE', cause: error }); }
    }
    return input;
  }
  const inputCache = new Map();
  let cachedBytes = 0;
  const dropCached = key => { const row = inputCache.get(key); if (row) cachedBytes -= row.bytes; inputCache.delete(key); };
  const inputVersion = file => {
    const info = statSync(file, { bigint: true });
    return { token: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`, bytes: Number(info.size) * 2 };
  };
  const copyInputs = inputs => inputs.map(input => ({ ...input,
    anchorRefs: [...input.anchorRefs], quoteRefs: [...input.quoteRefs], attachmentRefs: [...input.attachmentRefs],
    ...(input.attachments ? { attachments: input.attachments.map(item => ({ ...item })) } : {}),
    ...(input.resourceFeedback ? { resourceFeedback: normalizeResourceFeedbackList(input.resourceFeedback) } : {}),
  }));
  function root() {
    return rootDir || pathOf('projectRuntime');
  }

  function workspaceIdOf(workspaceId) {
    const text = typeof workspaceId === 'string' ? workspaceId.trim() : '';
    return WORKSPACE_DIR.test(text) ? text : '';
  }

  function dirFor(workspaceId) {
    return path.join(root(), workspaceId);
  }

  function queueFile(workspaceId) {
    return path.join(dirFor(workspaceId), 'input-queue.jsonl');
  }

  function cursorFile(workspaceId) {
    return path.join(dirFor(workspaceId), 'input-cursor.json');
  }

  function stamp() {
    const value = now();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
  }

  function acquireLock(workspaceId, waitMs) {
    const lock = `${queueFile(workspaceId)}.lock`;
    mkdirSync(path.dirname(lock), { recursive: true });
    const deadline = Date.now() + waitMs;
    const identity = () => {
      const stat = statSync(lock, { bigint: true });
      return `${stat.dev}:${stat.ino}`;
    };
    const reclaimable = () => {
      let owner;
      try { owner = JSON.parse(readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch {}
      if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
      try { process.kill(owner.pid, 0); return false; }
      catch (error) { return error?.code === 'ESRCH'; }
    };
    while (true) {
      try { mkdirSync(lock); }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw error;
        try {
          const observed = identity();
          if (reclaimable()) {
            const recovery = `${lock}.recovery`;
            mkdirSync(recovery);
            try { if (identity() === observed && reclaimable()) rmSync(lock, { recursive: true, force: true }); }
            finally { rmSync(recovery, { recursive: true, force: true }); }
          }
        } catch { /* Another process may be releasing or recovering this lock. */ }
        continue;
      }
      const held = identity(), ownerFile = path.join(lock, 'owner.json');
      const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
      const current = () => {
        try { return identity() === held && readFileSync(ownerFile, 'utf8') === owner; } catch { return false; }
      };
      const release = () => { if (current()) rmSync(lock, { recursive: true, force: true }); };
      try { writeFileSync(ownerFile, owner); }
      catch (error) {
        try { if (identity() === held) rmSync(lock, { recursive: true, force: true }); } catch {}
        throw error;
      }
      if (!current()) throw Error('INPUT_QUEUE_CHANGED');
      return { current, release };
    }
  }

  function withLock(workspaceId, fn) {
    const lock = acquireLock(workspaceId, 5000);
    try { return fn(); } finally { lock.release(); }
  }

  function readInputs(workspaceId, strict = false, attempt = 0) {
    const file = queueFile(workspaceId);
    const key = `${file}:${strict}`;
    let version;
    try { version = inputVersion(file); }
    catch (error) { dropCached(key); if (strict && error.code !== 'ENOENT') throw error; return []; }
    if (strict === 'retention' && version.bytes > 64 * 1024 * 1024) throw Error('INPUT_QUEUE_RETENTION_LIMIT');
    const cached = inputCache.get(key);
    if (cached?.version === version.token) {
      inputCache.delete(key); inputCache.set(key, cached);
      return copyInputs(cached.inputs).map(input => admit(input, workspaceId));
    }
    dropCached(key);
    let text = '';
    try {
      text = strict === 'retention' ? new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)) : readFileSync(file, 'utf8');
    } catch (error) {
      if (strict) throw error;
      return [];
    }
    const inputs = [];
    const seen = new Set();
    if (strict === 'retention' && text && !text.endsWith('\n')) throw Error('CORRUPT_INPUT_QUEUE');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (strict === 'retention' && (!row || row.workspaceId !== workspaceId || Object.keys(row).some(key => !STORED_INPUT_FIELDS.has(key))))
          throw Error('CORRUPT_INPUT_QUEUE');
        const input = normalizeStored(row, workspaceId);
        if (!input) { if (strict) throw new Error('CORRUPT_INPUT_QUEUE'); continue; }
        admit(input, workspaceId);
        if (seen.has(input.inputId)) {
          if (strict === 'retention') throw Error('CORRUPT_INPUT_QUEUE');
          continue;
        }
        seen.add(input.inputId);
        inputs.push(input);
      } catch (error) {
        if (strict || line.includes('peer-interactive-selection-') || /INTERACTIVE_FEEDBACK|INTERACTIVE_INPUT/.test(error.code ?? error.message ?? '')) throw error;
        // Legacy malformed rows keep their old behavior. Recognized selections never skip ahead.
      }
    }
    let current;
    try { current = inputVersion(file); }
    catch (error) { if (strict && error.code !== 'ENOENT') throw error; return []; }
    if (current.token !== version.token) {
      if (attempt < 2) return readInputs(workspaceId, strict, attempt + 1);
      if (strict) throw new Error('INPUT_QUEUE_CHANGED');
      return [];
    }
    if (version.bytes <= 32 * 1024 * 1024) {
      inputCache.set(key, { inputs, version: version.token, bytes: version.bytes }); cachedBytes += version.bytes;
      while (inputCache.size > 16 || cachedBytes > 32 * 1024 * 1024) dropCached(inputCache.keys().next().value);
    }
    return copyInputs(inputs);
  }

  function readCursorState(workspaceId) {
    try { return JSON.parse(readFileSync(cursorFile(workspaceId), 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; return {}; }
  }

  function readCursor(workspaceId) {
    const inputId = readCursorState(workspaceId)?.inputId;
    return typeof inputId === 'string' && inputId.trim() ? inputId.trim() : null;
  }

  function writeCursorState(workspaceId, state) {
    const file = cursorFile(workspaceId), tmp = `${file}.${process.pid}.tmp`;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(state)}\n`); renameSync(tmp, file);
  }

  function writeCursor(workspaceId, inputId) {
    writeCursorState(workspaceId, { ...readCursorState(workspaceId), inputId, consumedAt: stamp() });
  }

  function executionState(workspaceId, completed = [], repliedTo = []) {
    const state = readCursorState(workspaceId);
    const inputs = readInputs(workspaceId);
    const delivered = inputs.findIndex(input => input.inputId === state.inputId);
    if (delivered < 0) return [];
    const through = inputs.findIndex(input => input.inputId === state.executedInputId);
    const acknowledged = new Set(Array.isArray(state.completedInputIds) ? state.completedInputIds : []);
    const replies = new Set(repliedTo);
    for (const input of inputs.slice(0, delivered + 1)) {
      if (completed.includes(input.inputId) || replies.has(inputMessageId(input.inputId))) acknowledged.add(input.inputId);
    }
    let index = through;
    while (index < delivered && acknowledged.has(inputs[index + 1].inputId)) acknowledged.delete(inputs[++index].inputId);
    const pending = inputs.slice(index + 1, delivered + 1).filter(input => !acknowledged.has(input.inputId));
    const next = { ...state, ...(index >= 0 ? { executedInputId: inputs[index].inputId } : {}),
      completedInputIds: [...acknowledged] };
    if (JSON.stringify(next) !== JSON.stringify(state)) writeCursorState(workspaceId, next);
    return pending;
  }

  function pendingExecution(workspaceId, { repliedTo = [] } = {}) {
    const id = workspaceIdOf(workspaceId);
    if (!id || typeof holdsLease === 'function' && holdsLease(id) !== true) return [];
    return withLock(id, () => {
      const pending = executionState(id, [], Array.isArray(repliedTo) ? repliedTo : []);
      if (pending.some(input => input.resourceFeedback?.some(row => row.recipient.conversationId !== resolveConversationId?.(id)))) throw new Error('RESOURCE_FEEDBACK_RECIPIENT_CHANGED');
      return pending;
    });
  }

  function completeExecution(workspaceId, inputIds) {
    const id = workspaceIdOf(workspaceId);
    if (!id || typeof holdsLease === 'function' && holdsLease(id) !== true) return { ok: false, error: 'not_host' };
    withLock(id, () => executionState(id, Array.isArray(inputIds) ? inputIds : []));
    return { ok: true };
  }

  function submitInput(input) {
    const workspaceId = workspaceIdOf(input?.workspaceId);
    if (!workspaceId) throw new TypeError('workspaceId is invalid');
    const normalized = normalizeSubmission(input, workspaceId, stamp());
    return withLock(workspaceId, () => {
      const existing = readInputs(workspaceId).find((item) => item.inputId === normalized.inputId);
      if (existing) return existing;
      admit(normalized, workspaceId);
      if (normalized.resourceFeedback?.length) {
        const conversationId = typeof resolveConversationId === 'function' ? resolveConversationId(workspaceId) : null;
        if (!conversationId || normalized.resourceFeedback.some(row => row.recipient.conversationId !== conversationId)) throw Object.assign(new TypeError('RESOURCE_FEEDBACK_RECIPIENT_CHANGED'), { code: 'RESOURCE_FEEDBACK_RECIPIENT_CHANGED' });
      }
      mkdirSync(dirFor(workspaceId), { recursive: true });
      const { resourceFeedback: _feedback, attachments: _attachments, ...base } = normalized;
      appendFileSync(queueFile(workspaceId), `${JSON.stringify({ ...base, ...encodeResourceFeedbackTransport(normalized.resourceFeedback, normalized.attachments) })}\n`);
      return normalized;
    });
  }

  function pendingAfter(workspaceId) {
    const inputs = readInputs(workspaceId);
    const cursor = readCursor(workspaceId);
    if (!cursor) return inputs;
    const index = inputs.findIndex((item) => item.inputId === cursor);
    if (index < 0) return inputs;
    return inputs.slice(index + 1);
  }

  function consume(workspaceId) {
    const dirName = workspaceIdOf(workspaceId);
    if (!dirName) return { consumed: [], skipped: 'invalid-workspace' };
    if (typeof holdsLease === 'function' && holdsLease(dirName) !== true) {
      return { consumed: [], skipped: 'not-host' };
    }
    if (typeof resolveConversationId !== 'function' || typeof hasMessage !== 'function' || typeof appendMessage !== 'function') {
      throw new TypeError('input queue consumer requires conversation writers');
    }
    // Empty polling is read-only. A real batch still acquires the lock and
    // re-reads its current contents below; a later submission gets a new wake.
    if (!pendingAfter(dirName).length) {
      const conversationId = resolveConversationId(dirName);
      return { consumed: [], skipped: typeof conversationId === 'string' && conversationId.trim() ? null : 'no-conversation' };
    }
    const outcome = withLock(dirName, () => {
      const conversationId = resolveConversationId(dirName);
      if (typeof conversationId !== 'string' || !conversationId.trim()) {
        return { consumed: [], skipped: 'no-conversation' };
      }
      const targetId = conversationId.trim();
      const consumed = [];
      for (const input of pendingAfter(dirName)) {
        if (input.resourceFeedback?.some(row => row.recipient.conversationId !== targetId)) throw new Error('RESOURCE_FEEDBACK_RECIPIENT_CHANGED');
        const messageId = inputMessageId(input.inputId);
        const duplicateMessage = hasMessage(targetId, messageId) === true;
        if (!duplicateMessage) {
          const transport = encodeResourceFeedbackTransport(input.resourceFeedback, input.attachments);
          appendMessage(targetId, {
            id: messageId,
            role: 'user',
            kind: 'user_input',
            content: input.text,
            createdAt: input.createdAt,
            inputId: input.inputId,
            surface: input.surface,
            anchorRefs: input.anchorRefs,
            quoteRefs: input.quoteRefs,
            ...(transport.resourceFeedback ? { resourceFeedback: transport.resourceFeedback } : {}),
            attachmentRefs: input.attachmentRefs,
            ...(Array.isArray(transport.attachments) && transport.attachments.length > 0
              ? { attachments: transport.attachments }
              : {}),
            ...(input.answerTo ? { answerTo: input.answerTo } : {}),
            ...(input.historyRef ? { historyRef: input.historyRef } : {}),
            ...(input.historySnapshotId ? { historySnapshotId: input.historySnapshotId } : {}),
            ...(input.historyConfirmed === true ? { historyConfirmed: true } : {}),
          });
        }
        writeCursor(dirName, input.inputId);
        consumed.push({ ...input, duplicateMessage });
      }
      return {
        consumed,
        skipped: null,
        committed: consumed.length > 0
          ? { workspaceId: dirName, conversationId: targetId, inputs: consumed }
          : null,
      };
    });
    if (outcome.committed && typeof onCommitted === 'function') onCommitted(outcome.committed);
    return { consumed: outcome.consumed, skipped: outcome.skipped };
  }

  function checkedCursor(id) {
    const state = readCursorState(id);
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || ['inputId','executedInputId'].some(key => state[key] !== undefined && !INPUT_ID.test(state[key]))
      || state.completedInputIds !== undefined && (!Array.isArray(state.completedInputIds) || state.completedInputIds.some(value => typeof value !== 'string' || !INPUT_ID.test(value)))) throw new Error('CORRUPT_INPUT_CURSOR');
    return state;
  }

  function diagnosticSnapshot(workspaceId) {
    const id = workspaceIdOf(workspaceId);
    if (!id) throw new Error('INVALID_WORKSPACE');
    const inputs = readInputs(id, true), state = checkedCursor(id);
    const delivered = inputs.findIndex(input => input.inputId === state.inputId);
    const executed = inputs.findIndex(input => input.inputId === state.executedInputId);
    const completed = new Set(Array.isArray(state.completedInputIds) ? state.completedInputIds : []);
    return { depth: inputs.length - delivered - 1,
      executionDepth: inputs.slice(executed + 1, delivered + 1).filter(input => !completed.has(input.inputId)).length,
      cursor: state.inputId ?? null, executedCursor: state.executedInputId ?? null };
  }
  function acquireRetentionInputs(workspaceId) {
    const id = workspaceIdOf(workspaceId);
    if (!id || id !== workspaceId) throw Error('INVALID_WORKSPACE');
    const lock = acquireLock(id, 0);
    let released = false;
    const release = () => { if (!released) { released = true; lock.release(); } };
    const version = (file, limit) => {
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size > limit) throw Error('INPUT_QUEUE_RETENTION_LIMIT');
        return inputVersion(file).token;
      }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    try {
      const queue = queueFile(id), cursor = cursorFile(id);
      const revisions = () => [version(queue, 32 * 1024 * 1024), version(cursor, 2 * 1024 * 1024)];
      const before = revisions();
      const inputs = readInputs(id, 'retention'), state = checkedCursor(id);
      const positions = new Map(inputs.map((input, index) => [input.inputId, index]));
      const delivered = positions.get(state.inputId) ?? -1, executed = positions.get(state.executedInputId) ?? -1;
      if (state.inputId !== undefined && delivered < 0 || state.executedInputId !== undefined && executed < 0 || executed > delivered
        || (state.completedInputIds ?? []).some(inputId => !positions.has(inputId) || positions.get(inputId) > delivered))
        throw Error('CORRUPT_INPUT_CURSOR');
      const selections = [];
      for (const input of inputs) for (const row of input.resourceFeedback ?? []) {
        if (row.resource.kind === 'interactive') {
          selections.push({ reference: row.resource.reference, followupId: row.version.followupId });
          if (selections.length > 16_384) throw Error('INPUT_QUEUE_RETENTION_LIMIT');
        }
      }
      const assertCurrent = () => {
        try { return !released && lock.current() && revisions().every((revision, index) => revision === before[index]); }
        catch { return false; }
      };
      if (!assertCurrent()) throw Error('INPUT_QUEUE_CHANGED');
      const revision = `sha256:${createHash('sha256').update(JSON.stringify(before)).digest('hex')}`;
      return { revision, selections, assertCurrent, release };
    } catch (error) { release(); throw error; }
  }
  return { submitInput, consume, pendingExecution, completeExecution, cursor: readCursor, diagnosticSnapshot, acquireRetentionInputs,
    findSubmission: (workspaceId, inputId) => readInputs(workspaceId).find(row => row.inputId === inputId) || null,
    findAnswer: (workspaceId, answerTo) => readInputs(workspaceId).find(row => row.answerTo === answerTo) || null,
  };
}

function normalizeSubmission(input, workspaceId, createdAt) {
  const inputId = typeof input?.inputId === 'string' ? input.inputId.trim() : '';
  if (!INPUT_ID.test(inputId)) throw new TypeError('inputId is invalid');
  if (!SURFACES.has(input?.surface)) throw new TypeError('surface is invalid');
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  const uploaded = normalizeInputAttachments(input?.attachments);
  const resourceFeedback = restoreResourceFeedbackTransport(input?.resourceFeedback, uploaded);
  encodeResourceFeedbackTransport(resourceFeedback, uploaded);
  const attachments = uploaded.filter(item => !isInteractiveFeedbackAttachment(item));
  if (!resourceFeedback || resourceFeedback.some(row => row.recipient.workspaceId !== workspaceId)) throw Object.assign(new TypeError('INVALID_RESOURCE_FEEDBACK'), { code: 'INVALID_RESOURCE_FEEDBACK' });
  if (!text && attachments.length === 0 && !resourceFeedback.some(row => row.resource.kind === 'interactive')) throw new TypeError('text or attachments are required');
  if (text.length > 100_000) throw new TypeError('text is too long');
  const suppliedAt = Date.parse(input?.createdAt);
  const normalized = {
    inputId,
    workspaceId,
    surface: input.surface,
    text,
    anchorRefs: stringRefs(input?.anchorRefs),
    quoteRefs: stringRefs(input?.quoteRefs),
    attachmentRefs: stringRefs(input?.attachmentRefs),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(resourceFeedback.length > 0 ? { resourceFeedback } : {}),
    createdAt: Number.isFinite(suppliedAt) ? new Date(suppliedAt).toISOString() : createdAt,
  };
  const answerTo = optionalAnswer(input?.answerTo);
  if (answerTo) normalized.answerTo = answerTo;
  const historyRef = optionalToken(input?.historyRef);
  const historySnapshotId = optionalToken(input?.historySnapshotId);
  if (historyRef) normalized.historyRef = historyRef;
  if (historySnapshotId) normalized.historySnapshotId = historySnapshotId;
  if (input?.historyConfirmed === true) normalized.historyConfirmed = true;
  return normalized;
}

function normalizeStored(value, workspaceId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!WORKSPACE_DIR.test(workspaceId)) return null;
  try {
    return normalizeSubmission(value, workspaceId, value.createdAt || new Date().toISOString());
  } catch (error) {
    if (value.resourceFeedback?.some?.(row => row?.resource?.kind === 'interactive') || value.attachments?.some?.(isInteractiveFeedbackAttachment)) {
      throw Object.assign(Error('INTERACTIVE_INPUT_UNAVAILABLE'), { code: 'INTERACTIVE_INPUT_UNAVAILABLE', cause: error });
    }
    return null;
  }
}

function optionalAnswer(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500 || /[\r\n]/.test(trimmed)) return '';
  return trimmed;
}

function optionalToken(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || /[\r\n]/.test(trimmed)) return '';
  return trimmed;
}

const THUMBNAIL_LIMIT = 512 * 1024;

export function boundedImageAttachments(value) {
  if (!Array.isArray(value)) return [];
  const images = [];
  for (const item of value) {
    if (!item || item.kind !== 'image') continue;
    const dataUrl = typeof item.dataUrl === 'string'
      && item.dataUrl.startsWith('data:image/')
      && item.dataUrl.length <= THUMBNAIL_LIMIT
      ? item.dataUrl
      : '';
    const artifactRef = typeof item.artifactRef === 'string' ? item.artifactRef.trim().slice(0, 500) : '';
    const filePath = typeof item.filePath === 'string' ? item.filePath.trim().slice(0, 500) : '';
    if (!dataUrl && !artifactRef) continue;
    images.push({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 80) : `att-${images.length + 1}`,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 120) : 'image',
      mimeType: typeof item.mimeType === 'string' && item.mimeType.trim() ? item.mimeType.trim().slice(0, 80) : 'image/png',
      kind: 'image',
      ...(dataUrl ? { dataUrl } : {}),
      ...(artifactRef ? { artifactRef } : {}),
      ...(filePath ? { filePath } : {}),
    });
    if (images.length >= 4) break;
  }
  return images;
}

/** Preserve legacy screenshot refs while strictly admitting explicit uploads. */
export function normalizeInputAttachments(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('attachments must be an array');
  if (!value.some(item => item?.sourceKind === 'user_upload')) return boundedImageAttachments(value);
  if (value.length > INPUT_ATTACHMENT_LIMIT) throw new TypeError('at most 8 attachments are allowed');
  return value.flatMap(item => item?.sourceKind === 'user_upload'
    ? [normalizeUserUpload(item)] : boundedImageAttachments([item]));
}

function stringRefs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
    .slice(0, 32);
}
