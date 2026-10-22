import { openSync, closeSync, fstatSync, readSync, statSync } from 'node:fs';
import { reduceCoordination } from './work-coordination.mjs';
import { journalLines } from './journal-lines.mjs';

const empty = () => ({ revision: 0, events: {}, works: {}, deliveries: {} });
const version = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const identity = info => `${info.dev}:${info.ino}:${info.birthtimeNs}`;
const ANCHOR = 192;

function immutable(value) {
  const pending = [value];
  while (pending.length) {
    const row = pending.pop();
    if (!row || typeof row !== 'object' || Object.isFrozen(row)) continue;
    Object.freeze(row);
    for (const child of Object.values(row)) pending.push(child);
  }
  return value;
}

/** Append-only journal projection. Cache publication follows complete reducer validation. */
export function createCoordinationJournalReader({ file, onRead = () => {} }) {
  let cached = null, previous = null, anchors = null;
  function bytes(fd, start, length) {
    const buffer = Buffer.alloc(length); let count = 0;
    while (count < length) {
      const received = readSync(fd, buffer, count, length - count, start + count);
      if (!received) throw new Error('coordination_read_changed');
      count += received;
    }
    if (length) onRead({ bytes: length, offset: start });
    return buffer;
  }
  function boundaries(fd, size) {
    return [bytes(fd, 0, Math.min(ANCHOR, size)), bytes(fd, Math.max(0, size - ANCHOR), Math.min(ANCHOR, size))];
  }
  function clear() { cached = null; previous = null; anchors = null; }
  function readState() {
    let fd;
    try {
      const info = statSync(file, { bigint: true });
      if (cached && version(info) === version(previous)) return cached;
      fd = openSync(file, 'r');
      const opened = fstatSync(fd, { bigint: true });
      const size = Number(opened.size), offset = previous ? Number(previous.size) : 0;
      let append = cached && identity(opened) === identity(previous) && size > offset;
      if (append) {
        const prefix = boundaries(fd, offset);
        append = prefix.every((buffer, index) => buffer.equals(anchors[index]));
        // A valid unterminated last record may be recovered by appending its separator.
        if (append && offset && bytes(fd, offset - 1, 1)[0] !== 10 && bytes(fd, offset, 1)[0] !== 10) append = false;
      }
      let state = append ? cached : empty();
      for (const line of journalLines(fd, { start: append ? offset : 0, end: size, onRead })) {
        if (line.text) state = reduceCoordination(state, JSON.parse(line.text));
      }
      const nextAnchors = boundaries(fd, size);
      if (version(fstatSync(fd, { bigint: true })) !== version(opened)
        || version(statSync(file, { bigint: true })) !== version(opened)) throw new Error('coordination_read_changed');
      cached = immutable(state); previous = opened; anchors = nextAnchors;
      return cached;
    } catch (error) {
      if (error.code === 'ENOENT') { clear(); return empty(); }
      // Keep the validated prefix privately for retry, never return it as current facts on error.
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  function publish(state) {
    const fd = openSync(file, 'r');
    try {
      const info = fstatSync(fd, { bigint: true });
      const nextAnchors = boundaries(fd, Number(info.size));
      cached = immutable(state); previous = info; anchors = nextAnchors;
    } finally { closeSync(fd); }
  }
  return { read: () => structuredClone(readState()),
    // Complete immutable facts. Each call revalidates the file; observations
    // held across a write or await are not a new check of current state.
    readSnapshot: () => immutable(readState()),
    commitEntry(entry, persist, { returnState = true } = {}) {
      const state = readState();
      const record = { ...(typeof entry === 'function' ? entry() : entry), revision: state.revision + 1 };
      const next = reduceCoordination(state, record);
      persist(record);
      // The reducer owns new entry values; neither it nor this state escapes
      // through the persistence callback. Publish only after durable success.
      publish(next);
      return returnState ? structuredClone(next) : undefined;
    },
    readWork(id) { const works = readState().works; return Object.hasOwn(works, id) ? structuredClone(works[id]) : undefined; },
    readLifecycleFacts() {
      const state = readState();
      return structuredClone({ revision: state.revision, mandates: state.mandates || {},
        transitions: state.transitions || {}, decisions: state.decisions || {},
        workStates: Object.fromEntries(Object.entries(state.works).map(([id, work]) => [id, { state: work.state, stopScope: work.stopScope }])) });
    },
    committed: state => publish(structuredClone(state)), clear };
}
