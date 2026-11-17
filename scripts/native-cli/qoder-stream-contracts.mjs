// Development reference only; production native CLI never loads Node or this file.
import assert from 'node:assert/strict';
import{readFileSync,writeFileSync,mkdtempSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
const root=mkdtempSync(join(tmpdir(),'peer-qoder-stream-'));process.env.HOME=root;process.env.PEER_AGENT_HOME=root;process.env.PEER_AGENT_PROVIDER_TRACE='0';
const{consumeOpenAIStream}=await import('../../packages/runtime-node/dist/provider-adapters/openai-chat-adapter.mjs');
const usage={prompt_tokens:12,completion_tokens:4};const args={path:'stream.txt',content:'native'};
const tool={index:0,id:'upstream',type:'function',function:{name:'write_file',arguments:JSON.stringify(args)}};
const chunk=(delta,extra={})=>({choices:[{index:0,delta,...extra}]});
const wrap=e=>({statusCodeValue:200,statusCode:'OK',body:JSON.stringify(e)});
const sse=(events,wrapped=false)=>events.map(e=>`data: ${typeof e==='string'?e:JSON.stringify(wrapped?wrap(e):e)}\n\n`).join('');
const cases=[];
function add(name,events,expectation,wrapped=false){cases.push({name,stream:sse(events,wrapped),expectation});}
for(const wrapped of[false,true]){
 const prefix=wrapped?'envelope':'plain';
 add(`${prefix}-unicode-fragments`,[chunk({content:[{text:'你好，👩🏽‍💻'},{output_text:' é'}],thinking:'真实思考。'}),{usage},'[DONE]'],{content:'你好，👩🏽‍💻 é',thinking:'真实思考。',calls:[],totalTokens:16},wrapped);
 add(`${prefix}-thinking-text-tool`,[chunk({content:'Inspecting.',thinking:'Observed thought.',tool_calls:[tool]}),{usage},'[DONE]'],{content:'Inspecting.',thinking:'Observed thought.',calls:[{name:'write_file',arguments:args}],totalTokens:16},wrapped);

 add(`${prefix}-sparse-chat-text`,[{choices:[{delta:{content:'Native complete.'}}]},{usage},'[DONE]'],{content:'Native complete.',thinking:'',calls:[],totalTokens:16},wrapped);
 add(`${prefix}-sparse-chat-tool`,[{choices:[{delta:{tool_calls:[tool]}}]},{usage},'[DONE]'],{content:'',thinking:'',calls:[{name:'write_file',arguments:args}],totalTokens:16},wrapped);
 for(const alias of['reasoning_content','reasoning','reasoning_text','thinking','thinking_content','reasoning_summary'])
  add(`${prefix}-${alias}`,[chunk({content:[{text:'Native '},{content:'complete.'}],[alias]:[{summary:'Observed '},{output_text:'thought.'}]}),{usage},'[DONE]'],{content:'Native complete.',thinking:'Observed thought.',calls:[],totalTokens:16},wrapped);
 const start={type:'content_block_start',index:0,content_block:{type:'tool_use',id:'upstream',name:'write_file',input:{}}};
 const partial=JSON.stringify(args),split=12;
 const blocks=[start,{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:partial.slice(0,split)}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:partial.slice(split)}},{type:'content_block_stop',index:0}];
 for(const terminal of['[DONE]',{type:'message_stop'}])add(`${prefix}-sparse-block-tool-${typeof terminal==='string'?'done':'stop'}`,[...blocks,terminal],{content:'',thinking:'',calls:[{name:'write_file',arguments:args}],totalTokens:null},wrapped);
 add(`${prefix}-block-text-thinking`,[{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Observed thought.'}},{type:'content_block_stop',index:0},{type:'content_block_start',index:1,content_block:{type:'text',text:''}},{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Native complete.'}},{type:'content_block_stop',index:1},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}],{content:'Native complete.',thinking:'Observed thought.',calls:[],totalTokens:null},wrapped);
 add(`${prefix}-null-function-placeholder`,[chunk({tool_calls:[{index:0,id:'upstream',type:'function',function:null}]}),chunk({tool_calls:[{index:0,function:{name:'write_file',arguments:JSON.stringify(args)}}]}),chunk({},{finish_reason:'tool_calls'}),{choices:[],usage},'[DONE]'],{content:'',thinking:'',calls:[{name:'write_file',arguments:args}],totalTokens:16},wrapped);
 add(`${prefix}-provisional-tool-name`,[chunk({tool_calls:[{...tool,function:{name:'provisional',arguments:partial.slice(0,split)}}]}),chunk({tool_calls:[{index:0,id:null,type:null,function:{name:'write_file',arguments:partial.slice(split)}}]}),{usage},'[DONE]'],{content:'',thinking:'',calls:[{name:'write_file',arguments:args}],totalTokens:16},wrapped);
 add(`${prefix}-stable-repeated-tool-identity`,[chunk({tool_calls:[{...tool,function:{name:'write_file',arguments:partial.slice(0,split)}}]}),chunk({tool_calls:[{...tool,function:{name:'write_file',arguments:partial.slice(split)}}]}),{usage},'[DONE]'],{content:'',thinking:'',calls:[{name:'write_file',arguments:args}],totalTokens:16},wrapped);
}
for(const wrapped of[false,true]){
 const prefix=wrapped?'envelope':'plain';
 add(`${prefix}-initial-block-values`,[{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'Initial thought.'}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:' More.'}},{type:'content_block_stop',index:0},{type:'content_block_start',index:1,content_block:{type:'text',text:'Native '}},{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'complete.'}},{type:'content_block_stop',index:1},{type:'message_stop'}],{content:'Native complete.',thinking:'Initial thought. More.',calls:[],totalTokens:null},wrapped);
 add(`${prefix}-initial-tool-input`,[{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'initial-tool',name:'write_file',input:args}},{type:'content_block_stop',index:0},{type:'message_stop'}],{content:'',thinking:'',calls:[{name:'write_file',arguments:args}],totalTokens:null},wrapped);
 add(`${prefix}-chat-message-stop`,[chunk({content:'Native complete.'}),{usage},{type:'message_stop'}],{content:'Native complete.',thinking:'',calls:[],totalTokens:16},wrapped);
}
for(const wrapped of[false,true]){
 const prefix=wrapped?'envelope':'plain';
 for(const [label,observations,totalTokens] of [
  ['repeated-usage',[usage,usage],16],
  ['progressive-usage',[usage,{prompt_tokens:20,completion_tokens:5}],25],
  ['partial-before-complete',[{prompt_tokens:3},usage],16],
  ['partial-after-complete',[usage,{prompt_tokens:40}],16],
  ['partial-only',[{prompt_tokens:12}],null],
  ['input-output-usage-alias',[{input_tokens:12,output_tokens:4,input_tokens_details:{cached_tokens:3}}],16],
 ])add(`${prefix}-${label}`,[chunk({content:'Native complete.'}),...observations.map(usage=>({usage})),'[DONE]'],{content:'Native complete.',thinking:'',calls:[],totalTokens},wrapped);
 add(`${prefix}-block-tool-with-chat-usage`,[{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'usage-tool',name:'write_file',input:args}},{type:'content_block_stop',index:0},{usage},{type:'message_stop'}],{content:'',thinking:'',calls:[{name:'write_file',arguments:args}],totalTokens:16},wrapped);
}
add('two-tools-with-real-terminal',[chunk({tool_calls:[tool,{...tool,index:1,id:'upstream-2',function:{name:'write_file',arguments:JSON.stringify({...args,path:'stream-second.txt'})}}]}),{usage},'[DONE]'],{content:'',thinking:'',calls:[{name:'write_file',arguments:args},{name:'write_file',arguments:{...args,path:'stream-second.txt'}}],totalTokens:16});
for(const c of cases){
 let r=await consumeOpenAIStream(new Response(c.stream,{headers:{'content-type':'text/event-stream'}}),null,'synthetic',null,null,{bufferTextDeltas:true,bufferThinkingDeltas:true});
 assert.equal(r.streamError,null,c.name);assert.equal(r.content,c.expectation.content,c.name);assert.equal(r.thinkingContent,c.expectation.thinking,c.name);
 const calls=r.toolCalls.map(x=>({name:x.name,arguments:JSON.parse(x.arguments)}));assert.deepEqual(calls,c.expectation.calls,c.name);
 c.expected={content:r.content,thinking:r.thinkingContent,calls,usage:r.streamUsage===null?null:{inputTokens:r.streamUsage.inputTokens,outputTokens:r.streamUsage.outputTokens,cacheReadTokens:r.streamUsage.cacheReadTokens,totalTokens:r.streamUsage.inputTokens+r.streamUsage.outputTokens+r.streamUsage.cacheReadTokens}};
 assert.equal(c.expected.usage?.totalTokens??null,c.expectation.totalTokens,c.name);
}
const file=new URL('../../packages/protocol/contracts/native-cli/qoder-streams.json',import.meta.url),result={schemaVersion:1,provenance:{scope:'Actual shared TS consumeOpenAIStream parser over synthetic finite responses. Not authentication/HTTP/provider evidence. Native rejects unterminated/error/malformed streams even where legacy parser returns partial facts.'},cases};
if(process.argv.includes('--write'))writeFileSync(file,JSON.stringify(result,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),result);
console.log(JSON.stringify({ok:true,cases:cases.length,root,scope:result.provenance.scope}));
