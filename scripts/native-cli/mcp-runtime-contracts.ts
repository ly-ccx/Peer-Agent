import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {callMcpTool,disconnectAll,normalizeMcpToolResult} from '../../packages/runtime-node/src/mcp-client.mjs';
const inputs=[null,{}, {content:[]}, {content:[{type:'text',text:'native'},{type:'text',text:''},{type:'image',data:'base64-data'}],isError:true,structuredContent:{nested:['value']}}, {content:[{type:'resource',resource:{uri:'fixture://fact',text:'factual context'}}],extension:{retained:true}}, {content:[{type:'text',text:'ESC\u001b[31m'}],isError:false}, {structuredContent:{'10':1,'2':2,'中文🙂':1.0,exponent:1e-7}}];
const cases=inputs.map(input=>({input,expected:normalizeMcpToolResult(input)}));
const limits=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/mcp-runtime-v1.json',import.meta.url),'utf8'));
const root=mkdtempSync(join(tmpdir(),'peer-native-mcp-reference-'));writeFileSync(join(root,'.native-cli-fixture'),'isolated');
const config={id:'native-reference',transport:'stdio',command:resolve('target/debug/mcp-test-fixture'),env:{MCP_FIXTURE_ROOT:root},tools:[{name:'read_fact'}]};
try {
 const result=await callMcpTool(config,'read_fact',{});assert.equal(result.text,'native MCP fact');assert.equal(result.raw.extension.retained,true);
 const requests=readFileSync(join(root,'mcp.requests'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
 const initialize=requests.find(v=>v.method==='initialize').params;assert.deepEqual(initialize.clientInfo,limits.clientInfo);assert.deepEqual(initialize.capabilities,{});assert.equal(initialize.protocolVersion,limits.protocolVersion);
 const call=requests.find(v=>v.method==='tools/call').params;assert.equal(call.name,'read_fact');assert.deepEqual(call.arguments,{});
 const output={version:1,initialize,cases};const file=new URL('../../packages/protocol/contracts/native-cli/mcp-runtime-results.json',import.meta.url);
 if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(output,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),output);
 console.log(`${cases.length} production TS MCP result vectors and actual SDK initialize/tool dispatch match.`);
}finally{disconnectAll();rmSync(root,{recursive:true,force:true});}
