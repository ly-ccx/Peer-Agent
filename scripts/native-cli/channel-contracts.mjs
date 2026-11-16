// Build-time conformance reference only. Cargo embeds the resulting data.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {listChannelDescriptors, resolveChannel, validateCustomHeaders, OPENCODE_GO_SESSION_HEADER} from '../../apps/desktop/electron/main/provider-channels.mjs';
import {encodeAnthropicMessagesRequest, encodeGeminiGenerateContentRequest} from '../../packages/runtime-node/src/provider-encoders/index.mjs';
import {encodeOpenAIChatRequest} from '../../apps/desktop/electron/main/provider-encoders/request-encoder.mjs';
import {encodeOpenAIResponsesRequest} from '../../apps/desktop/electron/main/provider-encoders/responses-encoder.mjs';

const source=readFileSync(new URL('../../apps/desktop/electron/main/provider-channels.mjs',import.meta.url),'utf8');
const protectedDeclaration=source.match(/const PROTECTED_HEADER_NAMES = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(protectedDeclaration,'explicit protected-header declaration');
const protectedHeaders=[...protectedDeclaration[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);
for(const name of protectedHeaders) assert.throws(()=>validateCustomHeaders({[name]:'forbidden'}));
const descriptors=listChannelDescriptors().map(d=>({id:d.id,defaultWire:d.defaultWire,allowedWires:d.allowedWires,defaults:d.defaults,authMethods:d.authMethods,headers:d.headers??{},capabilities:d.capabilities}));
const system='shared system';
const messages=[{role:'user',content:'hello'}];
const tools=[{type:'function',function:{name:'read_file',description:'Read a file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}];
const cases=[];
function capture(name, channel, model, selected) {
 const flat={...channel,...model};
 if(flat.supportsPromptCaching==null) delete flat.supportsPromptCaching;
 const resolved=resolveChannel(flat);
 const wire=resolved.wire;
 const options={effort:selected.reasoningEffort,supportsReasoning:resolved.supportsReasoning,reasoningParamStyle:resolved.reasoningParamStyle,reasoningEffortMap:resolved.reasoningEffortMap,promptCaching:resolved.supportsPromptCaching,maxOutputTokens:flat.maxOutputTokens,fastMode:selected.fastMode};
 const input={model:model.model,messages:structuredClone(messages),tools:structuredClone(tools),...options};
 let request;
 if(wire==='openai-chat') request=encodeOpenAIChatRequest({...input,messages:[{role:'system',content:system},...input.messages]});
 else if(wire==='openai-responses') request={...encodeOpenAIResponsesRequest({...input,messages:[{role:'system',content:system},...input.messages]}),tool_choice:'auto',parallel_tool_calls:true};
 else if(wire==='anthropic-messages') request=encodeAnthropicMessagesRequest({...input,system,tools:input.tools.map(t=>({name:t.function.name,description:t.function.description,input_schema:t.function.parameters}))});
 else request=encodeGeminiGenerateContentRequest({...input,messages:[{role:'system',content:system},...input.messages]});
 const headers=Object.fromEntries([...new Headers(resolved.headers)].filter(([k])=>!['authorization','x-api-key','content-type'].includes(k)));
 cases.push({name,config:{version:2,channels:[channel],models:[model]},selected,expected:{wire,endpoint:resolved.endpoint,options,headers,request}});
}
for(const d of descriptors.filter(d=>d.authMethods.api_key&&d.id!=='opencode-go')) {
 for(const wire of d.allowedWires) for(const variant of ['default','enabled','disabled','mapped','null-cache','mapped-off','unmapped','case-headers','inherited']) {
  const channel={id:'group',provider:d.id==='anthropic'?'anthropic':'openai',channelId:d.id,authMethod:'api_key'};
  if(variant!=='default') channel.baseUrl='https://fixture.invalid/root/';
  if(wire!==d.defaultWire) channel.wireOverride=wire;
  const model={id:'group::model',groupId:'group',model:d.defaults.model};
  if(variant==='enabled') Object.assign(model,{supportsReasoning:true,maxOutputTokens:1234.8,supportsPromptCaching:true});
  if(variant==='disabled') Object.assign(model,{supportsReasoning:false,maxOutputTokens:0,supportsPromptCaching:false});
  if(variant==='mapped') Object.assign(model,{supportsReasoning:true,maxOutputTokens:4096,reasoningParamStyle:wire==='anthropic-messages'?'anthropic-enabled-budget':'openai-effort',reasoningEffortMap:{' high ':' low ',medium:700,invalid:false,blank:' '},customHeaders:{'X-Native-Fixture':'opaque', 'User-Agent':'fixture-agent'}});
  if(variant==='null-cache') Object.assign(model,{supportsPromptCaching:null});
  if(variant==='mapped-off') Object.assign(model,{supportsReasoning:true,reasoningParamStyle:'openai-effort',reasoningEffortMap:{off:'none',high:'high'}});
  if(variant==='unmapped') Object.assign(model,{supportsReasoning:true,reasoningEffortMap:{low:2000}});
  if(variant==='case-headers') Object.assign(model,{customHeaders:{'user-agent':'lowercase-agent','X-Fixture':'one','x-fixture':'two','Accept':'application/custom'}});
  if(variant==='inherited') { Object.assign(channel,{supportsReasoning:false,supportsPromptCaching:false,maxOutputTokens:7000,customHeaders:{'X-Channel':'replaced'}}); Object.assign(model,{supportsReasoning:true,maxOutputTokens:1000,customHeaders:{'X-Model':'only'}}); }
  const selected={providerId:'group',modelProviderId:model.id,modelId:model.model,family:channel.provider,reasoningEffort:['disabled','mapped-off'].includes(variant)?'off':'high',fastMode:wire==='openai-responses'&&variant==='enabled'};
  capture(`${d.id}/${wire}/${variant}`,channel,model,selected);
 }
}
// Freeze the current TS resolver's profile outputs rather than copying its
// evolving model declarations into a second hand-maintained Rust table.
const declaration=source.match(/const OPENCODE_GO_MODEL_REASONING = \{([\s\S]*?)\n\};/);
assert.ok(declaration,'explicit Go model declarations');
const names=[...new Set([...declaration[1].matchAll(/^\s*(?:'([^']+)'|(\w+)):\s*\{/gm)].map(m=>m[1]??m[2]))];
const sessionId='fixture-go-session';
const goProfiles=Object.fromEntries(names.map(model=>[model,resolveChannel({channelId:'opencode-go',model,sessionId}).capabilities.reasoning]));
const goDefaults=Object.fromEntries(['openai-chat','openai-responses','anthropic-messages'].map(wireOverride=>[wireOverride,resolveChannel({channelId:'opencode-go',model:'unknown-model',wireOverride,sessionId}).capabilities.reasoning]));
const goAnthropicHeaders=Object.fromEntries(Object.entries(resolveChannel({channelId:'opencode-go',model:'claude-test',sessionId}).headers).filter(([k])=>['user-agent','x-app','anthropic-beta'].includes(k.toLowerCase())));
const goRoutingModels=[...names,' Claude-Opus-4.8 ','MiniMax-M3','anthropic/model','Qwen3.8-new','vendor/qwen3-next','unknown-model','gpt-luna-custom','not-luna-suffix'];
for(const modelName of goRoutingModels) for(const effort of ['off','default','max']) {
 const channel={id:'group',provider:'openai',channelId:'opencode-go',authMethod:'api_key',sessionId};
 const model={id:'group::model',groupId:'group',model:modelName};
 const selected={providerId:'group',modelProviderId:model.id,modelId:modelName,family:'openai',reasoningEffort:effort};
 capture(`opencode-go/${modelName}/${effort}`,channel,model,selected);
}
for(const channelId of ['opencode-go','opencode-go-openai','opencode-go-anthropic']) for(const wireOverride of ['openai-chat','openai-responses','anthropic-messages']) for(const variant of ['enabled','synced','legacy','headers']) {
 const channel={id:'group',provider:'openai',channelId,authMethod:'api_key',wireOverride,sessionId,baseUrl:variant==='legacy'?'https://fixture.invalid/ZEN/GO/V1/':'https://fixture.invalid/zen/go/'};
 const model={id:'group::model',groupId:'group',model:'gpt-5.6-luna',maxOutputTokens:2048,supportsReasoning:false,reasoningParamStyle:'none',reasoningEffortMap:{max:'wrong-legacy-value'}};
 if(variant==='synced') model.reasoningEffortValues=[' NONE ','minimal','low',' HIGH ','xhigh','max','max',' '];
 if(variant==='headers') { delete channel.sessionId; channel.conversationId='fixture-conversation'; model.customHeaders={'x-opencode-session':'custom-session'}; }
 const selected={providerId:'group',modelProviderId:model.id,modelId:model.model,family:'openai',reasoningEffort:'max',fastMode:true};
 capture(`${channelId}/${wireOverride}/${variant}`,channel,model,selected);
}
for(const [name,data] of Object.entries({'model-channel-registry':{schemaVersion:1,descriptors,protectedHeaders},'model-go-registry':{schemaVersion:1,profiles:goProfiles,defaults:goDefaults,anthropicHeaders:goAnthropicHeaders,sessionHeader:OPENCODE_GO_SESSION_HEADER},'model-channels':{schemaVersion:1,system,messages,tools,cases}})) {
 const file=new URL(`../../packages/protocol/contracts/native-cli/${name}.json`,import.meta.url);
 const result=JSON.parse(JSON.stringify(data));
 if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(result,null,2)+'\n');
 else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),result);
}
console.log(`${descriptors.length} channel descriptors / ${cases.length} actual TS channel/config/request cases match.`);
