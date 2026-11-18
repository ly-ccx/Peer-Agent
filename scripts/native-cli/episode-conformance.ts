// Cold-read the public native executable's real synthetic stores using the
// current TS implementations. This development process is never a CLI sidecar.
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createGoalPlanStore} from '../../packages/runtime-node/src/goal-plan-store.mjs';
import {createCoordinationStorageV2} from '../../packages/runtime-node/src/project-agent/coordination-storage-v2.mjs';
import {createConversationStore} from '../../packages/conversation-store/src/index.mjs';
import {projectConversationHistory} from '../../packages/runtime-core/src/conversation-history-projector.ts';
import {createExecutionResources} from '../../packages/runtime-node/src/project-agent/execution-resources.mjs';
import {Database} from 'bun:sqlite';
import {createWorkCoordinationStore} from '../../packages/runtime-node/src/project-agent/work-coordination-store.mjs';
import {spawnSync} from 'node:child_process';
const output=resolve(process.argv[2]);assert.ok(existsSync(join(output,'.native-cli-fixture')));const roots=readFileSync(join(output,'roots.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));let cases=0;
// ADR 131 requires the current TS store to refuse the native Work Shell floor.
const workShellFloor = 15;
let nativeOnlyRoots = 0;

function readNative(root: string) {
 const run = spawnSync(resolve('target/debug/examples/coordination-conformance'), [], {
  input: JSON.stringify({ now: Date.now() + 1_000_000 }), encoding: 'utf8', timeout: 30000,
  env: { PATH: '/nonexistent', PEER_NATIVE_CONFORMANCE_ROOT: root },
 });
 assert.ifError(run.error);
 assert.equal(run.status, 0, run.stderr);
 const result = JSON.parse(run.stdout);
 assert.equal(result.ok, true, JSON.stringify(result));
 return result;
}

function canonicalFiles(directory: string) {
 return Object.fromEntries(['manifest.json', 'head.json', 'segments', 'blobs'].flatMap(name => {
  const path = join(directory, name);
  if (name === 'manifest.json' || name === 'head.json') return [[name, readFileSync(path)]];
  if (name === 'blobs' && !existsSync(path)) return [];
  return readdirSync(path).map(file => [`${name}/${file}`, readFileSync(join(path, file))]);
 }));
}

async function readFencedWorkShell(root: string, directory: string, storage: ReturnType<typeof createCoordinationStorageV2>) {
 const before = canonicalFiles(directory);
 const head = JSON.parse(before['head.json'].toString());
 assert.equal(head.minimumWriterVersion, workShellFloor);
 const unsupported = { code: 'coordination_schema_unsupported' };
 await assert.rejects(() => storage.prepare(), unsupported);
 assert.throws(() => storage.readSnapshot(), unsupported);
 assert.throws(() => storage.commitEntry({ kind: 'work', work: { workId: 'old-writer', state: 'queued' } }), unsupported);
 assert.deepEqual(canonicalFiles(directory), before);
 const native = readNative(root);
 assert.equal(native.fenced, true);
 assert.equal(native.headRevision, head.revision);
 assert.equal(native.hash, head.hash);
 assert.deepEqual(canonicalFiles(directory), before);
 nativeOnlyRoots++;
 cases += 5;
 return native.state;
}

for(const receipt of roots){const root=receipt.root;assert.ok(existsSync(join(root,'.native-cli-fixture')));const plans=createGoalPlanStore({storeDir:join(root,'goal-plans')});const conversations=createConversationStore({storeDir:join(root,'conversations')});
 const storage=createCoordinationStorageV2({directory:join(root,'project-runtime/w'),legacyFile:join(root,'project-runtime/w/coordination.jsonl'),assertOwner(){}});
 const directory = join(root, 'project-runtime/w/coordination-v2');
 const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
 const workShell = manifest.minimumReaderVersion === workShellFloor;
 try{
  let state;
  if (workShell) {
   assert.equal(manifest.schemaVersion, 2);
   assert.equal(manifest.minimumWriterVersion, workShellFloor);
   state = await readFencedWorkShell(root, directory, storage);
  } else {
   await storage.prepare();
   state = storage.read();
  }
 const raw=JSON.parse(readFileSync(join(root,'goal-plans/p.json'),'utf8'));const plan=plans.getPlan('p');assert.equal(plan.planId,raw.planId);assert.equal(plan.delegationOrigin.executionControl?.phase,raw.delegationOrigin.executionControl?.phase);assert.deepEqual(plan.future,{opaque:'preserved'});cases++;
 const history=conversations.getPersistedConversationHistory('c');const projected=projectConversationHistory(history.messages);for(const message of projected.messages.filter(m=>m.role==='tool')){assert.ok(projected.messages.some(m=>m.toolCalls?.some(c=>c.id===message.toolCallId)));}cases++;
 const resources=createExecutionResources({rootDir:join(root,'project-runtime')});try{
  const db=new Database(join(root,'project-runtime/execution-resources.sqlite'),{readonly:true});try{
   assert.equal(resources.revision(),(db.query('SELECT COALESCE(MAX(revision),0) AS revision FROM resource_events').get() as any).revision);
   const active=db.query("SELECT value FROM claims WHERE state!='released' ORDER BY id").all().map((r:any)=>JSON.parse(r.value));assert.deepEqual(resources.snapshot().sort((a,b)=>a.claimId.localeCompare(b.claimId)),active.sort((a,b)=>a.claimId.localeCompare(b.claimId)));
   for(const event of db.query("SELECT resource,operationId FROM resource_events WHERE operationId LIKE 'tool-result://%'").all() as any[]){
    const id=event.operationId.slice('tool-result://'.length);const indexed=readFileSync(join(root,'goal-plans/evidence-index.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s)).find(e=>e.evidenceRef===event.operationId);assert.ok(indexed);assert.equal(indexed.toolCallId,id);
    const paired=conversations.getPersistedConversationHistory(indexed.conversationId);const segment=paired.messages.flatMap((m:any)=>m.segments||[]).find((s:any)=>s.toolCallId===id);assert.equal(segment?.result?.status,'success');assert.equal(segment?.tool,'write_file');
    const claim:any=db.query('SELECT value FROM claims WHERE resource=?').get(event.resource);assert.ok(claim);assert.notEqual(JSON.parse(claim.value).identity,'missing');cases++;
   }
   if(receipt.case?.includes('created_file_can_be_read')){assert.equal(projected.messages.filter(m=>m.role==='tool').length,4);assert.ok(db.query("SELECT 1 FROM resource_events WHERE operationId LIKE 'tool-result://%'").get());cases++;}
   cases++;
  }finally{db.close();}
 }finally{resources.close();}
 for(const work of Object.values(state.works) as any[]){for(const pending of [...(work.budget?.uncertainDispatches||[]),...Object.values(work.budget?.attempts||{}).flatMap((a:any)=>a.pendingTools||[])]){assert.equal(pending.nativeRecorder.schemaVersion,1);assert.equal(pending.nativeRecorder.runtime,'peer-native');assert.ok(pending.dispatchId.startsWith('dispatch-'));assert.equal(pending.nativeRecorder.execution.planId,pending.planId||'p');cases++;}}
 if(receipt.case?.includes('crash_after_file')){assert.equal(state.works.work.budget.uncertainDispatches.length,1);assert.equal(state.works.work.budget.attempts && Object.keys(state.works.work.budget.attempts).length,0);assert.equal(plan.delegationOrigin.executionControl.phase,'reconciling');assert.equal(state.works.work2.budget.toolCalls,1);assert.equal(plans.getPlan('p2').status,'paused');cases++;}
 }finally{storage.close();}
 if(receipt.case?.includes('native_mcp::')){
  const history=conversations.getPersistedConversationHistory('c');
  const rawMessages=readFileSync(join(root,'conversations/c.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  for(const message of history.messages as any[]){for(const segment of message.segments||[]){if(!segment.tool?.startsWith('mcp__')||!segment.result)continue;
   const original=rawMessages.flatMap((m:any)=>m.segments||[]).find((s:any)=>s.toolCallId===segment.toolCallId);assert.deepEqual(segment.result,original.result);
   assert.equal(segment.result.evidence.evidenceKind,'local_mcp_tool_call');assert.equal(segment.result.evidence.serverId,'s');assert.ok(segment.result.evidence.projectionId);assert.ok(segment.result.evidence.permissionGrantId);
   const indexed=readFileSync(join(root,'goal-plans/evidence-index.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.ok(indexed.some((row:any)=>row.evidenceRef===`tool-result://${segment.toolCallId}`));cases++;
  }}
  for(const secret of ['fixture-sensitive-secret','oauth-refreshed-secret','oauth-new-refresh-secret','registered-client-secret'])assert.ok(!JSON.stringify(history).includes(secret),`Credential redaction: ${receipt.case}`);cases++;
 }
 if (workShell) continue;
 // Re-save each compatible Work through the current TS writer, including future opaque facts.
 const writer=createWorkCoordinationStore({rootDir:join(root,'project-runtime'),workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'owned-fixture-roundtrip',formatVersion:2,fenceLegacyWrites:true});
 let expected:any;
 try{await writer.prepare();for(const work of Object.values(writer.read().works) as any[]){const budget=structuredClone(work.budget);writer.saveWork({...work,roundtrip:'current-ts-writer'});assert.deepEqual(writer.readWork(work.workId).budget,budget);cases++;}expected=writer.read();}
 finally{writer.close();}
 // All public test children have exited. Use the existing real Rust Host/Store
 // fixture seam to re-read the TS write; it cannot dispatch models or tools.
 assert.deepEqual(readNative(root).state, expected);cases++;
}
assert.ok(roots.length >= 6);
assert.ok(nativeOnlyRoots > 0 && nativeOnlyRoots < roots.length, 'Expected both fenced Work Shell and TS-compatible roots');
console.log(JSON.stringify({ok:true,roots:roots.length,nativeOnlyRoots,cases,coverage:'Actual native exec, TS Goal/Conversation/Resources, compatible TS coordination round trips, fenced Work Shell TS refusal and native cold-read.'}));
