// Actual legacy CLI capability/Provider oracle, never a native engine sidecar.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNodeSearchAggregateProvider,NODE_SEARCH_AGGREGATE_CAPABILITY_MANIFESTS,__testables} from '../../packages/runtime-node/src/search-aggregate-provider.ts';
const root=mkdtempSync(join(tmpdir(),'peer-batch-oracle-'));const workspace=join(root,'workspace');mkdirSync(workspace);
const files={'src/shared.txt':'alpha beta\nalpha only\n','src/other.txt':'beta only\n','src/É.txt':'ALPHA\r\n中文针\n','../outside/other.txt':'alpha outside\n','cap.txt':Array.from({length:600},(_,i)=>`capneedle ${i+1}`).join('\n')+'\n'};
for(const [path,body]of Object.entries(files)){const absolute=join(workspace,path);mkdirSync(join(absolute,'..'),{recursive:true});writeFileSync(absolute,body);}
const inputs=[
 ['overlap',{queries:[{id:'alpha',query:'alpha',path:'src'},{id:'beta',query:'beta',path:'src'}],max_concurrency:2}],
 ['duplicates',{queries:[{query:'alpha',path:'src'},{query:'alpha',path:'src'}],dedupe:false,max_concurrency:8}],
 ['trim',{queries:[{id:' x ',label:' label ',query:' alpha ',path:' src ',max_results:1.8}],max_concurrency:0}],
 ['unicode',{queries:[{query:'中文针',path:'src'},{query:'ALPHA',path:'src',case_sensitive:true}]}],
 ['outside',{queries:[{query:'alpha',path:'../outside'}]}],
 ['partial',{queries:[{query:'alpha',path:'src'},{query:'alpha',path:'missing'}]}],
 ['all-failed',{queries:[{query:'alpha',path:'missing'}]}],
 ['cap',{queries:Array.from({length:3},(_,i)=>({id:`cap-${i}`,query:'capneedle',path:'cap.txt',max_results:200})),dedupe:false}],
 ['invalid-empty',{queries:[]}],['duplicate-id',{queries:[{id:'same',query:'alpha'},{id:'same',query:'beta'}]}],
];
const provider=createNodeSearchAggregateProvider({workspaceRoot:workspace,now:()=> '2026-11-17T00:00:00.000Z',idFactory:()=> 'fixture'});const cases=[];
for(const [name,input]of inputs){const r=await provider.execute({capabilityId:'local.search.aggregate',toolCall:{toolCallId:'batch',capabilityId:'local.search.aggregate',input},input},{runId:'run',sessionId:'session',workspace:{root:workspace}});cases.push({name,input,status:r.status,output:r.output??null,error:r.error?.code??null,legacyGrantDecision:r.permissionGrant?.decision??null});}
// Original cap is checked before dedupe, and cap exit bypasses final sorting.
const lanes=[{id:'first',matches:Array.from({length:500},(_,i)=>({path:`z-${i}`,line:1,text:'x'}))},{id:'later',matches:[{path:'z-0',line:1,text:'x'},{path:'a',line:1,text:'x'}]}];
const cap=__testables.aggregateMatches(lanes,true);assert.equal(cap.matches.length,500);assert.equal(cap.truncated,true);assert.equal(cap.matches[0].hitCount,1);assert.equal(cap.matches[0].path,'z-0');
const result={schemaVersion:1,manifest:NODE_SEARCH_AGGREGATE_CAPABILITY_MANIFESTS[0],files,cases,cap:{matches:500,truncated:cap.truncated,first:cap.matches[0],last:cap.matches.at(-1)},native:{workers:2,lanes:8,laneResultBytes:262144,resultBytes:4194304,errorDelta:'OS-specific missing-path errorMessage is preserved in TS observations; native uses stable file_unavailable/file_parent_unavailable codes. Original top-level statuses are mapped to native success/failed/cancelled. A failed read does not retroactively revoke an actually issued native Grant; the legacy grant decision is preserved separately.'}};
// OS error strings include the owned root; record a symbolic root for repeatable
// comparisons while retaining the exact raw provider observation separately.
writeFileSync(join(root,'raw.json'),JSON.stringify(result,null,2)+'\n');
const stable=JSON.parse(JSON.stringify(result).replaceAll(root,'<fixture>'));
const file=new URL('../../packages/protocol/contracts/native-cli/batch-search.json',import.meta.url);
if(process.argv.includes('--write'))writeFileSync(file,JSON.stringify(stable,null,2)+'\n');else assert.deepEqual(stable,JSON.parse(readFileSync(file,'utf8')));
console.log(JSON.stringify({ok:true,cases:cases.length,root,scope:'Actual existing TS batch Provider over owned files plus original cap/dedupe control vector; no native authorization acceptance.'}));
