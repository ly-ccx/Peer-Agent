import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';

function world() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-journal-reader-'));
  const options = { rootDir, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner' };
  const writer = createWorkCoordinationStore(options);
  for (let i = 0; i < 40; i++) writer.saveWork({ workId: 'x', state: 'runnable', text: '中'.repeat(4000) });
  let bytes = 0;
  const reader = createWorkCoordinationStore({ ...options, onJournalRead: row => { bytes += row.bytes; } });
  const file = path.join(rootDir, 'w', 'coordination.jsonl');
  return { rootDir, file, writer, reader, options, bytes: () => bytes, clear: () => { bytes = 0; },
    close: () => rmSync(rootDir, { recursive: true, force: true }) };
}
test('unchanged reads do no body I/O; external append reads only a validated tail and isolates callers', () => {
  const w = world();
  try {
    const first = w.reader.read(); w.clear(); first.works.x.text = 'mutated';
    assert.notEqual(w.reader.read().works.x.text, 'mutated'); assert.equal(w.bytes(), 0);
    w.writer.saveWork({ workId: 'next', text: '尾部😀' }); w.clear();
    const next = w.reader.read();
    assert.equal(next.works.next.text, '尾部😀'); assert.ok(w.bytes() < 2000, `read ${w.bytes()} bytes for a small append`);
    assert.deepEqual(next, createWorkCoordinationStore(w.options).read());
    const saved = w.writer.saveWork({ workId: 'last', text: 'original' }); saved.works.last.text = 'mutated';
    assert.equal(w.writer.read().works.last.text, 'original');
  } finally { w.close(); }
});
test('partial and invalid records never publish stale success or advance the replay offset', () => {
  const w = world();
  try {
    const state = w.reader.read(); const prefix = readFileSync(w.file);
    const row = JSON.stringify({ kind: 'work', revision: state.revision + 1, work: { workId: 'unicode', text: '中😀' } }) + '\n';
    const bytes = Buffer.from(row), split = bytes.indexOf(Buffer.from('😀')) + 1;
    appendFileSync(w.file, bytes.subarray(0, split)); assert.throws(() => w.reader.read());
    appendFileSync(w.file, bytes.subarray(split)); assert.equal(w.reader.read().works.unicode.text, '中😀');
    appendFileSync(w.file, JSON.stringify({ kind: 'work', revision: 9999, work: {} }) + '\n');
    assert.throws(() => w.reader.read(), /revision_gap/);
    writeFileSync(w.file, prefix); assert.deepEqual(w.reader.read(), state);
  } finally { w.close(); }
});
test('same-length rewrites, file replacement and truncation invalidate retained projections', () => {
  const w = world();
  try {
    const state = w.reader.read(), original = readFileSync(w.file, 'utf8');
    writeFileSync(w.file, original.replace('runnable', 'canceled'));
    assert.equal(w.reader.read().revision, state.revision);
    const fresh = createWorkCoordinationStore(w.options).read(); assert.deepEqual(w.reader.read(), fresh);
    writeFileSync(w.file + '.replacement', ''); renameSync(w.file + '.replacement', w.file);
    assert.equal(w.reader.read().revision, 0);
    writeFileSync(w.file, '{"kind":"work","revision":1,"schemaVersion":2,"work":{}}\n');
    assert.throws(() => w.reader.read(), /schema_unsupported/);
  } finally { w.close(); }
});

test('single-work reads validate the same journal without cloning or exposing unrelated work', () => {
  const w = world();
  try {
    const work = w.reader.readWork('x');
    assert.equal(work.text, '中'.repeat(4000));
    work.text = 'caller mutation'; w.clear();
    assert.notEqual(w.reader.readWork('x').text, 'caller mutation'); assert.equal(w.bytes(), 0);
    assert.equal(w.reader.readWork('absent'), undefined);
    assert.equal(w.reader.readWork('__proto__'), undefined);
    w.writer.saveWork({ workId: 'x', text: 'external append' });
    assert.equal(w.reader.readWork('x').text, 'external append');
    appendFileSync(w.file, '{broken\n');
    assert.throws(() => w.reader.readWork('x'), SyntaxError, 'a cached work cannot hide journal corruption');
    writeFileSync(w.file, ''); assert.equal(w.reader.readWork('x'), undefined);
  } finally { w.close(); }
});
