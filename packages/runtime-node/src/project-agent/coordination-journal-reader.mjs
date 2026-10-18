import { openSync, closeSync, fstatSync, readSync, statSync } from 'node:fs';
import { reduceCoordination } from './work-coordination.mjs';

const empty = () => ({ revision: 0, events: {}, works: {}, deliveries: {} });
const version = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const identity = info => `${info.dev}:${info.ino}:${info.birthtimeNs}`;
const ANCHOR = 192;

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
      const body = bytes(fd, append ? offset : 0, size - (append ? offset : 0)).toString('utf8');
      let state = append ? cached : empty();
      for (const line of body.split('\n')) if (line) state = reduceCoordination(state, JSON.parse(line));
      const nextAnchors = boundaries(fd, size);
      if (version(fstatSync(fd, { bigint: true })) !== version(opened)
        || version(statSync(file, { bigint: true })) !== version(opened)) throw new Error('coordination_read_changed');
      cached = state; previous = opened; anchors = nextAnchors;
      return cached;
    } catch (error) {
      if (error.code === 'ENOENT') { clear(); return empty(); }
      // Keep the validated prefix privately for retry, never return it as current facts on error.
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  function committed(state) {
    const fd = openSync(file, 'r');
    try {
      const info = fstatSync(fd, { bigint: true });
      const nextAnchors = boundaries(fd, Number(info.size));
      cached = structuredClone(state); previous = info; anchors = nextAnchors;
    } finally { closeSync(fd); }
  }
  return { read: () => structuredClone(readState()),
    readWork(id) { const works = readState().works; return Object.hasOwn(works, id) ? structuredClone(works[id]) : undefined; },
    committed, clear };
}
