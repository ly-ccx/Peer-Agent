// Actual TS wire implementations are the development reference, never a runtime sidecar.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {encodeOpenAIChatRequest,encodeAnthropicMessagesRequest,encodeOpenAIResponsesRequest,encodeGeminiGenerateContentRequest} from '../../packages/runtime-node/src/provider-encoders/index.mjs';
const tools=[{type:'function',function:{name:'read_file',description:'Read a file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}];
const histories=[
 [],[{role:'user',content:'中文🙂\nhello'}],
 [{role:'assistant',content:'old reply'},{role:'user',content:'next'}],
 [{role:'assistant',content:'checking',tool_calls:[{id:'call-1',type:'function',function:{name:'local.file.read',arguments:'{"path":"a"}'}}]},{role:'tool',tool_call_id:'call-1',name:'local.file.read',content:'actual result'},{role:'user',content:'continue'}],
 [{role:'tool',tool_call_id:'orphan',name:'old_tool',content:{status:'unknown'}}],
 [{role:'user',content:[{type:'text',text:'look'},{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}},{type:'image_url',image_url:{url:'https://image.invalid/a.png'}}]}],
 [{role:'user',content:[{type:'image_url',image_url:{url:'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E'}},{type:'text',text:' '},{type:'unknown',opaque:1}]}],
 [{role:'assistant',content:[{type:'thinking',thinking:'authentic thought',signature:'opaque'},{type:'text',text:'reply'}]},{role:'user',content:[{type:'tool_result',tool_use_id:'old',content:'observation'}]}],
 [{role:'assistant',content:[{type:'redacted_thinking',data:'authentic opaque block'},{type:'text',text:'reply'}]}],
 [{role:'assistant',content:'',reasoning_content:'real provider thinking',tool_calls:[{id:'c',function:{name:'f',arguments:'not JSON'}}]},{role:'tool',tool_call_id:'c',name:'f',content:'done'}],
 [{role:'assistant',content:'',tool_calls:[{id:'a',function:{name:'f.a',arguments:'[]'}},{id:'b',function:{name:'f.b',arguments:'null'}}]},{role:'tool',tool_call_id:'a',name:'f.a',content:'A'},{role:'tool',tool_call_id:'b',name:'f.b',content:'B'},{role:'tool',tool_call_id:'x',name:'f.x',content:'unmatched'}],
];
const options=[{},...['off','low','medium','default','high','xhigh','max'].map(effort=>({effort,supportsReasoning:true})),
 ...['none','openai-effort','qwen-enable','anthropic-enabled-budget','anthropic-adaptive-effort','anthropic-output-effort','anthropic-enabled-output-effort'].map(reasoningParamStyle=>({supportsReasoning:true,effort:'high',reasoningParamStyle})),
 ...[1,2,1024,32768].map(maxOutputTokens=>({supportsReasoning:true,effort:'xhigh',maxOutputTokens})),
 {supportsReasoning:true,effort:'default',reasoningEffortMap:{default:'high',medium:'low'},maxOutputTokens:1024,promptCaching:false},
 {supportsReasoning:true,effort:'high',reasoningParamStyle:'qwen-enable',reasoningEffortMap:{high:1234.9}},
 {supportsReasoning:true,effort:'low',reasoningParamStyle:'anthropic-enabled-budget',reasoningEffortMap:{low:'700'}},
 {supportsReasoning:true,effort:'off',reasoningParamStyle:'anthropic-enabled-output-effort'},
 {stableSystem:'stable core',promptCaching:true},
 {authMethod:'oauth_google',projectId:'synthetic-project',userPromptId:'prompt',sessionId:'session'},
 {supportsReasoning:true,effort:'default',reasoningEffortMap:{default:null,medium:'low'}},
 {supportsReasoning:true,effort:'default',reasoningEffortMap:{default:'',medium:'high'}},
 {supportsReasoning:true,effort:'high',reasoningEffortMap:{high:0}},
 {supportsReasoning:true,effort:'high',reasoningEffortMap:{high:false}},
 {authMethod:'oauth_google',projectId:'',userPromptId:'',sessionId:''},
];
const cases=[];
for(const wire of ['openai-chat','openai-responses','anthropic-messages','gemini']){
 for(const [i,messages]of histories.entries())for(const [j,options0]of options.entries()){
  const options=structuredClone(options0);const model=j%3===0?'deepseek-v4':j%3===1?'claude-opus-4.8':'model';
  const input={model,system:'shared system',messages,tools,...options};
  const reference={...input,messages:structuredClone(messages),tools:structuredClone(tools)};
  let expected;
  if(wire==='openai-chat')expected=encodeOpenAIChatRequest({...reference,messages:[{role:'system',content:input.system},...reference.messages]});
  else if(wire==='openai-responses')expected=encodeOpenAIResponsesRequest({...reference,messages:[{role:'system',content:input.system},...reference.messages]});
  else if(wire==='anthropic-messages')expected=encodeAnthropicMessagesRequest({...reference,tools:reference.tools.map(t=>({name:t.function.name,description:t.function.description,input_schema:t.function.parameters}))});
  else expected=encodeGeminiGenerateContentRequest({...reference,messages:[{role:'system',content:input.system},...reference.messages]});
  cases.push({wire,name:`${wire}/history-${i}/generation-${j}`,input,expected:JSON.parse(JSON.stringify(expected))});
 }
}
const result={schemaVersion:1,cases};const file=new URL('../../packages/protocol/contracts/native-cli/model-wires.json',import.meta.url);
if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(result,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),result);
console.log(`${cases.length} actual TS wire encoder fixtures match.`);
