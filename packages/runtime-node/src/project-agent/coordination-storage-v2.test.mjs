import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, readdirSync, appendFileSync, writeFileSync, utimesSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget, createWorkBudgetGuard } from './work-budget.mjs';

function world() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-coordination-v2-'));
  const options = { rootDir, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner' };
  const stores = [];
  return { rootDir, options, store(extra = {}) { const s = createWorkCoordinationStore({ ...options, ...extra }); stores.push(s); return s; },
    close() { stores.forEach(s => s.close()); rmSync(rootDir, { recursive: true, force: true }); } };
}

test('warm metadata reads reject external same-size schema changes, replacement pointers and incomplete fences', async () => {
  const w = world();
  try {
    const store = w.store({ formatVersion: 2, fenceLegacyWrites: true }); await store.prepare();
    const base = path.join(w.rootDir, 'w'), manifestFile = path.join(base, 'coordination-v2/manifest.json');
    const original = readFileSync(manifestFile, 'utf8'), before = statSync(manifestFile);
    assert.equal(store.readSnapshot().revision, 0);
    const future = JSON.parse(original); future.minimumReaderVersion = 9; future.minimumWriterVersion = 9;
    writeFileSync(manifestFile, JSON.stringify(future)); utimesSync(manifestFile, before.atime, before.mtime);
    assert.throws(() => store.readSnapshot(), /coordination_schema_unsupported/);
    assert.throws(() => store.saveWork({ workId: 'forbidden', state: 'runnable' }), /coordination_schema_unsupported/);
    writeFileSync(manifestFile, original); assert.equal(store.readSnapshot().revision, 0);
    const pointer = path.join(base, '.read-models/coordination-current.json'), saved = readFileSync(pointer);
    writeFileSync(pointer + '.replacement', '{}'); renameSync(pointer + '.replacement', pointer);
    assert.throws(() => store.readSnapshot(), /coordination_index_corrupt/);
    writeFileSync(pointer, saved); assert.equal(store.readSnapshot().revision, 0);
    const fence = path.join(base, 'coordination-fence.json'), savedFence = readFileSync(fence);
    writeFileSync(fence, JSON.stringify({ status: 'pending' }));
    assert.throws(() => store.readSnapshot(), /coordination_fence_incomplete/);
    writeFileSync(fence, savedFence); assert.equal(store.readSnapshot().revision, 0);
  } finally { w.close(); }
});

test('legacy import retains identities, exact usage and unknown dispatches without changing original bytes', async () => {
  const w = world();
  try {
    const legacy = w.store(); legacy.saveWork({ workId: 'goal', state: 'runnable', budget: { tokens: 7, observations: { old: true }, attempts: {} } });
    legacy.transfer([{ eventId: 'event', sessionId: 'original' }]);
    const file = path.join(w.rootDir, 'w', 'coordination.jsonl'), original = readFileSync(file);
    const expected = legacy.read();
    const v2 = w.store({ formatVersion: 2 }); await v2.prepare();
    assert.deepEqual(v2.read(), expected);
    assert.equal(v2.observeUsage('goal', 'old', { totalTokens: 100 }), false);
    v2.observeUsage('goal', 'new', { totalTokens: 3, estimatedCostUsd: 0 });
    assert.equal(v2.readWork('goal').budget.tokens, 10);
    assert.equal(v2.readWork('goal').budget.observations, undefined);
    assert.deepEqual(readFileSync(file), original);
    const recovered = w.store(); assert.equal(recovered.readWork('goal').budget.tokens, 10);
    assert.equal(recovered.observeUsage('goal', 'new', { totalTokens: 3 }), false);
    assert.deepEqual(recovered.pendingEvents().map(e => e.eventId), ['event']);
  } finally { w.close(); }
});

test('physical budget accounting has linear journal growth and exact replay after index loss', async () => {
  const w = world(); let release;
  try {
    const store = w.store({ formatVersion: 2 }); await store.prepare(); store.saveWork({ workId: 'goal', state: 'runnable' }, { returnState: false });
    release = registerWorkBudget('w', store);
    const guard = createWorkBudgetGuard({ workspaceId: 'w', workId: 'goal', role: 'project_agent' });
    const bytes = () => readdirSync(path.join(w.rootDir, 'w', 'coordination-v2', 'segments')).reduce((sum, f) => sum + statSync(path.join(w.rootDir, 'w', 'coordination-v2', 'segments', f)).size, 0);
    let first;
    for (let i = 0; i < 1000; i++) { guard.beforeRequest(); guard.observeUsage({ totalTokens: 2, estimatedCostUsd: 0 }, `request-${i}`); if (i === 99) first = bytes(); }
    guard.finish({ totalTokens: 2000, estimatedCostUsd: 0 });
    assert.ok(bytes() < first * 12, `${bytes()} / ${first}`);
    assert.equal(store.readWork('goal').budget.modelRequests, 1000); assert.equal(store.readWork('goal').budget.tokens, 2000);
    store.close();
    rmSync(path.join(w.rootDir, 'w', '.read-models'), { recursive: true, force: true });
    const restored = w.store({ formatVersion: 2 }); await restored.prepare();
    assert.equal(restored.readWork('goal').budget.tokens, 2000); assert.equal(restored.readWork('goal').budget.modelRequests, 1000);
  } finally { release?.(); w.close(); }
});

test('a changed legacy source prevents v2 execution instead of serving a stale projection', async () => {
  const w = world();
  try {
    const legacy = w.store(); legacy.saveWork({ workId: 'goal', state: 'cancelled' });
    const store = w.store({ formatVersion: 2 }); await store.prepare();
    appendFileSync(path.join(w.rootDir, 'w', 'coordination.jsonl'), '{}\n');
    assert.throws(() => store.saveWork({ workId: 'goal', state: 'runnable' }), /coordination_legacy_changed/);
  } finally { w.close(); }
});

test('loss of a durable segment cannot be mistaken for an older executable state after index loss', async () => {
  const w = world();
  try {
    const store = w.store({ formatVersion: 2 }); await store.prepare(); store.saveWork({ workId: 'goal', state: 'runnable' });
    store.saveWork({ workId: 'goal', state: 'cancelled', stopScope: 'work' }); store.close();
    rmSync(path.join(w.rootDir, 'w', '.read-models'), { recursive: true, force: true });
    rmSync(path.join(w.rootDir, 'w', 'coordination-v2', 'segments', '000000000001.jsonl'));
    await assert.rejects(w.store({ formatVersion: 2 }).prepare(), /coordination_journal_missing/);
  } finally { w.close(); }
});

test('an uncommitted partial tail is backed up while the pending dispatch remains unknown', async () => {
  const w = world();
  try {
    const legacy = w.store(); legacy.saveWork({ workId: 'goal', state: 'runnable', budget: { attempts: { a: { pendingTools: [{ toolCallId: 'write' }] } } } });
    const file = path.join(w.rootDir, 'w', 'coordination.jsonl'); appendFileSync(file, '{"kind":"work","revision":2');
    const original = readFileSync(file);
    const store = w.store({ formatVersion: 2 }); await store.prepare();
    assert.equal(store.readWork('goal').budget.attempts.a.pendingTools[0].toolCallId, 'write');
    const backup = readdirSync(path.dirname(file)).find(name => name.startsWith('coordination.jsonl.damaged-'));
    assert.deepEqual(readFileSync(path.join(path.dirname(file), backup)), original);
    assert.equal(store.read().lastRecovery.backup, backup);
  } finally { w.close(); }
});

test('semantic no-op updates do not create another durable record', async () => {
  const w = world();
  try {
    const store = w.store({ formatVersion: 2 }); await store.prepare(); store.saveWork({workId:'g',state:'runnable'});
    const before=store.readSnapshot().revision; store.saveWork({workId:'g',state:'runnable'});
    assert.equal(store.readSnapshot().revision,before);
  } finally { w.close(); }
});

test('process death after journal fsync and before SQL commit replays exactly one usage receipt', async () => {
  const {spawnSync}=await import('node:child_process');
  const w=world();
  try {
    const store=w.store({formatVersion:2}); await store.prepare(); store.saveWork({workId:'g',state:'runnable',budget:{tokens:0,observations:{},attempts:{a:{pendingTools:[{toolCallId:'unknown-write'}]}}}}); store.close();
    const code=`import {createWorkCoordinationStore} from ${JSON.stringify(new URL('./work-coordination-store.mjs',import.meta.url).href)};
let count=0,armed=false;
const s=createWorkCoordinationStore({rootDir:${JSON.stringify(w.rootDir)},workspaceId:'w',formatVersion:2,leaseEpoch:()=> 'child',holdsLease:()=>{if(armed&&++count===5)process.kill(process.pid,'SIGKILL');return true;}});
await s.prepare(); armed=true; s.observeUsage('g','request-once',{totalTokens:7,estimatedCostUsd:0});`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});
    assert.equal(result.signal,'SIGKILL',result.stderr);
    const restored=w.store({formatVersion:2}); await restored.prepare();
    assert.equal(restored.readWork('g').budget.tokens,7);
    assert.equal(restored.observeUsage('g','request-once',{totalTokens:7,estimatedCostUsd:0}),false);
    assert.equal(restored.readWork('g').budget.attempts.a.pendingTools[0].toolCallId,'unknown-write');
  } finally { w.close(); }
});

test('oversized event payloads retain full content behind hashed references and rebuild after index corruption', async () => {
  const {writeFileSync}=await import('node:fs');
  const w=world();
  try {
    const store=w.store({formatVersion:2});await store.prepare();
    const value={workId:'large',state:'cancelled',note:'完整原文'.repeat(30000)};store.saveWork(value);
    const segments=path.join(w.rootDir,'w','coordination-v2','segments');
    const record=JSON.parse(readFileSync(path.join(segments,readdirSync(segments)[0]),'utf8'));
    assert.equal(record.kind,'payload_ref');assert.ok(JSON.stringify(record).length<1024);
    store.close();
    const cache=path.join(w.rootDir,'w','.read-models'),pointer=JSON.parse(readFileSync(path.join(cache,'coordination-current.json'),'utf8'));
    writeFileSync(path.join(cache,pointer.file),'corrupt derived cache');
    const rebuilt=w.store({formatVersion:2});await rebuilt.prepare();assert.equal(rebuilt.readWork('large').note,value.note);rebuilt.close();
    const blob=path.join(w.rootDir,'w','coordination-v2','blobs',record.payloadRef.hash+'.json');writeFileSync(blob,'tampered');
    rmSync(path.join(w.rootDir,'w','.read-models'),{recursive:true});
    await assert.rejects(w.store({formatVersion:2}).prepare(),/coordination_payload_invalid/);
  } finally { w.close(); }
});

test('a cache generation can publish while another process still owns the previous SQLite transaction',async()=>{
  const {DatabaseSync}=await import('node:sqlite');const {writeFileSync,existsSync}=await import('node:fs');const w=world();let oldWriter;
  try{
    const store=w.store({formatVersion:2});await store.prepare();store.saveWork({workId:'g',state:'runnable'});store.close();
    const cache=path.join(w.rootDir,'w','.read-models'),pointerFile=path.join(cache,'coordination-current.json');
    const first=JSON.parse(readFileSync(pointerFile,'utf8')),oldFile=path.join(cache,first.file);
    const reader=w.store({formatVersion:2});assert.equal(reader.readWork('g').state,'runnable');
    oldWriter=new DatabaseSync(oldFile);oldWriter.exec('BEGIN IMMEDIATE');oldWriter.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('old-client-probe','true');
    writeFileSync(pointerFile,JSON.stringify({...first,file:'coordination-00000000-0000-0000-0000-000000000000.sqlite'}));
    const owner=w.store({formatVersion:2});await owner.prepare();owner.saveWork({workId:'g',state:'cancelled'});
    oldWriter.exec('COMMIT');oldWriter.close();oldWriter=null;
    const second=JSON.parse(readFileSync(pointerFile,'utf8'));assert.notEqual(second.file,first.file);assert.equal(existsSync(oldFile),true);
    assert.equal(reader.readWork('g').state,'cancelled');assert.equal(owner.readWork('g').state,'cancelled');
  }finally{oldWriter?.close();w.close();}
});

test('loss of a required head cannot turn an activated project into an executable empty store',async()=>{
 const w=world();try{
  const s=w.store({formatVersion:2});await s.prepare();s.saveWork({workId:'g',state:'cancelled'});s.close();
  rmSync(path.join(w.rootDir,'w','.read-models'),{recursive:true});rmSync(path.join(w.rootDir,'w','coordination-v2','head.json'));
  rmSync(path.join(w.rootDir,'w','coordination-v2','segments'),{recursive:true});
  await assert.rejects(w.store({formatVersion:2}).prepare(),/coordination_head_missing/);
 }finally{w.close();}
});

test('activation can resume with its persisted empty head before the manifest was published',async()=>{
 const w=world();try{
  const s=w.store({formatVersion:2});await s.prepare();s.close();
  const dir=path.join(w.rootDir,'w','coordination-v2'),proof=JSON.parse(readFileSync(path.join(dir,'head.json'),'utf8'));
  assert.equal(proof.revision,0);rmSync(path.join(dir,'manifest.json'));
  const resumed=w.store({formatVersion:2});await resumed.prepare();assert.deepEqual(resumed.read().works,{});
  assert.equal(JSON.parse(readFileSync(path.join(dir,'manifest.json'),'utf8')).generation,proof.generation);
 }finally{w.close();}
});

test('a lost manifest cannot admit a rewritten legacy baseline with the same revision',async()=>{
 const {writeFileSync}=await import('node:fs');const w=world();try{
  const old=w.store();old.saveWork({workId:'g',state:'cancelled',title:'original'});old.close();
  const s=w.store({formatVersion:2});await s.prepare();s.close();
  rmSync(path.join(w.rootDir,'w','coordination-v2','manifest.json'));
  rmSync(path.join(w.rootDir,'w','.read-models'),{recursive:true});
  const file=path.join(w.rootDir,'w','coordination.jsonl');
  writeFileSync(file,readFileSync(file,'utf8').replace('original','rewritten'));
  await assert.rejects(w.store({formatVersion:2}).prepare(),/coordination_legacy_changed/);
 }finally{w.close();}
});

test('a parseable head with invalid revision or hash cannot bypass the durable receipt check',async()=>{
 const {writeFileSync}=await import('node:fs');const w=world();try{
  const s=w.store({formatVersion:2});await s.prepare();s.close();const file=path.join(w.rootDir,'w','coordination-v2','head.json');
  const proof=JSON.parse(readFileSync(file,'utf8'));writeFileSync(file,JSON.stringify({...proof,revision:{}}));
  await assert.rejects(w.store({formatVersion:2}).prepare(),/coordination_head_invalid/);
  writeFileSync(file,JSON.stringify({...proof,hash:'bad'}));await assert.rejects(w.store({formatVersion:2}).prepare(),/coordination_head_invalid/);
 }finally{w.close();}
});

test('a partial active v2 tail is backed up and repaired without releasing a pending tool',async()=>{
 const w=world();try{
  const s=w.store({formatVersion:2});await s.prepare();s.saveWork({workId:'g',state:'runnable',budget:{attempts:{a:{pendingTools:[{toolCallId:'unknown'}]}}}});s.close();
  const dir=path.join(w.rootDir,'w','coordination-v2','segments'),file=path.join(dir,readdirSync(dir).find(f=>f.endsWith('.jsonl')));
  appendFileSync(file,'{"storageVersion":2,"revision":2');const original=readFileSync(file);
  const restored=w.store({formatVersion:2});await restored.prepare();
  assert.equal(restored.readWork('g').budget.attempts.a.pendingTools[0].toolCallId,'unknown');
  const backup=readdirSync(dir).find(f=>f.includes('.damaged-'));assert.deepEqual(readFileSync(path.join(dir,backup)),original);
  assert.ok(restored.read().lastRecovery.backup.includes('.damaged-'));
 }finally{w.close();}
});

test('v2 recovery returns its current immutable inventory while retaining the owner check', async () => {
  const w = world(); let owned = true;
  try {
    const store = w.store({ formatVersion: 2, holdsLease: () => owned }); await store.prepare();
    const first = store.recover(); assert.equal(Object.isFrozen(first), true); assert.equal(first.revision, 0);
    store.saveWork({ workId: 'arrived', state: 'runnable' }, { returnState: false });
    assert.equal(store.recover().works.arrived.state, 'runnable');
    assert.equal(first.works.arrived, undefined);
    owned = false; assert.throws(() => store.recover(), /coordination_lease_lost/);
  } finally { w.close(); }
});
