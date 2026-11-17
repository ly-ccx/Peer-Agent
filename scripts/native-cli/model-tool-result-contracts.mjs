// Actual TS sender oracle; never executed by the native CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeProviderToolResult } from '../../packages/runtime-node/dist/tool-result-encoder.js';
const file=new URL('../../packages/protocol/contracts/native-cli/model-tool-results.json',import.meta.url);
const root=mkdtempSync(join(tmpdir(),'peer-result-encoder-oracle-'));writeFileSync(join(root,'.native-cli-fixture'),'isolated');
const cases=[];
function add(name,tool,result,options={}) {cases.push({name,tool,result,...options});}
add('generic success','probe',{toolCallId:'call',status:'success',output:{count:2,rows:['a','中']},evidence:{refs:[' fact://one ','fact://one'],artifactRefs:['artifact://one']}});
add('generic failure','probe',{toolCallId:'call',status:'failed',output:{reason:'not done'},error:{code:'failed',message:'observed failure'}});
add('explicit null output','probe',{status:'denied',output:null,outputPreview:{ignored:true},error:{code:'permission_denied'}});
add('preview only','probe',{status:'success',outputPreview:{count:1}});
add('primitive output','probe',{status:'success',output:'complete factual text'});
add('array output','probe',{status:'success',output:[1,true,null,'值']});
add('evidence collector ignores arbitrary output URIs','probe',{toolCallId:'call',status:'success',output:{evidenceRefs:['invented://ref']},evidence:{refs:['actual://ref'],artifactRefs:[' actual://ref ','artifact://one']},outputPreview:{artifactRef:'preview://one',artifactRefs:['artifact://one'],localToolResultRef:{artifactRef:'nested://one',artifactRefs:['nested://two']}}});
add('existing local tool ref','probe',{status:'success',output:{kind:'local_tool_result_ref',preview:'saved view',artifactPath:'synthetic/saved.txt'}});
add('existing string ref with BOM','probe',{status:'success',output:' \ufeff {"kind":"local_capability_result_ref","preview":"opaque reference"} '});
add('preview existing ref','probe',{status:'success',output:{notRef:true},outputPreview:{kind:'local_file_ref',preview:'original'}});
add('existing failure retains actual result error','probe',{toolCallId:'call',status:'failed',output:{kind:'local_tool_result_ref',status:'completed',preview:'partial'},error:{code:'execution_outcome_unknown',message:'unknown'}},{nativeChanges:{resultStatus:'failed',resultError:{code:'execution_outcome_unknown',message:'unknown'}},deviation:'Existing ref cannot hide the actual outer failed/unknown result.'});
add('explicit error survives a successful status on an existing ref','probe',{toolCallId:'call',status:'success',output:{kind:'local_tool_result_ref',preview:'saved partial observation'},error:{code:'partial_observation',message:'explicit saved warning'}},{nativeChanges:{resultStatus:'success',resultError:{code:'partial_observation',message:'explicit saved warning'}},deviation:'An explicit saved error is not erased by a successful status label.'});
add('file inline','read_file',{toolCallId:'call',capabilityId:'local.file.read',status:'success',output:{path:'src/input.txt',content:'source\n事实🦀\n',bytes:24,contentHash:'observed-hash'}});
add('file shell path escaping','read_file',{status:'success',output:{path:' a"b\\c$`\n.txt ',content:'literal original',bytes:16}});
add('file selected range is not the whole file','read_file',{status:'success',output:{path:'old.txt',content:'2\tbeta\n3\tgamma',bytes:100,contentHash:'whole-file-hash',start_line:2,end_line:3,total_lines:8}},{nativeChanges:{start_line:2,end_line:3,total_lines:8,ranged:true,note:'Full requested range is inline. Other file lines were not part of this observation.'},deviation:'Keep the exact selected-range metadata; do not label it as the entire file.'});
add('file string object','read_file',{status:'success',output:JSON.stringify({path:'file.txt',content:'BOM \ufeff original',contentHash:'hash'})});
const shaped={toolCallId:'call',capabilityId:'local.mcp.s.tools.probe',status:'success',output:{path:'claimed',content:'provider fact',bytes:13,extra:{must:'keep'}},evidence:{refs:['governed://one']}};
add('MCP file-shaped output preserves every field','mcp__s__probe',shaped,{nativeExpected:JSON.stringify({status:'success',output:shaped.output,evidenceRefs:['tool-result://call','governed://one']}),deviation:'Only the actual file tool uses the file view; MCP fields are not discarded.'});
const shellShaped={toolCallId:'call',capabilityId:'local.mcp.s.tools.probe',status:'success',output:{stdout:'provider fact',command:'claimed command',extra:{must:'keep'}},evidence:{refs:['governed://one']}};
add('MCP shell-shaped output preserves every field','mcp__s__probe',shellShaped,{nativeExpected:JSON.stringify({status:'success',output:shellShaped.output,evidenceRefs:['tool-result://call','governed://one']}),deviation:'Only the actual shell tool uses the shell preview; MCP data are not local shell execution.'});
add('shell complete','bash',{toolCallId:'call',status:'success',output:{command:'printf fact',cwd:'/synthetic',taskId:'task',stdout:'fact',stderr:'',exitCode:0,status:'completed',stdoutPath:'/synthetic/stdout.txt',artifactRef:'shell://task',artifactRefs:['a',' a ','a','']},evidence:{artifactRefs:['shell://task/stdout']}});
add('shell preview fallback','bash',{status:'success',output:{command:' ',exitCode:null},outputPreview:{command:'from preview',taskId:'task',stdout:'preview text',exitCode:7,cwd:'/synthetic',artifactRefs:['one','one']}});
add('shell failure preserves stderr and outer status','bash',{toolCallId:'call',status:'failed',output:{taskId:'task',stdout:'out',stderr:'bad🦀',exitCode:1},error:{code:'shell_failed',message:'failed'}},{nativeChanges:{stderrPreview:'bad🦀',stderrChars:5,stderrPreviewTruncated:false,resultStatus:'failed',resultError:{code:'shell_failed',message:'failed'}},deviation:'Separate stderr and real outer execution failure remain visible.'});
add('shell whitespace stderr remains an observation','bash',{status:'success',output:{taskId:'task',stdout:'',stderr:' \n',exitCode:0}},{nativeChanges:{stderrPreview:' \n',stderrChars:2,stderrPreviewTruncated:false},deviation:'Whitespace stderr is not silently discarded.'});
add('shell cancellation preserves actual status','bash',{status:'cancelled',output:{taskId:'task',stdout:'',stderr:'',cancelled:true},error:{code:'CANCELLED'}},{nativeChanges:{resultStatus:'cancelled',resultError:{code:'CANCELLED'}},deviation:'The TS shell default completed is not allowed to hide cancellation.'});
add('shell omitted middle requires immutable materialization','bash',{status:'success',output:{taskId:'task',stdout:'x'.repeat(4501),stderr:'',exitCode:0}},{materialization:true,deviation:'A clipped shell view cannot point only at mutable or absent legacy cache.'});
add('shell Unicode clipping requires complete snapshot','bash',{status:'failed',output:{taskId:'task',stdout:'',stderr:'a'.repeat(3999)+'🦀'},error:{code:'failed'}},{materialization:true,deviation:'Do not split a surrogate or lose omitted stderr.'});
add('legacy large file requires original snapshot','read_file',{status:'success',output:{path:'old.txt',content:'old fact '.repeat(4200),bytes:37800}},{materialization:true,deviation:'Store complete saved content rather than recover historical bytes from the workspace.'});
const data={schemaVersion:1,provenance:'Actual encodeProviderToolResult with isolated cache; explicit native safety deltas under ADR131.',limits:{sourceAndViewBytes:16777216,viewBytes:65536,inlineChars:6000,fileInlineChars:32000,shellPreviewChars:4000},errors:['model_tool_result_encoding_limit','model_tool_result_materialization_required','model_tool_result_identity_changed','model_tool_result_encoding_unavailable'],cases:[]};
for(const c of cases){
 const v=encodeProviderToolResult({result:c.result,tool:c.tool,toolCallId:c.result.toolCallId,conversationId:'c',baseDir:root});
 const expectedTS=v.content.replaceAll(root,'$FIXTURE');
 let expectedNative=null;
 if(!c.materialization){assert.equal(v.materialized,false,c.name);const original=JSON.parse(v.content);expectedNative=c.nativeExpected??JSON.stringify({...original,...c.nativeChanges});}
 data.cases.push({name:c.name,tool:c.tool,result:c.result,expectedTS,expectedNative,materialization:Boolean(c.materialization),...(c.deviation?{deviation:c.deviation}:{})});
}
if(process.argv.includes('--write'))writeFileSync(file,JSON.stringify(data,null,2)+'\n');else assert.deepEqual(data,JSON.parse(readFileSync(file,'utf8')));
console.log(JSON.stringify({ok:true,cases:data.cases.length,root,scope:data.provenance}));
