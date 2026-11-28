// Actual existing TS count Adapters; this script is never a native sidecar.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {countAnthropicCanonicalRequest,countGeminiCanonicalRequest} from '../../packages/runtime-node/src/provider-adapters/context-count-adapter.mjs';
const wires=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/model-wires.json',import.meta.url),'utf8'));
const cases=[];
for(const c of wires.cases){
 if(!['anthropic-messages','gemini'].includes(c.wire)||!/^.*\/history-(0|1|3)\/generation-(0|7|14|19|23)$/.test(c.name))continue;
 const input=structuredClone(c.input);if(input.authMethod&&input.authMethod!=='api_key')continue;
 const request=structuredClone(input);let countBody:any;
 const fetchImpl=async(_url:any,init:any)=>{countBody=JSON.parse(init.body);return {ok:true,json:async()=>c.wire==='gemini'?{totalTokens:123}:{input_tokens:123}}};
 if(c.wire==='anthropic-messages'){
  request.tools=request.tools.map((t:any)=>({name:t.function.name,description:t.function.description,input_schema:t.function.parameters}));
  await countAnthropicCanonicalRequest({...request,baseUrl:'https://count.invalid',fetchImpl});
 }else await countGeminiCanonicalRequest({...request,messages:[{role:'system',content:request.system},...request.messages],baseUrl:'https://count.invalid/v1beta',fetchImpl});
 cases.push({name:c.name,wire:c.wire,input,expected:countBody});
}
const result={schemaVersion:1,cases};const file=new URL('../../packages/protocol/contracts/native-cli/model-counts.json',import.meta.url);
if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(result,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),result);
console.log(`${cases.length} actual TS count Adapter fixtures match.`);
