import { strict as assert } from 'node:assert';
import { readFileSync,writeFileSync } from 'node:fs';
import { planHistoryResumption,historyCheckpointBindings } from '../../packages/runtime-node/src/project-agent/history-resumption.mjs';
const file=new URL('../../packages/protocol/contracts/native-cli/history-resumption.json',import.meta.url);
const cases:any[]=[];
const work={workId:'work',state:'retry_wait',anchorInputIds:['input'],sessionIds:[],checkpointRef:'checkpoint',budget:{},recovery:{retryable:true}};
const checkpoint={job:{workId:'work',userInputs:[{inputId:'input'}]},outcome:{rounds:[]}};
function add(name:string,patch:any={},options:any={}){
 const current={...structuredClone(work),...patch};
 const state={revision:1,works:{work:current,...options.works},deliveries:options.deliveries??{},transitions:options.transitions??{},...options.state};
 const inspection={conflicts:options.conflicts??[]};const checkpoints=options.checkpoints??{checkpoint};const safeSessions=options.safeSessions??[];
 const ports={readCheckpoint:(_id:string,ref:string)=>checkpoints[ref],sessionSafe:(id:string)=>safeSessions.includes(id)};
 let expected:any,error:string|undefined;try{expected=planHistoryResumption(state,inspection,ports);}catch(e){error=(e as Error).message;}
 cases.push({name,state,inspection,checkpoints,safeSessions,bindings:historyCheckpointBindings(current),...(error?{error}:{expected})});
}
add('verified retry checkpoint');add('terminal retained',{state:'delivered'});add('running without recovery held',{state:'running'});
add('non-work identity conflict',{}, {conflicts:[{bucket:'events',id:'event'}]});add('work identity conflict',{}, {conflicts:[{bucket:'works',id:'work',baseline:work}]});
add('anchor shared by old work',{}, {works:{other:{...work,workId:'other'}}});
add('prepared delivery pending',{}, {deliveries:{reply:{state:'prepared',message:{meta:{workId:'work'}}}}});
add('unbound prepared delivery',{}, {deliveries:{reply:{state:'prepared',message:{meta:{}}}}});
add('transition pending',{}, {transitions:{control:{workId:'work',phase:'stopping'}}});
add('uncertain dispatch',{budget:{uncertainDispatches:[{toolCallId:'unknown'}]}});add('pending attempt',{budget:{attempts:{a:{pendingTools:[{toolCallId:'unknown'}],checkpointRef:'attempt'}}}});
add('previous unknown recovery',{historyRecovery:{previousRecovery:{failureKind:'execution_outcome_unknown'},previousState:'retry_wait'}});
add('unconfirmed budget',{budget:{unconfirmedUsd:0.1}});add('work paused',{stopScope:'work'});add('waiting user',{state:'waiting_user'});
add('unsafe child',{sessionIds:['child']});add('safe child',{sessionIds:['child']},{safeSessions:['child']});
add('checkpoint missing',{}, {checkpoints:{}});add('checkpoint wrong inputs',{}, {checkpoints:{checkpoint:{...checkpoint,job:{workId:'work',userInputs:[]}}}});
add('checkpoint unknown result',{}, {checkpoints:{checkpoint:{...checkpoint,outcome:{rounds:[{toolCalls:[{result:null}]}]}}}});
add('checkpoint unknown error',{}, {checkpoints:{checkpoint:{...checkpoint,outcome:{rounds:[{toolCalls:[{result:{error:'shell_outcome_unknown'}}]}]}}}});
add('completed call needs provider checkpoint',{}, {checkpoints:{checkpoint:{...checkpoint,outcome:{rounds:[{toolCalls:[{result:{status:'succeeded'}}]}]}}}});
add('provider checkpoint present',{}, {checkpoints:{checkpoint:{...checkpoint,outcome:{providerCheckpoint:{format:'fixture-only'},rounds:[{toolCalls:[{result:{status:'succeeded'}}]}]}}}});
add('native checkpoint reference',{nativeCheckpointRef:'native',budget:{toolCalls:1}},{checkpoints:{checkpoint,native:{format:'fixture-only'}}});
add('failed not retryable',{recovery:{retryable:false}},{checkpoints:{checkpoint:{...checkpoint,outcome:{failed:true,rounds:[]}}}});
add('stopped checkpoint',{}, {checkpoints:{checkpoint:{...checkpoint,outcome:{stopped:true,rounds:[]}}}});
add('reply stop',{stopScope:'reply'});add('already resumed work omitted',{}, {state:{lastRecovery:{executionBlocked:false}}});
add('previously held work revisited',{historyRecovery:{disposition:'held',previousState:'retry_wait'}},{state:{lastRecovery:{executionBlocked:false}}});
const fixture={schemaVersion:1,source:'actual TS planHistoryResumption/historyCheckpointBindings over explicit synthetic Host ports',cases};
if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(fixture,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),JSON.parse(JSON.stringify(fixture)));
console.log(`${cases.length} actual TS history resumption plans match.`);
