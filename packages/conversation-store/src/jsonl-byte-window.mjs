import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

const DEFAULT_CHUNK_BYTES = 64 * 1024;

/**
 * Read a chronological JSONL window ending at `beforeByte` (exclusive), or at
 * EOF when `beforeByte` is null. Only the bytes that hold the requested tail
 * are parsed. `cursor` is the byte offset of the oldest returned record.
 */
export function readJsonlByteWindow(filePath, {
  limit = 80,
  beforeByte = null,
  chunkBytes = DEFAULT_CHUNK_BYTES,
} = {}) {
  const empty = { messages: [], cursor: null, hasMore: false };
  if (!existsSync(filePath) || !Number.isInteger(limit) || limit <= 0) return empty;
  let fd;
  try {
    fd = openSync(filePath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return empty;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    let end = size;
    if (beforeByte != null) {
      if (!Number.isInteger(beforeByte) || beforeByte <= 0) return empty;
      end = Math.min(beforeByte, size);
    }
    if (end <= 0) return empty;
    const found = [];
    let position = end;
    let carry = Buffer.alloc(0);
    while (found.length < limit && position > 0) {
      const readSize = Math.min(chunkBytes, position);
      const start = position - readSize;
      const buf = Buffer.allocUnsafe(readSize);
      const read = readSync(fd, buf, 0, readSize, start);
      const chunk = read === readSize ? buf : buf.subarray(0, read);
      const combined = Buffer.concat([chunk, carry]);
      const incomplete = start > 0;
      const consumed = collectNewestLines(combined, start, incomplete, limit - found.length);
      found.push(...consumed.lines);
      carry = consumed.carry;
      position = start;
      if (consumed.filled) break;
    }
    const chronological = found.reverse();
    const messages = [];
    for (const row of chronological) {
      const text = row.bytes.toString('utf8').trim();
      if (!text) continue;
      try {
        messages.push(JSON.parse(text));
      } catch {
        // Skip a corrupt line. The cursor still moves past it.
      }
    }
    const oldest = chronological[0];
    const hasMore = Boolean(oldest && oldest.byteStart > 0);
    return {
      messages,
      cursor: hasMore ? String(oldest.byteStart) : null,
      hasMore,
    };
  } finally {
    closeSync(fd);
  }
}

function collectNewestLines(combined, base, incomplete, remaining) {
  const lines = [];
  let end = combined.length;
  while (lines.length < remaining) {
    let newline = -1;
    for (let index = end - 1; index >= 0; index -= 1) {
      if (combined[index] === 0x0a) {
        newline = index;
        break;
      }
    }
    if (newline === -1) {
      if (!incomplete && end > 0) {
        lines.push({ byteStart: base, bytes: Buffer.from(combined.subarray(0, end)) });
      }
      return {
        lines,
        carry: incomplete ? Buffer.from(combined.subarray(0, end)) : Buffer.alloc(0),
        filled: lines.length >= remaining,
      };
    }
    const lineStart = newline + 1;
    const bytes = combined.subarray(lineStart, end);
    if (bytes.length > 0) {
      lines.push({ byteStart: base + lineStart, bytes: Buffer.from(bytes) });
    }
    end = newline;
    if (incomplete && !hasNewlineBefore(combined, end)) {
      return {
        lines,
        carry: Buffer.from(combined.subarray(0, end)),
        filled: lines.length >= remaining,
      };
    }
  }
  return { lines, carry: Buffer.alloc(0), filled: true };
}

function hasNewlineBefore(buffer, end) {
  for (let index = end - 1; index >= 0; index -= 1) {
    if (buffer[index] === 0x0a) return true;
  }
  return false;
}
