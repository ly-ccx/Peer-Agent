import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJsonlByteWindow } from './jsonl-byte-window.mjs';

test('a line larger than the read chunk stays intact and older pages still walk back', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jsonl-window-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const content = `字${'测'.repeat(20_000)}`;
  const rows = [
    { id: 'old', role: 'user', content: 'before' },
    { id: 'huge', role: 'assistant', content },
    { id: 'new', role: 'user', content: 'after' },
  ];
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const page = readJsonlByteWindow(file, { limit: 2, chunkBytes: 64 });
  assert.deepEqual(page.messages.map((row) => row.id), ['huge', 'new']);
  assert.equal(page.messages[0].content, content);
  assert.equal(page.hasMore, true);

  const older = readJsonlByteWindow(file, { limit: 2, beforeByte: Number(page.cursor), chunkBytes: 64 });
  assert.deepEqual(older.messages.map((row) => row.id), ['old']);
  assert.equal(older.hasMore, false);
  assert.equal(older.cursor, null);
});

test('blank lines do not consume the window and a missing trailing newline still counts', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jsonl-window-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const rows = [0, 1, 2, 3].map((index) => JSON.stringify({ id: `m-${index}`, role: 'user', content: `line ${index}` }));
  writeFileSync(file, `${rows[0]}\n\n${rows[1]}\n${rows[2]}\n${rows[3]}`);
  const page = readJsonlByteWindow(file, { limit: 2, chunkBytes: 5 });
  assert.deepEqual(page.messages.map((row) => row.id), ['m-2', 'm-3']);
  assert.equal(page.messages.at(-1).content, 'line 3');
  assert.equal(page.hasMore, true);
});
