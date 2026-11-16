// Actual host request encoders and refresh forms; no network or OS credentials.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {refreshChatGptOAuthTokens} from '../../packages/runtime-node/src/chatgpt-oauth.ts';
import {refreshGoogleAccessToken} from '../../packages/runtime-node/src/llm-oauth/google-oauth.mjs';
import {resolveChannel} from '../../apps/desktop/electron/main/provider-channels.mjs';
import {createChatGptResponsesProvider} from '../../packages/runtime-node/src/chatgpt-responses-provider.ts';
import {SUBSCRIPTION_CATALOG,resolveSubscriptionContextWindow} from '../../apps/desktop/electron/main/provider-adapters/openai-model-catalog.mjs';
const now=1800000000000;
const clock=Date.now; Date.now=()=>now;
const literal=(source:string,name:string)=>{const value=source.match(new RegExp(`const ${name} = '([^']+)'`))?.[1]; assert.ok(value,name); return value;};
const providers:any[]=[]; const cases:any[]=[];const requests:any[]=[];const contextCases:any[]=[];
try {
 for(const [authMethod,channelId,path,refresh] of [
  ['oauth_chatgpt','openai','../../packages/runtime-node/src/chatgpt-oauth.ts',refreshChatGptOAuthTokens],
  ['oauth_google','google-ai','../../packages/runtime-node/src/llm-oauth/google-oauth.mjs',refreshGoogleAccessToken],
 ] as const) {
  const source=readFileSync(new URL(path,import.meta.url),'utf8');
  const resolved=resolveChannel({channelId,authMethod,model:'fixture-model',baseUrl:'https://untrusted.invalid',apiKey:'synthetic-access',accountId:'fixture-account'});
  providers.push({authMethod,channelId,wire:resolved.wire,baseUrl:resolved.baseUrl,tokenUrl:literal(source,'TOKEN_URL'),clientId:literal(source,authMethod==='oauth_google'?'DEFAULT_CLIENT_ID':'CLIENT_ID'),...(authMethod==='oauth_google'?{clientSecret:literal(source,'DEFAULT_CLIENT_SECRET')}:{})});
  for(const variant of ['rotate','retain','default-expiry']) {
   const tokens={access:'synthetic-old-access',refresh:'synthetic-old-refresh',expires:now-1,accountId:'fixture-account'};
   const response:any={access_token:'synthetic-new-access',token_type:'Bearer',...(variant!=='default-expiry'?{expires_in:7200}:{}),...(variant==='rotate'?{refresh_token:'synthetic-new-refresh'}:{})};
   let captured:any;
   const fetchImpl:any=async(url:any,options:any)=>{captured={url:String(url),method:options.method,headers:options.headers,form:Object.fromEntries(new URLSearchParams(options.body))};return new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}});};
   const next=authMethod==='oauth_google'?await refresh(tokens,{fetchImpl}):await refresh(tokens,fetchImpl);
   cases.push({authMethod,variant,tokens,response,request:captured,expected:next});
  }
 }
 const tools=[{name:'read_file',description:'Read a file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}];
 for(const effort of ['off','default','high','xhigh','max']) {
  let captured:any;
  const tokens={access:'synthetic-access',expires:now+3600000,accountId:'fixture-account'};
  const p=createChatGptResponsesProvider({baseUrl:providers[0].baseUrl,tokens,fetch:async(url,options)=>{
   captured={url:String(url),headers:Object.fromEntries(new Headers(options?.headers)),body:JSON.parse(String(options?.body))};
   return new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const messages=[{role:'system',content:'shared system'},{role:'user',content:'hello'}];
  // Off is normalized to absence by the CLI selection contract (ADR28).
  await p.stream({model:SUBSCRIPTION_CATALOG[0].id,messages,tools,reasoningEffort:effort==='off'?undefined:effort,fastMode:effort==='max',signal:new AbortController().signal} as any);
  requests.push({effort,input:{model:SUBSCRIPTION_CATALOG[0].id,system:'shared system',messages:messages.slice(1),tools:tools.map(f=>({type:'function',function:f})),options:{authMethod:'oauth_chatgpt',effort,supportsReasoning:true,omitMaxOutputTokens:true,maxOutputTokens:16384,fastMode:effort==='max'}},expected:captured});
 }
 providers[0].headers={originator:requests[0].expected.headers.originator};
 for(const model of SUBSCRIPTION_CATALOG) for(const values of [{},{contextTier:1000000},{contextTier:400000},{contextTier:'1000000'},{contextTier:false},{contextTier:'unknown'},{unadmitted:{system:'bad'}}]) contextCases.push({model:model.id,values,expected:resolveSubscriptionContextWindow(model,values)});
}finally {Date.now=clock;}
for(const [name,data] of Object.entries({'model-oauth':{schemaVersion:1,now,providers,cases,requests,contextCases},'model-oauth-registry':{schemaVersion:1,providers,subscriptionCatalog:SUBSCRIPTION_CATALOG}})) {
 const file=new URL(`../../packages/protocol/contracts/native-cli/${name}.json`,import.meta.url);
 if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(data,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),data);
}
console.log(`${providers.length} pinned model OAuth providers / ${cases.length} actual TS refresh forms match.`);
