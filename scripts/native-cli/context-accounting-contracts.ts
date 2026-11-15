import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createContextAccountingCompactionPipeline} from '../../packages/runtime-core/src/context-accounting-pipeline.ts';
import {CONTEXT_PROJECTION_CONFIG} from '../../packages/runtime-core/src/context-projection.ts';
const definitions=[
 {name:'count verify then drift and degraded subsequent count',window:100,steps:[{fingerprint:'a',count:60,usage:{inputTokens:48,cacheReadTokens:12}},{fingerprint:'b',count:66,usage:{inputTokens:40,cacheReadTokens:10}},{fingerprint:'c',count:70,usage:{inputTokens:55}}]},
 {name:'missing observations retain separate last observation and current count',window:100,steps:[{fingerprint:'a',count:60,usage:{inputTokens:60}},{fingerprint:'b',count:70,usage:null},{fingerprint:'c',count:null,usage:null}]},
 {name:'observed-only never invents capacity from text',window:100,counter:false,steps:[{fingerprint:'a',usage:null},{fingerprint:'b',usage:{inputTokens:60}},{fingerprint:'c',usage:null}]},
 {name:'unknown window retains numeric source with null percent',window:null,steps:[{fingerprint:'a',count:20,usage:{inputTokens:20}}]},
 {name:'failed counter degrades before healthy generation',window:100,steps:[{fingerprint:'a',count:'error',usage:{inputTokens:50}},{fingerprint:'b',count:75,usage:{inputTokens:55}}]},
 {name:'same immutable request observation supersedes a new count',window:100,steps:[{fingerprint:'a',count:60,usage:{inputTokens:60}},{fingerprint:'a',count:70,usage:null}]},
 {name:'compaction supersedes old observations and recounts at new epoch',window:100,steps:[{fingerprint:'a',count:60,usage:{inputTokens:60}},{fingerprint:'b',count:90,compact:true,afterFingerprint:'compacted',recount:30,usage:{inputTokens:30}}]},
 {name:'manual compact does not send or retain old occupancy as current',window:100,steps:[{fingerprint:'a',count:60,usage:{inputTokens:60}},{fingerprint:'b',count:70,command:'manual_compact',compact:true,afterFingerprint:'compacted',recount:null}]},
 {name:'output reserve affects input threshold independently of window',window:100,reserve:20,steps:[{fingerprint:'a',count:70,usage:{inputTokens:70}}]},
 {name:'zero count is not authority',window:100,steps:[{fingerprint:'a',count:0,usage:{inputTokens:0,cacheReadTokens:0}}]},
];
const cases=[];
for(const input of definitions){let step:any;let countIndex=0;let sent=0;const snapshots:any[]=[];
 const pipeline=createContextAccountingCompactionPipeline({identity:{conversationId:'c',modelKey:'provider::model',contentRevision:1},contextWindow:input.window,requiredOutputReserveTokens:input.reserve??0,countCapability:{kind:input.counter===false?'observed_usage_only':'provider_count_api'},driftToleranceRatio:0.02,now:()=>1000,
 buildRequest:(state:string)=>state,fingerprintRequest:(request:string)=>request,
 countRequest:input.counter===false?undefined:()=>{const value=countIndex++===0?step.count:step.recount;if(value==='error')throw Error('synthetic count unavailable');return typeof value==='number'?{inputTokens:value,source:'provider_count_api'}:null;},
 compact:({state}:any)=>({compacted:step.compact===true,state:step.compact?step.afterFingerprint:state}),
 send:async()=>{sent++;return {usage:step.usage}},getUsage:(r:any)=>r.usage,onSnapshot:(s:any)=>snapshots.push(structuredClone(s))});
 const steps=[];for(step of input.steps){countIndex=0;sent=0;snapshots.length=0;const result=await pipeline.execute({state:step.fingerprint,command:step.command});steps.push({...step,expected:{snapshots:structuredClone(snapshots),decision:result.decision,sent,counted:countIndex}});}
 cases.push({...input,steps});
}
const result={schemaVersion:1,config:{triggerRatio:CONTEXT_PROJECTION_CONFIG.triggerRatio,hardRatio:CONTEXT_PROJECTION_CONFIG.hardRatio,driftToleranceRatio:0.02},cases};const path=new URL('../../packages/protocol/contracts/native-cli/context-accounting-native.json',import.meta.url);
const configPath=new URL('../../packages/protocol/contracts/native-cli/context-accounting-config.json',import.meta.url);
if(process.argv.includes('--update')){writeFileSync(path,JSON.stringify(result,null,2)+'\n');writeFileSync(configPath,JSON.stringify(result.config,null,2)+'\n');}else {assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),result);assert.deepEqual(JSON.parse(readFileSync(configPath,'utf8')),result.config);}
console.log(`${cases.length} actual TS context accounting sequences match.`);
