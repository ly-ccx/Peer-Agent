import { strict as assert } from 'node:assert';
import { readFileSync,writeFileSync } from 'node:fs';
import { admitCoordinationDecision } from '../../packages/runtime-node/src/project-agent/coordination-kernel.mjs';
import { admitIntentAssessment,admitIntentClosure } from '../../packages/runtime-node/src/project-agent/intent-coordination-kernel.mjs';
const kernels=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/coordination-kernels.json',import.meta.url),'utf8'));
const file=new URL('../../packages/protocol/contracts/native-cli/coordination-admissions.json',import.meta.url);
const at='2026-11-14T04:00:00.000Z';
const cases:any[]=[];
function add(name:string,index:number,method:string,input:any,host:any){
 const state=kernels.cases[index].previous;const fn=({decision:admitCoordinationDecision,assessment:admitIntentAssessment,closure:admitIntentClosure} as any)[method];
 const expected=fn(state,input,host);cases.push({name,stateCase:index,method,input,host,expected});
}
for(const [i,c] of kernels.cases.entries()){
 const e=c.entry;let method:string,input:any;
 if(e.kind==='coordination_decision'){
  method='decision';input={...e.receipt};for(const k of ['digest','goalRevision','mandateId'])delete input[k];
 }else if(e.kind==='intent_assessed'){method='assessment';input=e.assessment;}
 else if(e.kind==='intent_closed'){method='closure';const r=e.receipt;input={operationId:r.operationId,workId:r.workId,expectedWorkRevision:r.workRevision-1,expectedGoalRevision:r.goalRevision,lifecycle:r.lifecycle};}
 else continue;
 const host={holdsLease:true,workspaceId:'w',parentConversationId:'bot',currentInputIds:input.sourceInputIds??[],eventIds:input.sourceEventIds??[],now:at,pendingObligations:false,verifiedGoalRevision:1,reviewRef:'review',pendingManagedSessions:false};
 add(c.name,i,method,input,host);
 add(`${c.name}: lost lease`,i,method,input,{...host,holdsLease:false});
 add(`${c.name}: foreign workspace`,i,method,input,{...host,workspaceId:'foreign'});
 add(`${c.name}: conflicting operation`,i,method,{...input,operationId:'another-operation'},host);
 if(method==='decision'){
  add(`${c.name}: forged host authority`,i,method,{...input,holdsLease:true},host);
  add(`${c.name}: no admitted source`,i,method,input,{...host,currentInputIds:[],eventIds:[]});
  add(`${c.name}: stale goal revision`,i,method,{...input,expectedRevision:input.expectedRevision+1},host);
 }else if(method==='assessment'){
  add(`${c.name}: incomplete coverage`,i,method,{...input,coverage:[]},host);
  add(`${c.name}: stale work revision`,i,method,{...input,expectedWorkRevision:input.expectedWorkRevision+1},host);
  add(`${c.name}: missing source`,i,method,input,{...host,currentInputIds:[],eventIds:[]});
 }else{
  add(`${c.name}: review pending`,i,method,input,{...host,pendingObligations:true});
  add(`${c.name}: wrong review`,i,method,input,{...host,reviewRef:'other-review'});
 }
}
const fixture={schemaVersion:1,source:'actual TS coordination/intent pure admission; canonical Host fact input seam',cases};
if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(fixture,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),JSON.parse(JSON.stringify(fixture)));
console.log(`${cases.length} actual TS coordination/intent admissions match.`);
