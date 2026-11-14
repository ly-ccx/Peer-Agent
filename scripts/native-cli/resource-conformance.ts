// Development reference only; no JS process is part of the native runtime.
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { createExecutionResources } from '../../packages/runtime-node/src/project-agent/execution-resources.mjs';
import { executionIdentity } from '../../packages/runtime-node/src/project-agent/session-control-kernel.mjs';
import { directoryResource, fileResource, providerExecutionScopes, providerFileScopes } from '../../packages/runtime-node/src/project-agent/execution-scopes.mjs';
import { registerWorkBudget } from '../../packages/runtime-node/src/project-agent/work-budget.mjs';

const binary=resolve(process.argv[2]);
const root=mkdtempSync(join(tmpdir(),'peer-native-resource-'));
const at='2026-11-14T00:00:00.000Z';let passed=0;
const stores:any[]=[];
function fixture(name:string){const data=join(root,name);mkdirSync(data);writeFileSync(join(data,'.native-cli-fixture'),'synthetic');return data;}
function native(data:string,r:any,status=0){
  const result=spawnSync(binary,[],{input:JSON.stringify({...r,at}),env:{PATH:'/nonexistent',PEER_NATIVE_CONFORMANCE_ROOT:data},encoding:'utf8',timeout:10_000,maxBuffer:4*1024*1024});
  assert.equal(result.error,undefined);assert.equal(result.status,status,result.stderr);return JSON.parse(result.stdout);
}
function value(data:string,r:any){const result=native(data,r);assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
function ts(data:string){const store=createExecutionResources({rootDir:join(data,'project-runtime'),now:()=>at});stores.push(store);return store;}
function workspace(data:string,name:string){const path=join(data,name);mkdirSync(path);return path;}
function plan(id:string,path:string,workspaceId=id){return {planId:id,conversationId:`conversation-${id}`,title:id,status:'executing',targetWorkspacePath:path,
  delegationOrigin:{sessionId:`session-${id}`,workspaceId,phase:'running',executionGeneration:'generation-1',coordinationBinding:{executionEpoch:`epoch-${id}`,goalRevision:7}}};}
function facts(p:any){return {execution:executionIdentity(p),workspaceId:p.delegationOrigin.workspaceId,directory:p.targetWorkspacePath,title:p.title,readOnly:p.delegationOrigin.readOnly===true};}
function stopped(s:any,p:any,id:string,unknownCalls:string[]=[]){return {receiptId:`receipt-${id}`,operationId:id,execution:executionIdentity(p),admissionClosed:true,runnerIdle:true,schedulerIdle:true,
  resourceClaims:s.claimsFor(p).map(({claimId,revision}:any)=>({claimId,revision})),unknownCalls,scope:'managed_execution'};}
const claims=(v:any[])=>[...v].sort((a,b)=>a.claimId.localeCompare(b.claimId,'en'));
function equalClaims(data:string,s:any){assert.deepEqual(claims(value(data,{op:'snapshot'})),claims(s.snapshot()));passed++;}

try{
  const data=fixture('roundtrip');assert.equal(value(data,{op:'init'}).revision,0);passed++;
  const schema=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/execution-resources-v3.json',import.meta.url),'utf8'));
  for(const mode of ['native-first','ts-first']){
    const sample=fixture(mode);
    if(mode==='native-first')value(sample,{op:'init'});else ts(sample).revision();
    const db=new Database(join(sample,'project-runtime/execution-resources.sqlite'),{readonly:true});
    for(const table of schema.tables){
      const columns=db.query(`PRAGMA table_info(${table.name})`).all().map(({name,type,notnull,pk}:any)=>({name,type,notnull,pk}));assert.deepEqual(columns,table.columns);
    }
    assert.equal((db.query('PRAGMA user_version').get() as any).user_version,3);db.close();passed++;
  }
  const s=ts(data);const directory=workspace(data,'workspace'),a=plan('a',directory),b=plan('b',directory);
  s.reserve(a,'host-a');equalClaims(data,s); // Claim digest includes generation before goalRevision.
  assert.deepEqual(value(data,{op:'inspect',plan:facts(b),host:'host-b'}),s.inspect(b,'host-b'));passed++;
  assert.equal(value(data,{op:'activate',plan:facts(a),host:'host-a'}),true);equalClaims(data,s);
  const stale=stopped(s,a,'stale');s.markHandle(a,{handleId:'handle-a',toolCallId:'tool-a',state:'ended',completedAt:at});
  assert.throws(()=>s.settle(a,stale,'host-a'),/receipt_stale/);assert.equal(native(data,{op:'settle',plan:facts(a),receipt:stale}).code,'execution_resource_receipt_stale');passed++;
  const receipt=stopped(s,a,'done');const result=value(data,{op:'settle',plan:facts(a),receipt});assert.deepEqual(s.settle(a,receipt,'host-a'),result);passed++;
  assert.deepEqual(value(data,{op:'settle',plan:facts(a),receipt}),result);assert.equal(native(data,{op:'settle',plan:facts(a),receipt:{...receipt,unknownCalls:['changed']}}).code,'execution_resource_receipt_conflict');passed++;
  assert.equal(value(data,{op:'reserve',plan:facts(b),host:'host-b'}).allowed,true);assert.equal(s.admitted(b,'host-b'),true);equalClaims(data,s);
  value(data,{op:'handle',plan:facts(b),handle:{handleId:'handle-b',toolCallId:'tool-b',state:'active'}});
  const noUnknown=stopped(s,b,'unsafe');assert.equal(native(data,{op:'settle',plan:facts(b),receipt:noUnknown}).code,'execution_stop_unconfirmed');assert.throws(()=>s.settle(b,noUnknown,'host-b'),/execution_stop_unconfirmed/);passed++;
  const unknown=stopped(s,b,'unknown',['tool-b']);value(data,{op:'settle',plan:facts(b),receipt:unknown});equalClaims(data,s);
  let claim=s.claimsFor(b)[0];let closure={claimId:claim.claimId,claimRevision:claim.revision,authorityRef:'fixture-grant',unknownCalls:['tool-b'],proof:'verified_dead',at};
  assert.equal(native(data,{op:'close',plan:facts(b),closure}).code,'execution_stop_unconfirmed');assert.throws(()=>s.closeClaim(b,closure),/execution_stop_unconfirmed/);passed++;
  s.markHandle(b,{handleId:'handle-b',toolCallId:'tool-b',state:'ended',completedAt:at});claim=s.claimsFor(b)[0];closure={...closure,claimRevision:claim.revision};
  const closed=value(data,{op:'close',plan:facts(b),closure});assert.deepEqual(s.closeClaim(b,closure),closed);assert.deepEqual(value(data,{op:'retained',plan:facts(b)}),s.retainedUnknowns(b));passed++;
  value(data,{op:'protect',plan:facts(b),host:'host-b',state:'reconciling',unknown:['tool-b']});assert.equal(value(data,{op:'has_closure',plan:facts(b)}),true);assert.deepEqual(value(data,{op:'claims',plan:facts(b)}),[]);passed++;
  const c=plan('c',directory);assert.equal(value(data,{op:'reserve',plan:facts(c),host:'host-c'}).allowed,true);passed++;
  const oldReceipt={...receipt,resourceClaims:receipt.resourceClaims};value(data,{op:'settle',plan:facts(a),receipt:oldReceipt});assert.equal(s.inspect(plan('later',directory),'later').allowed,false);passed++;

  const aliases=fixture('aliases');value(aliases,{op:'init'});const dir=workspace(aliases,'workspace'),alias=join(aliases,'alias'),child=workspace(dir,'child');symlinkSync(dir,alias);
  const sa=ts(aliases);sa.reserve(plan('owner',dir),'owner');
  for(const target of [dir,alias,child]){const q=plan('other',target);assert.equal(value(aliases,{op:'reserve',plan:facts(q),host:'other'}).allowed,false);passed++;}
  const scoped=value(aliases,{op:'scope',path:alias,file:join(alias,'missing/file.txt')});assert.deepEqual(scoped,{directory:directoryResource(alias),fileScopes:providerFileScopes(join(alias,'missing/file.txt')),executionScopes:providerExecutionScopes(alias)});passed++;
  const git=fixture('worktree-scopes'),tree=workspace(git,'tree'),metadata=join(git,'repository.git/worktrees/one');mkdirSync(metadata,{recursive:true});writeFileSync(join(tree,'.git'),'gitdir: ../repository.git/worktrees/one\n');writeFileSync(join(metadata,'commondir'),'../..\n');
  assert.deepEqual(value(git,{op:'scope',path:tree,file:join(tree,'new.txt')}),{directory:directoryResource(tree),fileScopes:providerFileScopes(join(tree,'new.txt')),executionScopes:providerExecutionScopes(tree)});passed++;
  const fp=plan('file-activation',tree),fs=ts(git);fs.reserve(fp,'file-host',[{kind:'file',path:join(tree,'new.txt')}]);
  assert.equal(value(git,{op:'activate',plan:facts(fp),host:'file-host'}),true);assert.equal(fs.activate(fp,'file-host'),true);equalClaims(git,fs);

  const sets=fixture('sets');value(sets,{op:'init'});const x=workspace(sets,'x'),y=workspace(sets,'y'),z=workspace(sets,'z');const ss=ts(sets),px=plan('x',x),py=plan('y',y);
  ss.reserve(px,'x',[{kind:'directory',path:z}]);
  const refused=value(sets,{op:'reserve',plan:facts(py),host:'y',scopes:[{kind:'directory',path:x},{kind:'directory',path:z}],recordConflict:true});assert.equal(refused.allowed,false);assert.deepEqual(ss.claimsFor(py),[]);passed++;
  const finish=stopped(ss,px,'finish');ss.settle(px,finish,'x');
  const allowed=value(sets,{op:'reserve',plan:facts(py),host:'y'});assert.equal(allowed.allowed,true);assert.equal(allowed.claims.length,3);equalClaims(sets,ss);
  const pyStop=stopped(ss,py,'rebind');ss.settle(py,pyStop,'y');const newer={...executionIdentity(py),executionEpoch:'epoch-y-next'};
  value(sets,{op:'rebind',from:executionIdentity(py),to:newer,receiptId:pyStop.receiptId});passed++;

  const narrow=fixture('narrow');value(narrow,{op:'init'});const ndir=workspace(narrow,'workspace'),file=join(ndir,'one.txt');writeFileSync(file,'one');
  const ns=ts(narrow),np=plan('narrow',ndir);np.delegationOrigin.workId='work';
  const dispatches=[{toolCallId:'unknown-file',scopes:[{kind:'file',path:file}]}];
  const release=registerWorkBudget('narrow',{readWork:()=>({budget:{uncertainDispatches:[{toolCallId:'unknown-file',planId:np.planId,declaredScopes:dispatches[0].scopes}],attempts:{}}})});
  try{
    ns.reserve(np,'narrow');const nr=stopped(ns,np,'narrow',['unknown-file']);value(narrow,{op:'settle',plan:facts(np),receipt:nr,dispatches});
    const nc=ns.claimsFor(np);assert.equal(nc.length,1);assert.equal(nc[0].resourceRef,fileResource(file).resourceRef);equalClaims(narrow,ns);
    const next=plan('next',ndir);assert.equal(value(narrow,{op:'reserve',plan:facts(next),host:'next'}).allowed,true);
    assert.equal(value(narrow,{op:'reserve',plan:facts(next),host:'next',scopes:[{kind:'file',path:file}]}).allowed,false);passed++;
    const resolution={tier:'bot_verified',verdict:'effect_observed',evidenceDigest:'probe-digest',policyRef:'policy-7'};
    const options={claimId:nc[0].claimId,claimRevision:nc[0].revision,authorityRef:'host-authorized-policy',proof:'verified_dead',unknownCalls:['unknown-file'],resolution,at};
    const result=value(narrow,{op:'close',plan:facts(np),closure:options});assert.deepEqual(ns.closeClaim(np,options),result);assert.deepEqual(value(narrow,{op:'resolutions',plan:facts(np)}),ns.resolutionsFor(np));passed++;
    const evidence={claimId:nc[0].claimId,claimRevision:nc[0].revision,verdict:'effect_observed',probes:[{kind:'git',ref:'workspace',result:'changed',observedAt:at,digest:'probe-1'}],evidenceDigest:'evidence-1'};
    assert.deepEqual(value(narrow,{op:'record_evidence',evidence}),ns.recordReconciliation(evidence));assert.deepEqual(value(narrow,{op:'evidence',claimId:nc[0].claimId}),ns.reconciliationEvidenceFor(nc[0].claimId));passed++;
  }finally{release();}

  for(const floor of [7,9,12]){const data=fixture(`missing-${floor}`);mkdirSync(join(data,'project-runtime/w/coordination-v2'),{recursive:true});writeFileSync(join(data,'project-runtime/w/coordination-v2/manifest.json'),JSON.stringify({minimumWriterVersion:floor}));assert.equal(native(data,{op:'init'}).code,'execution_resource_store_missing');passed++;}
  const compatible=fixture('missing-8');mkdirSync(join(compatible,'project-runtime/w/coordination-v2'),{recursive:true});writeFileSync(join(compatible,'project-runtime/w/coordination-v2/manifest.json'),' {"minimumWriterVersion":8}');assert.equal(value(compatible,{op:'init'}).revision,0);passed++;

  const wal=fixture('unknown-schema-wal');value(wal,{op:'init'});const dbPath=join(wal,'project-runtime/execution-resources.sqlite');let db=new Database(dbPath);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
  assert.equal(native(wal,{op:'schema_crash'},77).uncheckpointedSchema,4);
  const mainBefore=readFileSync(dbPath),walBefore=readFileSync(`${dbPath}-wal`);assert.equal(mainBefore.readUInt32BE(60),3);
  for(const op of ['init','snapshot']){assert.equal(native(wal,{op}).code,'execution_resource_schema_unsupported');assert.deepEqual(readFileSync(dbPath),mainBefore);assert.deepEqual(readFileSync(`${dbPath}-wal`),walBefore);passed++;}

  const crash=fixture('crashed-owner');value(crash,{op:'init'});const cd=workspace(crash,'workspace'),cp=plan('crash',cd),cs=ts(crash);
  assert.equal(native(crash,{op:'reserve_crash',plan:facts(cp),host:'crashed-process'},77).value.allowed,true);
  assert.equal(value(crash,{op:'reserve',plan:facts(plan('subsequent',cd)),host:'next'}).allowed,false);passed++;
  // No executor was started in this storage fixture; explicitly supply its
  // synthetic stop receipt. A real Host must establish these facts itself.
  const cr=stopped(cs,cp,'crash-recovery');value(crash,{op:'settle',plan:facts(cp),receipt:cr});assert.equal(cs.reserve(plan('subsequent',cd),'next').allowed,true);passed++;

  const race=fixture('race');value(race,{op:'init'});const rd=workspace(race,'workspace');
  const results=await Promise.all(['one','two'].map(async id=>{
    const child=execFile(binary,[],{env:{PATH:'/nonexistent',PEER_NATIVE_CONFORMANCE_ROOT:race},timeout:10_000,maxBuffer:65536},()=>{});
    const output=new Promise<any>((yes,no)=>{let out='';child.stdout!.on('data',v=>out+=v);child.on('error',no);child.on('close',code=>code===0?yes(JSON.parse(out)):no(Error(`race exit ${code}`)));});
    child.stdin!.end(JSON.stringify({op:'reserve',plan:facts(plan(id,rd)),host:id,at}));return output;
  }));
  assert.equal(results.filter(r=>r.ok&&r.value.allowed).length,1);assert.equal(value(race,{op:'snapshot'}).length,1);passed++;
  process.stdout.write(`${JSON.stringify({passed,fixtureRoot:root,coverage:'Real TS/Bun/native schema-3 resource ledger, identity digests, atomic claims, stop/unknown/closure/reconciliation, aliases, two-process race and WAL preservation; no executor or permission authority.'})}\n`);
}finally{for(const store of stores)store.close();}
