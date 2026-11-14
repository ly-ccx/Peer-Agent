// Real TS and native processes share only synthetic existing-format stores.
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=mkdtempSync(join(tmpdir(),'peer-native-durable-'));
writeFileSync(join(root,'.native-cli-fixture'),'synthetic');
process.env.PEER_AGENT_HOME=root; process.env.PEER_USER_DATA_PATH=root;
const binary=resolve(process.argv[2]??'target/debug/examples/durable-conformance');
const env={...process.env,PEER_NATIVE_CONFORMANCE_ROOT:root};
const at='2026-11-14T04:00:00.000Z';
const run=(r:object,status=0)=>{const p=spawnSync(binary,[],{env,input:JSON.stringify(r),encoding:'utf8',timeout:5000});assert.equal(p.status,status,p.stderr);return status===0?JSON.parse(p.stdout):null;};
const native=(r:object)=>{const v=run(r);assert.equal(v.ok,true,JSON.stringify(v));return v.data;};
const {createConversationStore}=await import('../../packages/conversation-store/src/index.mjs');
const {createApprovalStore}=await import('../../packages/runtime-node/src/project-agent/approval-store.mjs');
const {assignSessionPreview}=await import('../../packages/conversation-store/src/session-preview.mjs');
const store=createConversationStore({storeDir:join(root,'conversations')});
const approvals=createApprovalStore({rootDir:join(root,'project-runtime'),now:()=>new Date(at),compactBytes:32*1024*1024});
let cases=0;
const c=native({op:'create',title:'Roundtrip'});let id=c.id;
let legacy=store.getConversation(id);
for(const key of Object.keys(c))assert.deepEqual(legacy[key],c[key],key);cases++;
store.appendMessage(id,{id:'ts-user',role:'user',content:'TS → Rust',createdAt:at});
assert.deepEqual(native({op:'history',id}).history,store.getPersistedConversationHistory(id));cases++;
const row={id:'native-reply',role:'assistant',content:'Rust → TS',createdAt:at,future:{preserved:true}};
const committed=native({op:'commit',id,message:row});assert.deepEqual(store.getPersistedConversationHistory(id),committed.history);cases++;
assert.equal(native({op:'commit',id,message:row}).alreadyCommitted,true);assert.equal(store.getPersistedConversationHistory(id).messages.length,2);cases++;
let original=native({op:'history',id});
store.appendMessage(id,{id:'ts-next',role:'user',content:'next',createdAt:at});
assert.equal(run({op:'commit',id,message:{id:'stale',role:'user',content:'stale'},revision:original.history.contentRevision,source:original.source}).code,'BACKGROUND_VERSION_CHANGED');cases++;
// Native and real TS materialized preview are compared for structured states.
for(const message of [
{id:'preview-1',role:'user',content:'  中文\uFEFF  emoji 🦀 '.repeat(20),createdAt:at},
{id:'preview-2',role:'user',content:'',attachments:[{name:'图.png'},{name:'b.txt'}],createdAt:at},
{id:'preview-3',role:'assistant',content:'Question',question:{prompt:'Select?',options:[' one ','two'],answered:false,expiresAt:at},createdAt:at},
{id:'preview-4',kind:'agent_activity',role:'assistant',content:'working',agentActivity:{state:'running'},createdAt:at},
{id:'preview-5',kind:'agent_activity',role:'assistant',content:'verified',agentActivity:{state:'verified'},createdAt:at},
{id:'preview-6',role:'assistant',content:'',segments:[{type:'tool-call',tool:'local.shell.exec',args:{},result:'done'}]},
{id:'preview-7',kind:'system_card',role:'assistant',content:'hidden',cards:[{kind:'verdict'}]},
]){
 const before=store.getConversation(id);native({op:'commit',id,message});const after=store.getConversation(id);
 const expected={...before,contentRevision:after.contentRevision,updatedAt:after.updatedAt};assignSessionPreview(expected,message);
 assert.deepEqual(after.preview,expected.preview, message.id);cases++;
}
// Body is durable but index commit fails; unknown tool stays incomplete.
const pending={id:'unknown-tool',role:'assistant',content:'',segments:[{type:'tool-call',toolCallId:'unknown-tool',tool:'local.shell.exec',args:{command:'printf effect'}}]};
const body=join(root,'conversations',`${id}.jsonl`);
assert.equal(run({op:'interrupt',id,message:pending}).code,'STORE_COMMIT_UNCERTAIN');const preserved=readFileSync(body);cases++;
assert.equal(run({op:'commit',id,message:pending}).code,'STORE_COMMIT_UNCERTAIN');cases++;
const fixed=native({op:'reconcile',id});assert.deepEqual(fixed.history,store.getPersistedConversationHistory(id));assert.deepEqual(readFileSync(body),preserved);cases++;
assert.equal(native({op:'commit',id,message:pending}).alreadyCommitted,true);assert.equal(store.getPersistedConversationHistory(id).messages.at(-1).segments[0].result,undefined);cases++;
store.appendMessage(id,{id:'after-recovery',role:'user',content:'new input',createdAt:at});assert.deepEqual(native({op:'history',id}).history,store.getPersistedConversationHistory(id));cases++;
// Real unclean process exit leaves existing mkdir locks. No TTL cleanup.
const crashConversation=native({op:'create'});const crashId=crashConversation.id;
run({op:'crash',id:crashId,message:{id:'durable-before-crash',role:'user',content:'persisted'}},77);
assert.ok(existsSync(join(root,'conversations','index.jsonl.lock')));assert.equal(run({op:'reconcile',id:crashId}).code,'STORE_LOCK_BUSY');cases++;
// Fixture process has exited; remove only its known empty locks, offline.
rmdirSync(join(root,'conversations','index.jsonl.lock'));
rmdirSync(join(root,'conversations',`${crashId}.jsonl.lock`));
assert.equal(native({op:'reconcile',id:crashId}).history.messages.length,1);cases++;
native({op:'commit',id:crashId,message:{id:'later',role:'user',content:'later task'}});cases++;
// Approvals preserve current scope/revision and remain audit data on restart.
const first=native({op:'approval_open',id:'call',workspaceId:'workspace'});assert.deepEqual(approvals.list({workspaceId:'workspace'}),[first]);cases++;
const approved=native({op:'approval_decide',expected:first,allow:true});assert.deepEqual(approvals.list({workspaceId:'workspace'}),[approved]);cases++;
const ts=approvals.append({...first,approvalId:'from-ts',state:'open'});assert.deepEqual(native({op:'approval_list',workspaceId:'workspace'}).find(r=>r.approvalId==='from-ts'),ts);cases++;
const denied=native({op:'approval_decide',expected:ts,allow:false});assert.deepEqual(approvals.list({workspaceId:'workspace'}).find(r=>r.approvalId==='from-ts'),denied);cases++;
const stale=native({op:'approval_open',id:'stale',workspaceId:'workspace'});
const expired=native({op:'approval_open',id:'expired',workspaceId:'workspace',deadlineAt:at});
native({op:'approval_open',id:'foreign',workspaceId:'foreign'});
const recovered=native({op:'approval_recover',workspaceId:'workspace',at});assert.equal(recovered.find(r=>r.approvalId==='stale').state,'stale');assert.equal(recovered.find(r=>r.approvalId==='expired').state,'expired');cases++;
assert.equal(approvals.list({workspaceId:'foreign'})[0].state,'open');assert.equal(run({op:'approval_decide',expected:stale,allow:true}).code,'APPROVAL_STATE_CHANGED');cases++;
assert.equal(native({op:'approval_recover',workspaceId:'workspace'}).length,0);cases++;
// Native lock ownership is observed by the real legacy writer, not a mock port.
const holder=spawn(binary,[],{env,stdio:['pipe','pipe','pipe']});holder.stdin.end(JSON.stringify({op:'hold_approval',workspaceId:'workspace'}));
const holderDone=new Promise<void>((yes,no)=>{holder.once('error',no);holder.once('exit',code=>code===0?yes():no(Error(`holder ${code}`)));});
await new Promise<void>((yes,no)=>{holder.stdout.once('data',data=>{try{assert.equal(JSON.parse(data.toString().trim()).phase,'locked');yes();}catch(e){no(e);}});holder.once('error',no);});
assert.throws(()=>approvals.append({...first,approvalId:'blocked-ts'}),{code:'STORE_LOCK_BUSY'});
assert.equal(run({op:'approval_open',id:'blocked-native',workspaceId:'workspace'}).code,'STORE_LOCK_BUSY');cases++;
await holderDone;approvals.append({...first,approvalId:'after-unlock'});assert.ok(native({op:'approval_list',workspaceId:'workspace'}).find(r=>r.approvalId==='after-unlock'));cases++;
const race=native({op:'approval_open',id:'race',workspaceId:'workspace'});
const decide=(allow:boolean)=>new Promise<any>((yes,no)=>{const p=spawn(binary,[],{env,stdio:['pipe','pipe','pipe']});let output='';p.stdout.on('data',d=>output+=d);p.once('error',no);p.once('exit',code=>code===0?yes(JSON.parse(output)):no(Error(`decide ${code}`)));p.stdin.end(JSON.stringify({op:'approval_decide',expected:race,allow}));});
const raced=await Promise.all([decide(true),decide(false)]);assert.equal(raced.filter(r=>r.ok).length,1);assert.equal(raced.filter(r=>r.code==='APPROVAL_STATE_CHANGED').length,1);cases++;
const path=join(root,'project-runtime/workspace/approvals.jsonl');writeFileSync(path,readFileSync(path).toString()+'{partial');const bytes=readFileSync(path);assert.equal(run({op:'approval_open',id:'blocked',workspaceId:'workspace'}).code,'BACKGROUND_HISTORY_CORRUPT');assert.deepEqual(readFileSync(path),bytes);cases++;
console.log(JSON.stringify({ok:true,cases,fixture:root}));
