// Actual default Source assembler reference; never a native execution sidecar.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {assembleSystemContext} from '../../packages/system-context/src/prompt-assembler.mjs';
import {createRuntimeReminderPromptSource} from '../../packages/system-context/src/sources/runtime-reminder-source.mjs';
import {createMcpHostPromptSource} from '../../packages/system-context/src/sources/mcp-host-source.mjs';
const dynamic=new Set(['runtime.workspace','runtime.provider','runtime.mode','agent.mcp-host']);
const modes=Object.fromEntries(['chat','plan','goal'].map(mode=>{
 const context=assembleSystemContext({mode,role:'chat'});
 const reminder=createRuntimeReminderPromptSource();
 return [mode,{sections:context.sections.filter(s=>!dynamic.has(s.id)),reminder:reminder.render(reminder.observe({mode}))[0]}];
}));
const mcp=createMcpHostPromptSource();
const empty=mcp.render({path:'@@PATH@@',servers:[],degraded:false})[0]!;
const pieces=empty.content.split('Your MCP registry lives at: @@PATH@@');assert.equal(pieces.length,2);
const tail=pieces[1]!.split('Installed MCP servers in your own registry: none yet.');assert.equal(tail.length,2);
const cases=[];
for(const mode of ['chat','plan','goal'])for(const provider of ['openai','anthropic','CustomSelection'])for(const effort of ['default','high','off','medium']){
 const servers=[{id:'one',displayName:'Local tools',enabled:true,transport:'stdio',toolsCount:3},{id:'two',name:'Other tools',enabled:false,transport:'sse',toolsCount:0}];
 const registryPath='/synthetic/home/mcp-registry.json';
 const input={conversationId:'conversation',workspacePath:'/synthetic/workspace',provider,model:'model',mode,effort,role:'chat',mcpRegistry:{path:()=>registryPath,listInstalled:()=>servers}};
 const expected=assembleSystemContext(input);expected.snapshot.createdAt='2026-11-18T00:00:00.000Z';
 cases.push({mode,provider,model:'model',effort,workspace:input.workspacePath,conversation:input.conversationId,registryPath,servers,now:expected.snapshot.createdAt,expected});
}
const outputs=[['ordinary-context-static.json',{version:1,modes,mcp:{section:empty,prefix:pieces[0],middle:tail[0],suffix:tail[1]}}],['ordinary-context.json',{version:1,cases}]] as const;
for(const [name,data] of outputs){const file=new URL(`../../packages/protocol/contracts/native-cli/${name}`,import.meta.url);
if(process.argv.includes('--write'))writeFileSync(file,JSON.stringify(data,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),data);}
console.log(`${cases.length} actual ordinary default Source assemblies and resources match.`);
