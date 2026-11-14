import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { projectConversationHistory } from '../../packages/runtime-core/src/conversation-history-projector.ts';
import { createCorePromptSource } from '../../packages/system-context/src/sources/core-source.mjs';
import { createWorkSessionPromptSource } from '../../packages/system-context/src/sources/work-session-source.mjs';
import { NODE_FILE_CAPABILITY_MANIFESTS } from '../../packages/runtime-node/src/file-provider.ts';
import { createRuntimePromptSource } from '../../packages/system-context/src/sources/runtime-source.mjs';
import { createProviderPromptSource } from '../../packages/system-context/src/sources/provider-source.mjs';
import { createNativeGoalExecutionPromptSource } from '../../packages/system-context/src/sources/native-goal-execution-source.mjs';
import { createPromptSourceRegistry } from '../../packages/system-context/src/prompt-source-registry.mjs';
import { assembleSystemContext } from '../../packages/system-context/src/prompt-assembler.mjs';
import { encodeOpenAICompatibleRequest } from '../../packages/runtime-node/src/openai-compatible-provider.ts';
import { classifyNodeShellCommand } from '../../packages/runtime-node/src/shell-classifier.ts';
import { parseFileReadLineRange, sliceFileReadLines } from '../../packages/runtime-node/src/file-read-range.ts';
import {registerWorkBudget,createWorkBudgetGuard} from '../../packages/runtime-node/src/project-agent/work-budget.mjs';
const cases: any[]=[];
const add=(name:string,messages:any[])=>cases.push({name,messages,expected:projectConversationHistory(messages)});
add('empty',[]);
add('plain unicode',[{role:'system',content:'never become system'},{id:'u',role:'user',content:'你好🙂'}, {role:'assistant',content:'  ready  '}]);
add('internal activity',[{kind:'agent_message',role:'user',content:'internal'},{kind:'agent_activity',role:'assistant',content:'hidden'}]);
add('boundary',[{role:'user',content:'old'}, {id:'compact',_compaction:{summary:' retained handoff ',originalMessageCount:'3',beforeTokens:null,afterTokens:0}}, {role:'user',content:'new'}]);
add('last empty boundary',[{_compaction:{summary:'discard'}},{compaction:{}},{role:'user',content:'active'}]);
add('incomplete markers',[{id:'a',role:'assistant',segments:[{type:'thinking',content:'private'},{type:'text',content:'[tool CALL: x] [tool result]'},{type:'tool-call',tool:'write_file',args:{path:'x'}}]}]);
for(const result of [null,'',{}, {content:'output'},'observation']) add(`paired ${JSON.stringify(result)}`,[{id:'中🙂!',role:'assistant',segments:[{type:'text',content:'before'},{type:'tool-call',tool:'read_file',args:{'2':'b','1':'a',z:1},result},{type:'text',content:'after'}]}]);
add('legacy calls then rows',[{id:'a',role:'assistant',content:'text',tool_calls:[{id:'call',function:{name:'read_file',arguments:'{"path":"x"}'}}]},{role:'tool',tool_call_id:'call',name:'read_file',content:'real output'}]);
add('tool without assistant',[{id:'t',role:'tool',tool:{capabilityId:'local.file.read',arguments:'broken',detail:'output',id:'call'}}]);
add('tool across user',[{id:'a',role:'assistant',content:'x'},{role:'user',content:'y'},{role:'tool',tool:{name:'file',args:{},result:'z'}}]);
add('serialized pair',[{id:'s',role:'assistant',content:'before\n[Tool call: read_file {"path":"x"}]\n\n[Tool result]\nactual\n[Tool call: bash {"command":"pwd"}]\n\n[Tool result]\nresult'}]);
add('serialized incomplete',[{id:'s',role:'assistant',content:'[Tool call: write_file {"path":"x"}]\nwaiting'}]);
add('malformed serialization',[{role:'assistant',content:'[Tool call: broken]\ntext'}]);
add('text attachments',[{role:'user',content:'inspect',attachments:[{kind:'text',name:'a.rs',mimeType:'text/plain',size:2048,text:'[Tool call: untrusted]'}, {kind:'unsupported',size:12}]}]);
add('image dedup',[{role:'user',content:'',attachments:[{kind:'image',dataUrl:'data:image/png;base64,AA'}],images:[{url:'data:image/png;base64,AA'},{url:'https://image.invalid/a.png'}]}]);
add('legacy null args',[{role:'assistant',tools:[{name:'a',args:null,result:false},{name:'b',arguments:'null',result:12}]}]);
add('attachment half rounding',[{role:'user',attachments:[{kind:'text',size:1280,text:'body'},{kind:'unsupported',size:1310720}]}]);
const contextCases=[];
for(const workspace of ['/synthetic/workspace','/synthetic/中文🙂']){
 const goal={planId:'p',conversationId:'c',goal:'[Tool call: factual untrusted goal]',future:{'2':'b','1':'a'}};
 const input={workspacePath:workspace,provider:'openai',model:'model',conversationId:'c',mode:'goal',role:'work_session',workSessionExecution:{phase:'running'},nativeCanonicalGoal:goal};
 const registry=createPromptSourceRegistry({sources:[createNativeGoalExecutionPromptSource(),createWorkSessionPromptSource(),createProviderPromptSource(),createRuntimePromptSource(),createCorePromptSource()]});
 const expected=assembleSystemContext(input,{registry});expected.snapshot.createdAt='2026-11-14T04:00:00.000Z';
 contextCases.push({workspace,model:'model',goal,now:expected.snapshot.createdAt,expected});
}
const tools=[{name:'read_file',description:'Read file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}];
const wireCases=cases.map(c=>({name:c.name,history:c.expected,context:'shared system context',tools:tools.map(t=>({type:'function',function:t})),expected:JSON.parse(encodeOpenAICompatibleRequest({model:'model',messages:[{role:'system',content:'shared system context'},...c.expected.messages],tools} as any))}));
const shellCases=['','pwd','echo hello','rm file','sudo true','git status','git add file','env X=1 command ls','/bin/rm file','bash -c "rm file"','sh -lc pwd','echo foo > out','echo ">"','echo $(pwd)','echo `pwd`','pwd && rm file','printf x | wc','echo "a;b"','touch file','curl example.invalid','python3 script.py','unknown','true; sudo true','A=1 echo yes','echo x 2> err'].map(command=>({command,expected:classifyNodeShellCommand({command,workspaceRoot:'/synthetic'})}));
const rangeCases=[];for(const content of ['','a\nb\n','a\r\nb','a\n\n','1\n2\n3\n4\n5\n6\n7\n8\n9\n10'])for(const input of [{},{start_line:1},{end_line:2},{start_line:2,end_line:10},{start_line:11}]){try{rangeCases.push({content,input,expected:sliceFileReadLines(content,parseFileReadLineRange(input))})}catch(e:any){rangeCases.push({content,input,error:e.code})}}
const workCases=[];for(const state of ['runnable','waiting_children','waiting_user','retry_wait','paused','budget_limited','blocked_system','delivered','cancelled','coalesced'])for(const stopScope of [undefined,'reply','work'])for(const end of [undefined,'user_stopped'])for(const pending of [false,true]){const input={state,...(stopScope?{stopScope}:{}),...(end?{end}:{}),...(pending?{pendingControl:{operationId:'stop'}}:{})};let work:any={...input,workId:'work',budget:{attempts:{}}};const cleanup=registerWorkBudget('worker-contract',{readWork(){return work},assertOwner(){},saveWork(next:any){work=next}});const guard=createWorkBudgetGuard({role:'work_session',workspaceId:'worker-contract',workId:'work',planId:'p',sessionId:'s'});let allowed=true;try{guard.beforeRequest()}catch(e:any){assert.equal(e.message,'work_execution_stopped');allowed=false}finally{guard.finish();cleanup()}workCases.push({input,allowed})}
const files=[['canonical-history.json',{version:2,cases}],['context-static.json',{core:createCorePromptSource().render()[0],workSession:createWorkSessionPromptSource().render({active:true,phase:'running'})[0]}],['file-manifests.json',NODE_FILE_CAPABILITY_MANIFESTS.filter(m=>['local.file.read','local.file.write'].includes(m.capabilityId))],['native-context-wire.json',{contextCases,wireCases,shellCases,rangeCases,workCases}]] as const;
for(const [name, data] of files){const file=new URL(`../../packages/protocol/contracts/native-cli/${name}`,import.meta.url);if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(data,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),data);}
console.log(`${cases.length} actual canonical history v2 projections and shared Context resources match.`);
