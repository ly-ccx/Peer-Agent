import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMcpRegistry} from '../../packages/runtime-node/src/mcp-registry.mjs';
const root=mkdtempSync(join(tmpdir(),'peer-mcp-contract-')),file=join(root,'registry.json');
const registry=createMcpRegistry({registryPath:file});
const server={id:'files.local',displayName:'Local files',transport:'stdio',command:'/synthetic/mcp-server',tools:[{name:'read.file',description:'External tool description is metadata.',inputSchema:{type:'object',properties:{path:{type:'string'}}}}]};
const cases:any[]=[];
function add(name:string,rows:any[],legacy=false){const input=legacy?rows:{version:1,servers:rows};writeFileSync(file,JSON.stringify(input));const expected=registry.listCapabilityManifests();assert.ok(!JSON.stringify(expected).includes('fixture-secret-do-not-export'));cases.push({name,input,expected});}
add('empty',[]);add('legacy empty',[],true);add('visible defaults',[server]);add('legacy fields',[{mcpId:'legacy',name:'Legacy',serverUrl:'https://synthetic.invalid/mcp',tools:[{toolName:'read',toolDesc:'legacy description'}]}],true);
for(const patch of [{enabled:false},{policy:{trusted:false}},{health:{status:'failed'}},{toolVisibility:{'read.file':false}},{policy:{visibleByDefault:false}},{policy:{visibleByDefault:false},toolVisibility:{'read.file':true}},{policy:{requirePermission:false}},{transport:'sse'},{transport:'streamable_http'}])add(JSON.stringify(patch),[{...server,...patch}]);
add('UTF16 aliases and title',[{...server,id:'中文🙂',displayName:'工具服务',tools:[{name:'a/🙂',inputSchema:{},riskLevel:'L1_local_read',dataLevel:'D1_internal'}]}]);
for(const auth of [{mode:'none',credentialRef:'ignored'},{mode:'http_bearer',credentialRef:'token'},{mode:'http_header',headerName:' X-Token ',credentialRef:'mcp-cred:token'},{mode:'stdio_env',envName:'TOKEN_2',credentialRef:'token'},{mode:'oauth2',credentialRef:'oauth'}])add('auth '+auth.mode,[{...server,auth,headers:{Authorization:'fixture-secret-do-not-export'},env:{TOKEN:'fixture-secret-do-not-export'}}]);
const rejections=[
 {input:{version:99,servers:[]},error:'mcp_inventory_version_unsupported'},
 {input:{version:1,servers:[{...server,transport:'websocket'}]},error:'mcp_transport_unsupported'},
 {input:{version:1,servers:[{...server,auth:{mode:'future'}}]},error:'mcp_auth_unsupported'},
 {input:{version:1,servers:[{...server,auth:{mode:'http_bearer'}}]},error:'mcp_inventory_invalid'},
 {input:{version:1,servers:[{...server,id:'a.b'},{...server,id:'a?b'}]},error:'mcp_projection_alias_conflict'},
];
const output={version:1,cases,rejections};const path=new URL('../../packages/protocol/contracts/native-cli/mcp-inventory.json',import.meta.url);
if(process.argv.includes('--update'))writeFileSync(path,JSON.stringify(output,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),output);
rmSync(root,{recursive:true,force:true});console.log(`${cases.length} actual TS MCP manifests and ${rejections.length} explicit native rejection contracts match.`);
