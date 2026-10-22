import { readSync } from 'node:fs';

/** Byte offsets refer to complete records, including their newline, never UTF-16 positions. */
export function* journalLines(fd, { start = 0, end, onRead = () => {}, maxLineBytes = 64 * 1024 * 1024 } = {}) {
  const chunk = Buffer.alloc(64 * 1024);
  let offset = start, pending = Buffer.alloc(0), lineStart = start;
  while (offset < end) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, end - offset), offset);
    if (!count) throw new Error('coordination_read_changed');
    onRead({ bytes: count, offset }); offset += count;
    const body = pending.length ? Buffer.concat([pending, chunk.subarray(0, count)]) : chunk.subarray(0, count);
    let from = 0, at;
    while ((at = body.indexOf(10, from)) >= 0) {
      if (at - from > maxLineBytes) throw new Error('coordination_record_too_large');
      const next = lineStart + at - from + 1;
      yield { text: body.subarray(from, at).toString('utf8'), start: lineStart, end: next, terminated: true };
      lineStart = next; from = at + 1;
    }
    pending = Buffer.from(body.subarray(from));
    if (pending.length > maxLineBytes) throw new Error('coordination_record_too_large');
  }
  if (pending.length) yield { text: pending.toString('utf8'), start: lineStart, end, terminated: false };
}
