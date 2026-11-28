// Development reference: actual TS Store and public shell formatting/arguments.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createConversationStore} from '../../packages/conversation-store/src/index.mjs';
import {runPeerSessions} from '../../apps/tui/src/cli-sessions.ts';
import {formatSessionMarkdown,redactExportedText} from '../../apps/tui/src/cli-export.ts';
import {parsePeerArgv,formatPeerHelp} from '../../apps/tui/src/cli-argv.ts';
const a={id:'a',title:'  First\tline\nnext  ',createdAt:'2026-11-14T00:00:00Z',updatedAt:'2026-11-15T00:00:00Z',contentRevision:1};
const fixtures=[
 {name:'empty',index:[],messages:[]},
 {name:'roles-and-order',index:[a,{...a,id:'b',title:'工作',role:'work_session',updatedAt:'2026-11-16T00:00:00Z'}, {...a,id:'c',title:'Bot',role:'project_agent'}, {...a,id:'d',title:' ',role:'future-role',updatedAt:''}],messages:[]},
 {name:'visible-content',index:[a],messages:[{id:'u',role:'user',content:'  hello sk-abcdefgh- and Bearer token+/= 中ya29.good  '},{id:'h',role:'tool',content:'not visible',apiKey:'not-visible-secret'},{id:'m',role:'assistant',content:[{type:'thinking',text:'not visible'},{type:'text',text:'part one'},'part two',{content:'legacy text'}]},{id:'obj',role:'assistant',content:{text:'object text'}},{id:'empty',role:'assistant',content:'   '}]},
 {name:'stream-patch',index:[a],messages:[{id:'u',role:'user',content:'hello'},{id:'m',role:'assistant',content:'old draft'}],sidecar:{version:1,conversationId:'a',messageId:'m',patch:{content:'visible stream',isStreaming:true}}},
 {name:'stream-role-and-null',index:[a],messages:[{id:'m',role:'assistant',content:'hidden by role'},{id:'later',role:'user',content:'still visible'}],sidecar:{version:1,conversationId:'a',messageId:'m',patch:{role:'tool',content:null}}},
];
const cases=[];
for(const fixture of fixtures){
 const root=mkdtempSync(join(tmpdir(),'peer-native-session-contract-'));
 try{
  const dir=join(root,'conversations');mkdirSync(dir);writeFileSync(join(dir,'.goal-to-plan-migrated'),'fixture');
  writeFileSync(join(dir,'index.jsonl'),fixture.index.map(v=>JSON.stringify(v)+'\n').join(''));
  writeFileSync(join(dir,'a.jsonl'),fixture.messages.map(v=>JSON.stringify(v)+'\n').join(''));
  if(fixture.sidecar)writeFileSync(join(dir,'a.stream.json'),JSON.stringify(fixture.sidecar));
  const store=createConversationStore({storeDir:dir});const stdout:string[]=[],stderr:string[]=[];
  const exitCode=await runPeerSessions({action:'list'},{store,stdout:s=>stdout.push(s),stderr:s=>stderr.push(s)});
  const session=store.getConversation('a');
  cases.push({...fixture,expectedList:{exitCode,stdout,stderr},expectedMarkdown:session?formatSessionMarkdown(session):null});
 }finally{rmSync(root,{recursive:true,force:true});}
}
const argv=[['sessions'],['sessions','list'],['sessions','list','extra'],['sessions','--yes'],['sessions','--bogus'],['sessions','--help'],['doctor'],['doctor','--bogus'],['doctor','--help'],['export'],['export','a'],['export','a','--output','out.md','--force'],['export','--output=out.md','a'],['export','a','--output'],['export','a','--force'],['export','a','--bogus'],['export','--help']];
const samples=['sk-abcdefgh','sk-1234567','sk-abcdefgh----','xsk-abcdefgh','中sk-abcdefgh','Bearer abc+/==','Bearer\u00a0abc','Bearer\ufeffabc','ya29.a-b.','YA29.token','secret without prefix','Bearer =','sk---------A','Bearer a\nBearer b'];
const data={schemaVersion:1,cases,argv:argv.map(argv=>({argv,expected:parsePeerArgv(argv)})),help:Object.fromEntries(['sessions','doctor','export'].map(topic=>[topic,formatPeerHelp(topic as 'sessions'|'doctor'|'export')])),redaction:samples.map(text=>({text,expected:redactExportedText(text)}))};
const file='packages/protocol/contracts/native-cli/session-shell.json';const output=JSON.stringify(data,null,2)+'\n';
if(process.argv.includes('--write'))writeFileSync(file,output);else assert.equal(readFileSync(file,'utf8'),output,'regenerate actual TS session shell contracts');
console.log(`${cases.length} actual TS Store/list/export views, ${argv.length} parser cases and ${samples.length} redaction cases match.`);
