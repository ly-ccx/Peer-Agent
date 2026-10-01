import { gunzipSync, gzipSync } from 'node:zlib';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';

/**
 * 项目收件箱。追加写，重复 eventId 丢弃。
 * 游标只在唤醒回合成功结束后推进；失败回合下次仍读到同一批。
 * 同一项目一个合并窗口内的事件作为一批交给唤醒。
 * 文件超过上限时，把已消费且早于保留期的事件压进 inbox-<日期>.jsonl.gz。
 */

const WORKSPACE_DIR = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UNSCOPED_DIR = '_unscoped';
const DEFAULT_MERGE_WINDOW_MS = 2_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function createProjectInbox({
  rootDir = null,
  now = () => new Date().toISOString(),
  mergeWindowMs = DEFAULT_MERGE_WINDOW_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  archiveAfterMs = DEFAULT_ARCHIVE_AFTER_MS,
} = {}) {
  const windowMs = Number.isFinite(mergeWindowMs) && mergeWindowMs >= 0
    ? mergeWindowMs
    : DEFAULT_MERGE_WINDOW_MS;
  const byteLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const retainMs = Number.isFinite(archiveAfterMs) && archiveAfterMs >= 0
    ? archiveAfterMs
    : DEFAULT_ARCHIVE_AFTER_MS;

  function root() {
    return rootDir || pathOf('projectRuntime');
  }

  function dirFor(workspaceId) {
    return path.join(root(), workspaceDir(workspaceId));
  }

  function inboxFile(workspaceId) {
    return path.join(dirFor(workspaceId), 'inbox.jsonl');
  }

  function cursorFile(workspaceId) {
    return path.join(dirFor(workspaceId), 'inbox-cursor.json');
  }

  function readEvents(workspaceId) {
    const file = inboxFile(workspaceId);
    if (!existsSync(file)) return [];
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && typeof event.eventId === 'string' && Number.isInteger(event.seq) && event.seq > 0) {
          events.push(event);
        }
      } catch {
        // 坏行跳过，不挡住其余事件。
      }
    }
    events.sort((a, b) => a.seq - b.seq);
    return events;
  }

  function knownIds(workspaceId) {
    const ids = new Set(readEvents(workspaceId).map((event) => event.eventId));
    let names = [];
    try {
      names = readdirSync(dirFor(workspaceId));
    } catch {
      return ids;
    }
    for (const name of names) {
      if (!name.startsWith('inbox-') || !name.endsWith('.jsonl.gz')) continue;
      try {
        const text = gunzipSync(readFileSync(path.join(dirFor(workspaceId), name))).toString('utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (typeof event?.eventId === 'string') ids.add(event.eventId);
          } catch {
            // 归档里的坏行不影响去重其余事件。
          }
        }
      } catch {
        // 读不到的归档不参与这次去重。
      }
    }
    return ids;
  }

  function readCursor(workspaceId) {
    const file = cursorFile(workspaceId);
    if (!existsSync(file)) return { seq: 0 };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const seq = Number.isInteger(parsed?.seq) && parsed.seq > 0 ? parsed.seq : 0;
      return { seq };
    } catch {
      return { seq: 0 };
    }
  }

  function writeCursor(workspaceId, seq) {
    const file = cursorFile(workspaceId);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ seq, updatedAt: iso(now) }), 'utf8');
    renameSync(tmp, file);
    return { seq };
  }

  function archiveConsumed(workspaceId) {
    const file = inboxFile(workspaceId);
    if (!existsSync(file)) return { archived: 0 };
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return { archived: 0 };
    }
    if (size <= byteLimit) return { archived: 0 };
    const cursor = readCursor(workspaceId).seq;
    const cutoff = Date.parse(iso(now)) - retainMs;
    const events = readEvents(workspaceId);
    const keep = [];
    const drop = [];
    for (const event of events) {
      const at = Date.parse(event.at || '');
      if (event.seq <= cursor && Number.isFinite(at) && at < cutoff) drop.push(event);
      else keep.push(event);
    }
    if (drop.length === 0) return { archived: 0 };
    const groups = new Map();
    for (const event of drop) {
      const day = typeof event.at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(event.at)
        ? event.at.slice(0, 10)
        : 'undated';
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(event);
    }
    for (const [day, rows] of groups) {
      const target = archivePath(dirFor(workspaceId), day);
      mkdirSync(path.dirname(target), { recursive: true });
      const body = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
      writeFileSync(target, gzipSync(body));
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, keep.length ? `${keep.map((row) => JSON.stringify(row)).join('\n')}\n` : '', 'utf8');
    renameSync(tmp, file);
    return { archived: drop.length };
  }

  function append(workspaceId, events) {
    const incoming = Array.isArray(events) ? events : [];
    const seen = knownIds(workspaceId);
    const existing = readEvents(workspaceId);
    let seq = existing.reduce((max, event) => Math.max(max, event.seq), 0);
    const appended = [];
    const duplicates = [];
    const lines = [];
    for (const event of incoming) {
      if (!event || typeof event.eventId !== 'string' || !event.eventId) continue;
      if (seen.has(event.eventId)) {
        duplicates.push(event.eventId);
        continue;
      }
      seen.add(event.eventId);
      seq += 1;
      const stored = {
        ...event,
        workspaceId: event.workspaceId || workspaceId,
        seq,
        at: typeof event.at === 'string' && event.at.trim() ? event.at : iso(now),
      };
      appended.push(stored);
      lines.push(JSON.stringify(stored));
    }
    if (lines.length > 0) {
      const file = inboxFile(workspaceId);
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    }
    const archived = archiveConsumed(workspaceId);
    return { appended, duplicates, archived: archived.archived };
  }

  function takeBatch(workspaceId) {
    const cursor = readCursor(workspaceId).seq;
    const pending = readEvents(workspaceId).filter((event) => event.seq > cursor);
    if (pending.length === 0) return { events: [], throughSeq: cursor };
    const start = Date.parse(pending[0].at || '');
    const events = [];
    for (const event of pending) {
      const at = Date.parse(event.at || '');
      if (events.length > 0 && Number.isFinite(start) && Number.isFinite(at) && at - start > windowMs) break;
      events.push(event);
    }
    return { events, throughSeq: events.at(-1)?.seq ?? cursor };
  }

  function commitBatch(workspaceId, { throughSeq, ok } = {}) {
    const current = readCursor(workspaceId);
    if (ok !== true) return { seq: current.seq, advanced: false };
    const next = Number.isInteger(throughSeq) && throughSeq > current.seq ? throughSeq : current.seq;
    if (next === current.seq) return { seq: current.seq, advanced: false };
    writeCursor(workspaceId, next);
    return { seq: next, advanced: true };
  }

  return {
    append,
    takeBatch,
    commitBatch,
    cursor: readCursor,
    diagnosticSnapshot(workspaceId) {
      if (typeof workspaceId !== 'string' || !WORKSPACE_DIR.test(workspaceId)) throw new Error('INVALID_WORKSPACE');
      let cursor = 0;
      try {
        const raw = JSON.parse(readFileSync(cursorFile(workspaceId), 'utf8'));
        if (!Number.isSafeInteger(raw?.seq) || raw.seq < 0) throw new Error('CORRUPT_INBOX_CURSOR');
        cursor = raw.seq;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const events = [];
      const add = text => { for (const line of text.split('\n')) if (line.trim()) {
        const row = JSON.parse(line);
        if (typeof row?.eventId !== 'string' || !Number.isSafeInteger(row.seq) || row.seq < 1) throw new Error('CORRUPT_INBOX');
        events.push(row);
      } };
      try { add(readFileSync(inboxFile(workspaceId), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (events.length < 200) {
        let archives = [];
        try { archives = readdirSync(dirFor(workspaceId)).filter(name => /^inbox-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl\.gz$/.test(name))
          .sort((a, b) => b.slice(6, 16).localeCompare(a.slice(6, 16))
            || Number(b.match(/^inbox-\d{4}-\d{2}-\d{2}-(\d+)\.jsonl/)?.[1] ?? 0) - Number(a.match(/^inbox-\d{4}-\d{2}-\d{2}-(\d+)\.jsonl/)?.[1] ?? 0)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        for (const name of archives) {
          add(gunzipSync(readFileSync(path.join(dirFor(workspaceId), name))).toString('utf8'));
          if (events.length >= 200) break;
        }
      }
      return { cursor, events: events.sort((a,b) => a.seq - b.seq).slice(-200) };
    },
  };
}

function workspaceDir(workspaceId) {
  return typeof workspaceId === 'string' && WORKSPACE_DIR.test(workspaceId) ? workspaceId : UNSCOPED_DIR;
}

function archivePath(dir, day) {
  const first = path.join(dir, `inbox-${day}.jsonl.gz`);
  if (!existsSync(first)) return first;
  let index = 2;
  while (existsSync(path.join(dir, `inbox-${day}-${index}.jsonl.gz`))) index += 1;
  return path.join(dir, `inbox-${day}-${index}.jsonl.gz`);
}

function iso(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value.trim();
  return new Date().toISOString();
}
