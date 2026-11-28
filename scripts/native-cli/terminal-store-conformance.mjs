// Development oracle. The native product never launches this script or Node.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,copyFileSync,readdirSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createConversationStore} from '../../packages/conversation-store/src/index.mjs';
const binary=resolve(process.argv[2]??'target/debug/examples/terminal-conformance');
const evidence=resolve(process.argv[3]??mkdtempSync(join(tmpdir(),'peer-terminal-interop-')));
mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'.native-cli-fixture'),'isolated');
const AT='2026-11-18T00:00:00.000Z';let cases=0;const roots=[];
function world(name){
 const root=mkdtempSync(join(evidence,'case-'));writeFileSync(join(root,'.native-cli-fixture'),'isolated');
 const store=createConversationStore({storeDir:join(root,'conversations')});const c=store.createConversation({title:name,mode:'chat'});
 store.appendMessage(c.id,{id:'user',role:'user',content:'question'});
 store.appendMessage(c.id,{id:'answer',role:'assistant',content:'',future:{opaque:true}});
 roots.push({name,root,id:c.id});
 appendFileSync(join(evidence,'roots.jsonl'),JSON.stringify({name,root,id:c.id})+'\n');
 return {root,store,id:c.id,body:join(root,'conversations',c.id+'.jsonl'),marker:join(root,'conversations',c.id+'.stream.json'),index:join(root,'conversations/index.jsonl')};
}
function raw(w,request){return spawnSync(binary,[],{input:JSON.stringify({id:w.id,...request}),encoding:'utf8',timeout:12000,env:{PATH:'/nonexistent',PEER_NATIVE_CONFORMANCE_ROOT:w.root}});}
function native(w,request){const r=raw(w,request);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function snapshot(w){const s=native(w,{op:'snapshot'});assert.equal(s.ok,true,JSON.stringify(s));return s;}
function expected(s){return {sourceRevision:s.sourceRevision,contentRevision:s.history.contentRevision};}
function update(w,op,patch,source=snapshot(w),extra={}){return native(w,{op,messageId:'answer',patch,at:AT,expected:expected(source),...extra});}
function files(w){return [w.body,w.index,w.marker].map(p=>existsSync(p)?readFileSync(p,'utf8'):null);}
function paired(w){const ts=createConversationStore({storeDir:join(w.root,'conversations')}).getPersistedConversationHistory(w.id),rust=snapshot(w).history;assert.deepEqual(rust.messages,ts.messages);assert.equal(rust.contentRevision,ts.contentRevision);cases++;return rust;}
const patch={content:'observed final',interrupted:false,permissionGrants:[{grantId:'real-retained-grant',toolCallId:'same-call',granted:true}],segments:[{type:'tool-call',tool:'read_file',toolCallId:'same-call',args:{path:'fact.txt'},result:{status:'failed',error:{code:'known'},evidence:{evidenceId:'retained'}}}]};
{
 const w=world('TS stream -> native terminal -> both readers');w.store.patchStreamingMessage(w.id,'answer',{content:'partial'});
 assert.deepEqual(paired(w).messages.map(m=>m.id),['user']);
 const marker=JSON.parse(readFileSync(w.marker,'utf8'));marker.future={opaque:'marker'};writeFileSync(w.marker,JSON.stringify(marker));
 assert.equal(update(w,'stream',{content:'partial two'}).ok,true);assert.deepEqual(JSON.parse(readFileSync(w.marker,'utf8')).future,marker.future);
 assert.equal(update(w,'terminal',patch).ok,true);assert.equal(existsSync(w.marker),false);
 assert.deepEqual(paired(w).messages[1].permissionGrants,patch.permissionGrants);
 const saved=files(w);assert.equal(update(w,'terminal',patch).alreadyCommitted,true);assert.deepEqual(files(w),saved);cases++;
 w.store.appendMessage(w.id,{id:'later',role:'user',content:'later task'});assert.equal(paired(w).messages.length,3);
}
{
 const w=world('native stream -> actual TS worker terminal -> both readers');const old=snapshot(w);
 assert.equal(update(w,'stream',{content:'native preview'}).ok,true);paired(w);
 const saved=files(w);assert.equal(update(w,'terminal',patch,old).code,'BACKGROUND_VERSION_CHANGED');assert.deepEqual(files(w),saved);cases++;
 await w.store.commitStreamingMessage(w.id,'answer',patch);assert.equal(paired(w).messages[1].future.opaque,true);
}
for(const phase of ['marker','body','index','sidecar']){
 const w=world('native interruption '+phase+' -> TS known terminal');
 const r=update(w,'fault',patch,snapshot(w),{after:phase});assert.equal(r.code,'STORE_COMMIT_UNCERTAIN');
 assert.equal(JSON.parse(readFileSync(w.body,'utf8').trim().split('\n')[1]).content,phase==='marker'?'':'observed final');
 assert.deepEqual(paired(w).messages.map(m=>m.id),phase==='sidecar'?['user','answer']:['user']);
 await w.store.commitStreamingMessage(w.id,'answer',patch);assert.deepEqual(paired(w).messages[1].permissionGrants,patch.permissionGrants);
 assert.equal(existsSync(w.marker),false);w.store.appendMessage(w.id,{id:'later',role:'user',content:'next task'});assert.equal(paired(w).messages.length,3);
}
for(const phase of ['body','index']){
 const w=world('actual native hard exit '+phase+' -> explicit offline fixture recovery');
 const r=raw(w,{op:'fault',messageId:'answer',patch,at:AT,expected:expected(snapshot(w)),after:'exit:'+phase});
 assert.equal(r.status,86,r.stderr);paired(w);const saved=files(w);
 assert.equal(update(w,'terminal',patch).code,'STORE_LOCK_BUSY');assert.deepEqual(files(w),saved);cases++;
 // Every writer in this test-owned root has exited. Preserve a diagnostic copy
 // before explicit offline maintenance; this is not automatic orphan removal.
 const diagnostic=join(w.root,'before-offline-maintenance');mkdirSync(diagnostic);
 for(const file of [w.body,w.index,w.marker])if(existsSync(file))copyFileSync(file,join(diagnostic,file.split('/').at(-1)));
 for(const file of [w.index,w.body]){const lock=file+'.lock';assert.deepEqual(readdirSync(lock),[]);rmSync(lock,{recursive:true});}
 assert.equal(update(w,'terminal',patch).ok,true);assert.deepEqual(paired(w).messages[1].permissionGrants,patch.permissionGrants);
 w.store.appendMessage(w.id,{id:'later',role:'user',content:'new task'});assert.equal(paired(w).messages.length,3);
}
for(const marker of ['{broken',{version:2,patch:{},messageId:'answer'},{version:1,conversationId:'foreign',messageId:'answer',patch:{}},{version:1,messageId:'missing',patch:{}}]){
 const w=world('invalid sidecar remains unchanged');const value=typeof marker==='string'?marker:{conversationId:w.id,...marker};
 writeFileSync(w.marker,typeof value==='string'?value:JSON.stringify(value));const saved=files(w);
 const r=native(w,{op:'snapshot'});assert.equal(r.ok,false);assert.ok(['BACKGROUND_STREAM_STATE_INVALID','BACKGROUND_STREAM_TARGET_MISSING'].includes(r.code),r.code);assert.deepEqual(files(w),saved);cases++;
}
{
 const w=world('live native lock prevents TS stream mutation then admits next terminal');w.store.patchStreamingMessage(w.id,'answer',{content:'retained'});
 const holder=spawn(binary,[],{stdio:['pipe','pipe','pipe'],env:{PATH:'/nonexistent',PEER_NATIVE_CONFORMANCE_ROOT:w.root}});
 const finished=once(holder,'close');let output='';const ready=new Promise((yes,no)=>{const timer=setTimeout(()=>no(new Error('holder did not acknowledge')),3000);holder.stdout.on('data',b=>{output+=b;if(output.includes('\n')){clearTimeout(timer);yes();}});holder.once('error',no);});
 holder.stdin.end(JSON.stringify({id:w.id,op:'hold',holdMs:6500}));await ready;
 const saved=files(w);
 const code=`const {createConversationStore}=await import(process.argv[1]);try{createConversationStore({storeDir:process.argv[2]}).patchStreamingMessage(process.argv[3],'answer',{content:'forbidden'});console.log(JSON.stringify({wrote:true}));}catch(e){console.log(JSON.stringify({code:e.code}));}`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code,new URL('../../packages/conversation-store/src/index.mjs',import.meta.url).href,join(w.root,'conversations'),w.id],{encoding:'utf8',timeout:10000});
 assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).code,'EEXIST');assert.deepEqual(files(w),saved);cases++;
 assert.equal((await finished)[0],0);w.store.patchStreamingMessage(w.id,'answer',{content:'admitted'});assert.equal(update(w,'terminal',patch).ok,true);paired(w);
}
writeFileSync(join(evidence,'roots.json'),JSON.stringify(roots,null,2)+'\n');
console.log(JSON.stringify({ok:true,roots:roots.length,cases,evidence,scope:'Actual TS/native v1 sidecar, terminal body/index/marker, source CAS, real child hard exits, explicit isolated offline lock maintenance and later messages. No model/tool replay, installation or personal data.'}));
