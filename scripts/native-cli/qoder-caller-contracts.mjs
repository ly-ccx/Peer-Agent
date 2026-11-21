// Development reference only. The native CLI never loads this script or Node.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const resource=new URL('../../packages/protocol/contracts/native-cli/qoder-caller.json',import.meta.url);
const data=JSON.parse(readFileSync(resource,'utf8'));
const root=mkdtempSync(join(tmpdir(),'peer-qoder-caller-'));writeFileSync(join(root,'.native-cli-fixture'),'isolated');
// Set all source roots before loading the sender. Catalog lookup is local-only.
process.env.HOME=root;process.env.PEER_AGENT_HOME=root;
for(const name of Object.keys(process.env))if(name.startsWith('QODER_'))delete process.env[name];
process.env.PEER_AGENT_PROVIDER_TRACE='0';
const authUrl=new URL('../../packages/runtime-node/dist/provider-adapters/qoder-local-auth.mjs',import.meta.url);
const actualAuth=await import(authUrl.href);
let prepared=[], lookups=0;
mock.module(authUrl.href,{exports:{...actualAuth,prepareQoderInferRequest:async ({requestBody})=>{
  prepared.push(structuredClone(requestBody));return {url:'https://synthetic.invalid/prepared',headers:{},body:JSON.stringify(requestBody)};
}}});
const catalogUrl=new URL('../../packages/runtime-node/dist/provider-adapters/qoder-model-catalog.mjs',import.meta.url);
const actualCatalog=await import(catalogUrl.href);
mock.module(catalogUrl.href,{exports:{...actualCatalog,getQoderModelMetadata(...args){lookups++;return actualCatalog.getQoderModelMetadata(...args);}}});
const {sendQoderPrivateStream}=await import('../../packages/runtime-node/dist/provider-adapters/qoder-private-adapter.mjs');
const {consumeOpenAIStream}=await import('../../packages/runtime-node/dist/provider-adapters/openai-chat-adapter.mjs');
globalThis.fetch=()=>{throw new Error('unexpected real network in caller contract')};
function normalized(body) {
  const copy=structuredClone(body);const context=copy.chat_task?copy:copy.metadata.context;
  for(const name of ['request_id','request_set_id','chat_record_id','session_id','task_id','is_retry'])delete context[name];
  return copy;
}
for(const [index,c] of data.cases.entries()) {
  const config=join(root,String(index));mkdirSync(join(config,'.auth'),{recursive:true});process.env.QODER_CONFIG_DIR=config;
  if(c.catalog!==null)writeFileSync(join(config,'.auth/models'),JSON.stringify(c.catalog));
  prepared=[];lookups=0;const attempts=[];
  const result=await sendQoderPrivateStream({baseUrl:'https://synthetic.invalid/v1',apiKey:'SYNTHETIC-NOT-SENT',model:c.model,
    messages:[{role:'system',content:'synthetic admitted context'},{role:'user',content:'synthetic input'}],tools:[],
    ...('modelOptions'in c?{modelOptions:c.modelOptions}:{}),modelOptionValues:c.modelOptionValues,maxOutputTokens:c.maxOutputTokens,
    streamId:'synthetic-stream',tracePrivacy:'off',effort:c.effort,
    fetchWithRecovery:async (_url,first,options)=>{
      for(let attempt=0;attempt<3;attempt++) {
        const init=await options.buildInit({attempt,isRetry:attempt>0});
        if(attempt===0)assert.equal(init.body,first.body);
        attempts.push(JSON.parse(init.body));
      }
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"synthetic reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
    },consumeStream:consumeOpenAIStream});
  assert.equal(result.ok,true,c.name);assert.equal(attempts.length,3,c.name);
  assert.equal(lookups,1,'one resolved metadata selection per connection-recovery group');
  const isPrepared=c.expectation.dialect==='prepared';assert.equal(prepared.length,isPrepared?3:0,c.name);
  for(let i=0;i<attempts.length;i++) {
    const body=attempts[i];const context=isPrepared?body:body.metadata.context;
    assert.equal(context.request_id,context.request_set_id);
    assert.match(context.task_id,/^synthetic-stream:[0-9a-f-]{36}$/);
    if(i>0) {const before=isPrepared?attempts[i-1]:attempts[i-1].metadata.context;
      for(const k of ['request_id','session_id','task_id'])assert.notEqual(context[k],before[k]);
      assert.deepEqual(normalized(body),normalized(attempts[0]),'nonidentity body stays stable across physical attempts');
    }
    if(isPrepared) {
      assert.deepEqual(body,prepared[i]);assert.equal(body.is_retry,i>0);
      assert.equal(body.model_config.max_input_tokens,c.expectation.window,c.name);
      assert.equal(body.model_config.contextTier,c.expectation.tier??undefined,c.name);
      assert.equal(body.model_config.is_vl,c.expectation.vision,c.name);
      assert.equal(body.parameters.max_tokens,c.maxOutputTokens,c.name);
    } else {assert.equal(body.model,c.model);assert.equal(body.max_tokens,c.maxOutputTokens);}
  }
  const actual={modelConfig:attempts[0].model_config??null,parameters:attempts[0].parameters??null};
  if(process.argv.includes('--write'))c.expected=actual;else assert.deepEqual(actual,c.expected,c.name);
}
if(process.argv.includes('--write'))writeFileSync(resource,JSON.stringify(data,null,2)+'\n');
console.log(JSON.stringify({ok:true,cases:data.cases.length,attempts:data.cases.length*3,root,scope:data.provenance.scope}));
