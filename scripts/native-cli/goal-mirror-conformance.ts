import {strict as assert} from 'node:assert';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {createGoalPlanStore} from '../../packages/runtime-node/src/goal-plan-store.mjs';
import {setJsonWriteObserver} from '../../packages/runtime-node/src/goal-plan-files.mjs';
const binary=resolve(process.argv[2]??'target/debug/examples/goal-mirror-conformance');
const root=mkdtempSync(join(tmpdir(),'peer-native-goal-mirror-'));
const fixture=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/goal-execution-facts.json',import.meta.url),'utf8'));
const base=fixture.cases.find((c:any)=>c.name==='delegated current identity').raw;
const closure=fixture.cases.find((c:any)=>c.name==='policy resolution closure mirror').raw.delegationOrigin.executionClaimClosure;
const identity=closure.execution;const control={operationId:'control',sessionId:'s',planId:'p',revision:1,phase:'recorded',kind:'pause',expectedExecution:identity,future:{keep:true}};
let checked=0;
function setup(name:string,raw:any=base){const home=join(root,name);mkdirSync(join(home,'goal-plans'),{recursive:true});writeFileSync(join(home,'.native-cli-fixture'),'isolated');writeFileSync(join(home,'goal-plans/p.json'),JSON.stringify(raw));writeFileSync(join(home,'goal-plans/index.jsonl'),JSON.stringify({planId:'p',title:'fixture',conversationId:'c',status:raw.status,version:raw.version,createdAt:raw.createdAt,updatedAt:raw.updatedAt,future:{indexKeep:true}})+'\n');return home;}
function native(home:string,input:any={field:'closure',fact:closure}){const r=spawnSync(binary,[],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,PATH:'/nonexistent',PEER_NATIVE_CONFORMANCE_ROOT:home}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
for(const [field,fact] of [['control',control],['closure',closure]] as const){
 const home=setup(field);const before=readFileSync(join(home,'goal-plans/p.json'));
 const result=native(home,{field,fact});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.changed,true);
 const key=field==='control'?'executionControl':'executionClaimClosure';
 const ts=createGoalPlanStore({storeDir:join(home,'goal-plans')});assert.deepEqual(ts.getPlan('p').delegationOrigin[key],fact);
 const raw=JSON.parse(readFileSync(join(home,'goal-plans/p.json'),'utf8'));assert.deepEqual(raw.future,base.future);assert.equal(raw.version,2);assert.notDeepEqual(readFileSync(join(home,'goal-plans/p.json')),before);
 const events=readFileSync(join(home,'goal-plans/.changes.jsonl'));const revision=result.sourceRevision;
 const replay=native(home,{field,fact});assert.equal(replay.ok,true);assert.equal(replay.changed,false);assert.equal(replay.sourceRevision,revision);assert.deepEqual(readFileSync(join(home,'goal-plans/.changes.jsonl')),events);
 ts.revisePlan('p',{goal:'later TS mutation'});assert.deepEqual(ts.getPlan('p').delegationOrigin[key],fact);assert.equal(native(home,{field,fact}).ok,true);
 checked+=4;
}
const interrupted=setup('interrupted');assert.equal(native(interrupted,{field:'closure',fact:closure,interrupt:true}).code,'STORE_COMMIT_UNCERTAIN');
assert.equal(JSON.parse(readFileSync(join(interrupted,'goal-plans/p.json'),'utf8')).version,2);assert.equal(JSON.parse(readFileSync(join(interrupted,'goal-plans/index.jsonl'),'utf8')).version,1);
assert.equal(native(interrupted).ok,true);assert.equal(JSON.parse(readFileSync(join(interrupted,'goal-plans/index.jsonl'),'utf8')).version,2);assert.equal(JSON.parse(readFileSync(join(interrupted,'goal-plans/p.json'),'utf8')).version,2);checked++;
const stale=setup('stale');assert.equal(native(stale,{field:'closure',fact:closure,expectedSourceRevision:'stale'}).code,'GOAL_SOURCE_CHANGED');checked++;
const foreign=setup('foreign');const foreignBefore=readFileSync(join(foreign,'goal-plans/p.json'));assert.equal(native(foreign,{field:'closure',fact:{...closure,execution:{...identity,executionEpoch:'other'}}}).code,'execution_revision_stale');assert.deepEqual(readFileSync(join(foreign,'goal-plans/p.json')),foreignBefore);checked++;
const large=setup('large',{...base,body:'x'.repeat(8*1024*1024)});const largeBefore=readFileSync(join(large,'goal-plans/p.json'));assert.equal(native(large).code,'GOAL_SOURCE_LIMIT');assert.deepEqual(readFileSync(join(large,'goal-plans/p.json')),largeBefore);checked++;
const side=setup('sidecar');mkdirSync(join(side,'goal-plans/runner-progress'));const patch={planId:'p',status:'paused',updatedAt:'2026-11-14T03:30:00.000Z',runner:{status:'paused',updatedAt:'2026-11-14T03:30:00.000Z',turnCount:4}};writeFileSync(join(side,'goal-plans/runner-progress/p.json'),JSON.stringify(patch));const sideBefore=readFileSync(join(side,'goal-plans/runner-progress/p.json'));assert.equal(native(side).ok,true);assert.equal(createGoalPlanStore({storeDir:join(side,'goal-plans')}).getPlan('p').runner.turnCount,4);assert.deepEqual(readFileSync(join(side,'goal-plans/runner-progress/p.json')),sideBefore);checked++;
// Contend at the actual TS body-write observer while its public mutator holds
// the shared root. The native process must reject before changing any Goal.
const tsFirst=setup('ts-held');const ts=createGoalPlanStore({storeDir:join(tsFirst,'goal-plans')});let observed=false;
setJsonWriteObserver(()=>{if(!observed){observed=true;assert.equal(native(tsFirst).code,'STORE_LOCK_BUSY');}});
try{ts.revisePlan('p',{goal:'TS holds root'});}finally{setJsonWriteObserver(null);}assert.equal(observed,true);assert.equal(native(tsFirst).ok,true);checked++;
const nativeFirst=setup('native-held');const child=spawn(binary,[],{env:{...process.env,PATH:'/nonexistent',PEER_NATIVE_CONFORMANCE_ROOT:nativeFirst},stdio:['pipe','pipe','pipe']});let out='';let err='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',s=>err+=s);child.stdin.end(JSON.stringify({holdMs:1200}));
await new Promise<void>((resolve,reject)=>{child.stdout.on('data',s=>{out+=s;if(out.includes('"phase":"locked"'))resolve();});child.on('error',reject);child.on('exit',code=>{if(!out.includes('"phase":"locked"'))reject(Error(`holder exited ${code}: ${err}`));});});
const tsWaiting=createGoalPlanStore({storeDir:join(nativeFirst,'goal-plans')});assert.throws(()=>tsWaiting.revisePlan('p',{goal:'blocked'}),{code:'STORE_LOCK_BUSY'});
await new Promise<void>((resolve,reject)=>child.on('close',code=>code===0?resolve():reject(Error(err))));tsWaiting.revisePlan('p',{goal:'later TS task'});assert.equal(tsWaiting.getPlan('p').goal,'later TS task');checked++;
console.log(`${checked} actual TS/native Goal mirror, shared-root contention and interrupted-index cases passed: ${root}`);
