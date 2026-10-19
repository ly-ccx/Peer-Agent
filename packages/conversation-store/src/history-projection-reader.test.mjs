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
  change = false; assert.deepEqual(read('a'), { value: 'fact' }); assert.equal(loads, 8, 'continuous conflicts stop after three attempts, then a fresh read can succeed');
});


test('metadata-only append preserves durable mutations without rereading historical bodies', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-append-receipt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: dir }), meta = store.createConversation({ title: 'receipt' });
  store.appendMessage(meta.id, { id: 'old', role: 'assistant', content: 'historical body' });
  const file = path.join(dir, meta.id + '.jsonl');
  const original = fs.readFileSync; let reads = 0;
  t.mock.method(fs, 'readFileSync', (...args) => { if (args[0] === file) reads++; return original(...args); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const receipt = store.appendMessage(meta.id, { id: 'new', role: 'user', content: 'new input' }, { returnMessages: false });
  assert.equal(reads, 0); assert.equal(receipt.messages, undefined);
  assert.equal(receipt.messageCount, 2); assert.equal(receipt.contentRevision, 2);
  assert.deepEqual(store.getPersistedConversationHistory(meta.id).messages.map(row => row.id), ['old', 'new']);
  const legacy = store.appendMessage(meta.id, { id: 'next', role: 'assistant', content: 'reply' });
  assert.equal(legacy.messages.length, 3, 'default API remains compatible');
  const empty = store.appendMessage(meta.id, { id: 'empty', role: 'user', content: '' }, { returnMessages: false });
  assert.equal(empty.messageCount, 3); assert.equal(empty.contentRevision, 3);
});

test('a racing external commit is retried from its new version without publishing the discarded value', () => {
  let revision=0, loads=0;
  const read=createHistoryProjectionReader({describe:()=>({version:revision}),load:()=>{
    loads++;const value=revision?'current':'discarded';if(loads===1)revision++;return{value};
  },project:row=>row.value});
  assert.equal(read('a'),'current');assert.equal(loads,2);assert.equal(read('a'),'current');assert.equal(loads,2);
});


test('independent projections share one strict parsed source per version without callback or output pollution', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-shared-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: dir }), meta = store.createConversation({ title: 'shared' });
  store.appendMessage(meta.id, { id: 'one', role: 'assistant', content: 'original', nested: { value: 'original' } });
  const file=path.join(dir,meta.id+'.jsonl'), original=fs.readFileSync;let reads=0;
  t.mock.method(fs,'readFileSync',(...args)=>{if(args[0]===file)reads++;return original(...args)});
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()});
  const a=store.createHistoryProjection(h=>h.messages.at(-1),{immutableInput:true});
  const b=store.createHistoryProjection(h=>h.messages.map(m=>m.content),{immutableInput:true});
  const mutate=store.createHistoryProjection(h=>{h.messages[0].nested.value='mutated';return h.messages[0].nested.value});
  const reject=store.createHistoryProjection(h=>{h.messages[0].nested.value='forged';return h.messages[0]},{immutableInput:true});
  const first=a(meta.id);first.nested.value='caller';assert.deepEqual(b(meta.id),['original']);
  assert.equal(mutate(meta.id),'mutated');assert.throws(()=>reject(meta.id),TypeError);
  assert.equal(a(meta.id).nested.value,'original');assert.equal(reads,1,'all views parse one shared input');
  store.appendMessage(meta.id,{id:'two',role:'assistant',content:'next'},{returnMessages:false});
  const before=reads;assert.equal(a(meta.id).content,'next');assert.deepEqual(b(meta.id),['original','next']);
  assert.equal(reads-before,1,'a new durable version is loaded once across views');
  store.patchStreamingMessage(meta.id,'two',{content:'partial'});
  assert.equal(a(meta.id).content,'original');assert.deepEqual(b(meta.id),['original']);
  store.clearStreamPatch(meta.id);assert.equal(a(meta.id).content,'next');assert.deepEqual(b(meta.id),['original','next']);
  const info=statSync(file);writeFileSync(file,readFileSync(file,'utf8').replaceAll('next','edit'));utimesSync(file,info.atime,info.mtime);
  assert.equal(a(meta.id).content,'edit');assert.deepEqual(b(meta.id),['original','edit']);
  writeFileSync(file+'.new',readFileSync(file,'utf8').replaceAll('edit','swap'));renameSync(file+'.new',file);
  assert.equal(a(meta.id).content,'swap');assert.deepEqual(b(meta.id),['original','swap']);
  writeFileSync(file,'{broken');assert.throws(()=>a(meta.id),{code:'BACKGROUND_HISTORY_CORRUPT'});assert.throws(()=>b(meta.id),{code:'BACKGROUND_HISTORY_CORRUPT'});
  rmSync(file);assert.throws(()=>a(meta.id),{code:'BACKGROUND_HISTORY_MISSING'});assert.throws(()=>b(meta.id),{code:'BACKGROUND_HISTORY_MISSING'});
});
