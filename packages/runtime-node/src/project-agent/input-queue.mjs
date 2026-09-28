/**
 * 项目输入队列。所有入口把用户输入追加到 input-queue.jsonl。
 * 只有宿主按游标消费：写入机器人对话（消息 id 由 inputId 派生），再推进游标，然后通知唤醒。
 * 同一 inputId 再提交返回第一次的结果。对话已写入但游标未推进时，重放不产生第二条消息。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';

const WORKSPACE_DIR = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const INPUT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SURFACES = new Set(['desktop', 'quick_chat', 'tui', 'remote']);
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
} = {}) {
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

  function withLock(workspaceId, fn) {
    const lockDir = `${queueFile(workspaceId)}.lock`;
    mkdirSync(path.dirname(lockDir), { recursive: true });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        mkdirSync(lockDir);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
            rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          // 锁刚被释放。
        }
        if (Date.now() >= deadline) throw error;
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }

  function readInputs(workspaceId) {
    const file = queueFile(workspaceId);
    if (!existsSync(file)) return [];
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const inputs = [];
    const seen = new Set();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const input = normalizeStored(JSON.parse(line), workspaceId);
        if (!input || seen.has(input.inputId)) continue;
        seen.add(input.inputId);
        inputs.push(input);
      } catch {
        // 坏行跳过，不挡住后面的输入。
      }
    }
    return inputs;
  }

  function readCursor(workspaceId) {
    const file = cursorFile(workspaceId);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const inputId = typeof parsed?.inputId === 'string' ? parsed.inputId.trim() : '';
      return inputId || null;
    } catch {
      return null;
    }
  }

  function writeCursor(workspaceId, inputId) {
    const file = cursorFile(workspaceId);
    const tmp = `${file}.${process.pid}.tmp`;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ inputId, consumedAt: stamp() })}\n`);
    renameSync(tmp, file);
  }

  function submitInput(input) {
    const workspaceId = workspaceIdOf(input?.workspaceId);
    if (!workspaceId) throw new TypeError('workspaceId is invalid');
    const normalized = normalizeSubmission(input, workspaceId, stamp());
    return withLock(workspaceId, () => {
      const existing = readInputs(workspaceId).find((item) => item.inputId === normalized.inputId);
      if (existing) return existing;
      mkdirSync(dirFor(workspaceId), { recursive: true });
      appendFileSync(queueFile(workspaceId), `${JSON.stringify(normalized)}\n`);
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
    const outcome = withLock(dirName, () => {
      const conversationId = resolveConversationId(dirName);
      if (typeof conversationId !== 'string' || !conversationId.trim()) {
        return { consumed: [], skipped: 'no-conversation' };
      }
      const targetId = conversationId.trim();
      const consumed = [];
      for (const input of pendingAfter(dirName)) {
        const messageId = inputMessageId(input.inputId);
        const duplicateMessage = hasMessage(targetId, messageId) === true;
        if (!duplicateMessage) {
          appendMessage(targetId, {
            id: messageId,
            role: 'user',
            content: input.text,
            createdAt: input.createdAt,
            inputId: input.inputId,
            surface: input.surface,
            anchorRefs: input.anchorRefs,
            quoteRefs: input.quoteRefs,
            attachmentRefs: input.attachmentRefs,
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

  return { submitInput, consume, cursor: readCursor };
}

function normalizeSubmission(input, workspaceId, createdAt) {
  const inputId = typeof input?.inputId === 'string' ? input.inputId.trim() : '';
  if (!INPUT_ID.test(inputId)) throw new TypeError('inputId is invalid');
  if (!SURFACES.has(input?.surface)) throw new TypeError('surface is invalid');
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  if (!text) throw new TypeError('text is required');
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
  } catch {
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

function stringRefs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
    .slice(0, 32);
}
