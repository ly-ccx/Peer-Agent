// Development-only reference execution; never loaded by the native binary.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createOpenAICompatibleProvider} from '../../packages/runtime-node/src/openai-compatible-provider.ts';
import {createChatGptResponsesProvider} from '../../packages/runtime-node/src/chatgpt-responses-provider.ts';
import {createAnthropicMessagesProvider} from '../../apps/tui/src/anthropic-messages-provider.ts';
import {createGeminiProvider} from '../../apps/tui/src/gemini-provider.ts';
import {sendAnthropicMessagesStream} from '../../packages/runtime-node/src/provider-adapters/anthropic-messages-adapter.mjs';
import {sendGeminiStream} from '../../packages/runtime-node/src/provider-adapters/gemini-adapter.mjs';
import {createRuntimeUsageAccounting} from '../../packages/runtime-core/src/runtime-usage-accounting.ts';
const sse=(events:unknown[])=>events.map(e=>`data: ${typeof e==='string'?e:JSON.stringify(e)}\n\n`).join('');
const cases=[];
for(const wire of ['openai-chat','openai-responses','anthropic-messages','gemini']) for(const kind of ['tool','text']) {
 const tool=kind==='tool', args={path:'input.txt'}, text='Native complete.';
 let events:any[]=[];
 if(wire==='openai-chat')events=[{choices:[{index:0,delta:tool?{tool_calls:[{index:0,id:'upstream',type:'function',function:{name:'read_file',arguments:JSON.stringify(args)}}]}:{content:text},finish_reason:tool?'tool_calls':'stop'}]},
  {choices:[],usage:{prompt_tokens:20,completion_tokens:3,prompt_tokens_details:{cached_tokens:5},total_tokens:23}},'[DONE]'];
 if(wire==='openai-responses'){
  const item=tool?{id:'item',type:'function_call',call_id:'upstream',name:'read_file',arguments:JSON.stringify(args)}:{id:'item',type:'message',role:'assistant',content:[{type:'output_text',text}]};
  events=tool?[
   {type:'response.output_item.added',output_index:0,item:{...item,arguments:''}},
   {type:'response.function_call_arguments.delta',output_index:0,item_id:'item',delta:JSON.stringify(args)},
   {type:'response.function_call_arguments.done',output_index:0,item_id:'item',arguments:JSON.stringify(args)},
   {type:'response.output_item.done',output_index:0,item},
  ]:[{type:'response.output_text.delta',item_id:'item',output_index:0,content_index:0,delta:text}];
  events.push({type:'response.completed',response:{status:'completed',output:[item],usage:{input_tokens:20,output_tokens:3,input_tokens_details:{cached_tokens:5},total_tokens:23}}});
 }
 if(wire==='anthropic-messages')events=[
  {type:'message_start',message:{role:'assistant',usage:{input_tokens:15,output_tokens:0,cache_read_input_tokens:5,cache_creation_input_tokens:0}}},
  ...(tool?[
   {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},
   {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Authentic synthetic thought.'}},
   {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'synthetic-signature'}},
   {type:'content_block_stop',index:0},
   {type:'content_block_start',index:1,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Inspecting source.'}},
   {type:'content_block_stop',index:1},
  ]:[]),
  {type:'content_block_start',index:tool?2:0,content_block:tool?{type:'tool_use',id:'upstream',name:'read_file',input:{}}:{type:'text',text:''}},
  {type:'content_block_delta',index:tool?2:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(args)}:{type:'text_delta',text}},
  {type:'content_block_stop',index:tool?2:0},
  {type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:3}},
  {type:'message_stop'},
 ];
 if(wire==='gemini')events=[{candidates:[{index:0,content:{parts:tool?[{text:'Inspecting source.',thoughtSignature:'synthetic-text-signature'},{functionCall:{name:'read_file',args},thoughtSignature:'synthetic-signature'}]:[{text}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:20,cachedContentTokenCount:5,candidatesTokenCount:3,totalTokenCount:23}}];
 const stream=sse(events);let requestBody:unknown;
 const fetchImpl=async(_url:unknown,options:any)=>{requestBody=JSON.parse(options.body);return new Response(stream,{headers:{'content-type':'text/event-stream'}});};
 let provider;
 if(wire==='openai-chat')provider=createOpenAICompatibleProvider({config:{providerId:'fixture',apiKey:'synthetic-key',baseUrl:'https://fixture.invalid'},fetch:fetchImpl as any});
 if(wire==='openai-responses')provider=createChatGptResponsesProvider({baseUrl:'https://fixture.invalid',tokens:{access:'synthetic-key'},fetch:fetchImpl as any});
 if(wire==='anthropic-messages')provider=createAnthropicMessagesProvider({providerId:'fixture',baseUrl:'https://fixture.invalid',getApiKey:async()=>'synthetic-key',sendStream:options=>sendAnthropicMessagesStream({...options,fetchImpl})});
 if(wire==='gemini')provider=createGeminiProvider({providerId:'fixture',baseUrl:'https://fixture.invalid',authMethod:'api_key',getApiKey:async()=>'synthetic-key',sendStream:options=>sendGeminiStream({...options,fetchImpl})});
 // A non-reasoning Anthropic model needs the explicit off selection: that
 // adapter otherwise enables its default thinking budget even without metadata.
 const result=await provider!.stream({model:'model',messages:[{role:'system',content:'shared system'},{role:'user',content:'inspect'}],tools:[{name:'read_file',description:'Read a file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}],...(wire==='anthropic-messages'?{reasoningEffort:'off' as const}:{})});
 const accounting=createRuntimeUsageAccounting().observeProviderRequest(result.usage).lastRequest;
 cases.push({wire,kind,stream,requestBody,expected:{content:result.content,calls:result.toolCalls.map(c=>({name:c.name,arguments:JSON.parse(c.arguments)})),usage:accounting?{inputTokens:accounting.inputTokens,outputTokens:accounting.outputTokens,cacheReadTokens:accounting.cacheReadTokens,cacheWriteTokens:accounting.cacheWriteTokens,totalTokens:accounting.totalTokens}:null}});
}
const result={schemaVersion:1,cases};const file=new URL('../../packages/protocol/contracts/native-cli/model-streams.json',import.meta.url);
if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(result,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),result);
console.log(`${cases.length} actual TS provider stream/request/accounting fixtures match.`);
