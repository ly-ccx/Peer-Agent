import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

const DEFAULT_CHUNK_BYTES = 64 * 1024;

/**
 * Read a chronological JSONL window ending at `beforeByte` (exclusive), or at
 * EOF when `beforeByte` is null. Only the bytes that hold the requested tail
 * are parsed. `cursor` is the byte offset of the oldest returned record.
 *
 * Chunks are kept as slices and joined once. A single huge line must not be
 * recopied on every 64KB step — that was quadratic and stalled the main thread
 * while opening or rebuilding a preview for a large transcript.
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

    const pieces = [];
    let position = end;
    let newlines = 0;
    const readOlder = () => {
      if (position <= 0) return false;
      const readSize = Math.min(chunkBytes, position);
      const start = position - readSize;
      const buf = Buffer.allocUnsafe(readSize);
      const read = readSync(fd, buf, 0, readSize, start);
      if (read <= 0) {
        position = start;
        return false;
      }
      const chunk = read === readSize ? buf : buf.subarray(0, read);
      pieces.push(chunk);
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] === 0x0a) newlines += 1;
      }
      position = start;
      return true;
    };

    while (position > 0 && newlines < limit) readOlder();
    let lines = extractNewestLines(joinPieces(pieces), position, limit);
    while (lines.length < limit && position > 0) {
      const beforeNewlines = newlines;
      while (position > 0 && newlines === beforeNewlines) {
        if (!readOlder()) break;
      }
      lines = extractNewestLines(joinPieces(pieces), position, limit);
    }

    const chronological = lines.reverse();
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

function joinPieces(pieces) {
  if (pieces.length === 0) return Buffer.alloc(0);
  if (pieces.length === 1) return pieces[0];
  const ordered = new Array(pieces.length);
  for (let index = 0; index < pieces.length; index += 1) {
    ordered[index] = pieces[pieces.length - 1 - index];
  }
  return Buffer.concat(ordered);
}

/**
 * Newest non-empty lines first. When `base > 0` the bytes before the first
 * newline are the tail of an older line and are not a record.
 * The scan walks each byte once.
 */
function extractNewestLines(buffer, base, limit) {
  const lines = [];
  let end = buffer.length;
  const atFileStart = base === 0;
  while (lines.length < limit && end > 0) {
    let newline = -1;
    for (let index = end - 1; index >= 0; index -= 1) {
      if (buffer[index] === 0x0a) {
        newline = index;
        break;
      }
    }
    if (newline === -1) {
      if (atFileStart) {
        lines.push({ byteStart: base, bytes: Buffer.from(buffer.subarray(0, end)) });
      }
      break;
    }
    const lineStart = newline + 1;
    if (end > lineStart) {
      lines.push({
        byteStart: base + lineStart,
        bytes: Buffer.from(buffer.subarray(lineStart, end)),
      });
    }
    end = newline;
  }
  return lines;
}
