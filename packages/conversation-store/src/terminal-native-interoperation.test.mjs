import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync,mkdirSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withFileLock} from './conversation-file-lock.mjs';
const {createConversationStore}=await import(process.env.PEER_TERMINAL_REFERENCE ?? './index.mjs');
function world(t){
  const evidence=process.env.PEER_TERMINAL_EVIDENCE_ROOT;
  if(evidence)mkdirSync(evidence,{recursive:true});
  const root=mkdtempSync(join(evidence??tmpdir(),'peer-terminal-native-'));
  if(evidence){writeFileSync(join(root,'.native-cli-fixture'),'isolated');appendFileSync(join(evidence,'roots.jsonl'),JSON.stringify({root,case:t.name})+'\n');}
  else t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=createConversationStore({storeDir:root});const meta=store.createConversation({title:'Terminal fixture',mode:'chat'});
  store.appendMessage(meta.id,{id:'answer',role:'assistant',content:'',future:{opaque:true}});
  return {store,id:meta.id,body:join(root,meta.id+'.jsonl'),index:join(root,'index.jsonl'),marker:join(root,meta.id+'.stream.json')};
}
test('stream patch and clear respect the same index lock as native terminal publication',t=>{
  const w=world(t);w.store.patchStreamingMessage(w.id,'answer',{content:'retained'});
  const saved=readFileSync(w.marker,'utf8');
  withFileLock(w.index,()=>{
    assert.throws(()=>w.store.patchStreamingMessage(w.id,'answer',{content:'late'}),{code:'EEXIST'});
    assert.equal(readFileSync(w.marker,'utf8'),saved);
    assert.throws(()=>w.store.clearStreamPatch(w.id),{code:'EEXIST'});
    assert.equal(readFileSync(w.marker,'utf8'),saved);
  });
  w.store.patchStreamingMessage(w.id,'answer',{content:'later'});w.store.clearStreamPatch(w.id);
  assert.equal(existsSync(w.marker),false);
});
test('foreign or corrupt marker cannot be overwritten by a terminal merge',async t=>{
  for(const marker of ['{bad',JSON.stringify({version:1,conversationId:'foreign',messageId:'answer',patch:{}})]){
    const w=world(t);writeFileSync(w.marker,marker);
    const body=readFileSync(w.body,'utf8'),index=readFileSync(w.index,'utf8');
    await assert.rejects(w.store.commitStreamingMessage(w.id,'answer',{content:'forbidden'}),{code:'BACKGROUND_STREAM_STATE_INVALID'});
    assert.equal(readFileSync(w.body,'utf8'),body);assert.equal(readFileSync(w.index,'utf8'),index);assert.equal(readFileSync(w.marker,'utf8'),marker);
  }
});
test('failure after real body rename keeps a provisional target and can finish known facts without replay',async t=>{
  const w=world(t);const original=fs.renameSync;
  let injected=false;
  fs.renameSync=(from,to)=>{
    if(String(to)===w.index&&!injected){injected=true;throw Object.assign(new Error('controlled index failure'),{code:'EACCES'});}
    return original(from,to);
  };syncBuiltinESMExports();
  const patch={content:'observed result',permissionGrants:[{grantId:'retained',granted:true}],segments:[{type:'tool-call',toolCallId:'same-call',result:{status:'failed',error:{code:'known'}}}]};
  try{await assert.rejects(w.store.commitStreamingMessage(w.id,'answer',patch),{code:'STORE_COMMIT_UNCERTAIN'});}
  finally{fs.renameSync=original;syncBuiltinESMExports();}
  assert.equal(injected,true);assert.equal(JSON.parse(readFileSync(w.body,'utf8')).content,'observed result');
  assert.equal(w.store.getPersistedConversationHistory(w.id).messages.length,0);
  assert.equal(existsSync(w.marker),true);
  await w.store.commitStreamingMessage(w.id,'answer',patch);
  assert.deepEqual(w.store.getPersistedConversationHistory(w.id).messages[0].permissionGrants,patch.permissionGrants);
  assert.equal(w.store.getConversation(w.id).messages[0].future.opaque,true);
  assert.equal(existsSync(w.marker),false);
  w.store.appendMessage(w.id,{id:'later',role:'user',content:'next'});
  assert.deepEqual(w.store.getConversation(w.id).messages.map(m=>m.id),['answer','later']);
});
