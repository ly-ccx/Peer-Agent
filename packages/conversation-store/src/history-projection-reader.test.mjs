import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync, readFileSync, statSync, utimesSync, renameSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConversationStore } from './index.mjs';
import { createHistoryProjectionReader } from './history-projection-reader.mjs';

test('compact projection reads unchanged history once, returns isolated facts and sees file/sidecar changes', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-history-view-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: dir }), meta = store.createConversation({ title: 'facts' });
  store.appendMessage(meta.id, { id: 'old', role: 'assistant', content: 'old' });
  store.appendMessage(meta.id, { id: 'new', role: 'assistant', content: 'new' });
  const file = path.join(dir, meta.id + '.jsonl');
  let historyReads = 0;
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args) => { if (args[0] === file) historyReads++; return original(...args); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const view = store.createHistoryProjection(history => ({ last: history.messages.at(-1), createdAt: history.createdAt }));
  const first = view(meta.id); first.last.content = 'forged';
  assert.equal(view(meta.id).last.content, 'new'); assert.equal(view(meta.id).createdAt, meta.createdAt);
  assert.equal(historyReads, 1);
  store.patchStreamingMessage(meta.id, 'new', { content: 'partial' });
  assert.equal(view(meta.id).last.id, 'old', 'provisional tail never becomes a report');
  store.clearStreamPatch(meta.id); assert.equal(view(meta.id).last.id, 'new');
  const info = statSync(file); writeFileSync(file, readFileSync(file, 'utf8').replaceAll('new', 'alt')); utimesSync(file, info.atime, info.mtime);
  assert.equal(view(meta.id).last.content, 'alt');
  const replacement = path.join(dir, 'replacement'); writeFileSync(replacement, readFileSync(file, 'utf8').replaceAll('alt', 'end')); renameSync(replacement, file);
  assert.equal(view(meta.id).last.content, 'end');
  writeFileSync(file, '{broken'); assert.throws(() => view(meta.id), { code: 'BACKGROUND_HISTORY_CORRUPT' });
  rmSync(file); assert.throws(() => view(meta.id), { code: 'BACKGROUND_HISTORY_MISSING' });
});

test('projection caches are bounded and reject changes during a read, including failed rebuilds', () => {
  let revision = 0, loads = 0, fail = false, change = false;
  const read = createHistoryProjectionReader({ maxEntries: 1, maxBytes: 64,
    describe: id => ({ version: revision, id }),
    load: () => { loads++; if (fail) throw Error('corrupt'); if (change) revision++; return { value: 'fact' }; },
    project: row => ({ value: row.value }),
  });
  assert.deepEqual(read('a'), { value: 'fact' }); read('b'); read('a'); assert.equal(loads, 3);
  revision++; fail = true; assert.throws(() => read('a'), /corrupt/);
  fail = false; change = true; assert.throws(() => read('a'), { code: 'BACKGROUND_VERSION_CHANGED' });
  change = false; assert.deepEqual(read('a'), { value: 'fact' }); assert.equal(loads, 6);
});
