// Real shared RuntimeUsageAccounting, not a second arithmetic implementation.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRuntimeUsageAccounting} from '../../packages/runtime-core/src/runtime-usage-accounting.ts';
const sequences=[
 {name:'new turn',steps:[]},
 {name:'three request capacity versus billing',steps:[30,40,50].map((inputTokens,i)=>({usage:{inputTokens,outputTokens:i+2,cacheReadTokens:5,totalTokens:999999},metadata:{requestFingerprint:`request-${i+1}`}}))},
 {name:'null failure and later observation',steps:[{usage:{inputTokens:10}},{usage:null},{usage:{outputTokens:3}},{usage:null}]},
 {name:'auxiliary summaries and null summary failure',steps:[{usage:{inputTokens:50},metadata:{requestFingerprint:'agent-request'}},{usage:{inputTokens:20,outputTokens:5},metadata:{requestPurpose:'compaction_summary',capacityBearing:false}},{usage:null,metadata:{requestPurpose:'compaction_summary',capacityBearing:false}}]},
 {name:'summary-only turn',steps:[{usage:{inputTokens:20,outputTokens:5},metadata:{requestPurpose:'compaction_summary',capacityBearing:false}}]},
 {name:'zero usage leaves last observation',steps:[{usage:{inputTokens:10}},{usage:{}},{usage:{inputTokens:0,outputTokens:0,totalTokens:100}},{usage:null}]},
 {name:'cache writes and empty fingerprint',steps:[{usage:{inputTokens:1,outputTokens:2,cacheReadTokens:3,cacheWriteTokens:4},metadata:{requestFingerprint:''}},{usage:{cacheReadTokens:7,cacheWriteTokens:8},metadata:{requestFingerprint:'  '}}]},
];
const cases=sequences.map(({name,steps})=>{
 const accounting=createRuntimeUsageAccounting();const initial=accounting.snapshot();
 const expected=steps.map((step:any)=>accounting.observeProviderRequest(step.usage,step.metadata));
 return {name,steps,initial,expected};
});
const result={version:1,cases};const file=new URL('../../packages/protocol/contracts/native-cli/usage-accounting.json',import.meta.url);
if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(result,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),result);
console.log(`${cases.length} actual TS request/turn usage sequences, ${cases.reduce((n,c)=>n+c.steps.length,0)} observations match.`);
