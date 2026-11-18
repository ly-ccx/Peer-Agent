// Actual shared TS Source and TUI Host settings -> native Source on the same
// owned files, including real path-dependent hashes. Development only.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createTuiLanguageStore} from '../../apps/tui/src/tui-language.ts';
import {createTuiThemeStore} from '../../apps/tui/src/tui-theme.ts';
import {createTuiLocalAccessStore} from '../../apps/tui/src/tui-local-access-store.ts';
import {buildHostConfigInstructions} from '../../packages/system-context/src/host-config-instructions.mjs';
import {createProjectInstructionsPromptSource} from '../../packages/system-context/src/sources/project-instructions-source.mjs';
import {createPromptSourceRegistry} from '../../packages/system-context/src/prompt-source-registry.mjs';
import {assembleSystemContext} from '../../packages/system-context/src/prompt-assembler.mjs';
const binary=resolve('target/debug/examples/instruction-conformance');
const root=mkdtempSync(join(tmpdir(),'peer-native-instruction-conformance-'));
let cases=0;
try {
 const home=join(root,'home'),workspace=join(root,'workspace');
 mkdirSync(home);mkdirSync(workspace);writeFileSync(join(home,'.native-cli-fixture'),'isolated');
 writeFileSync(join(workspace,'.native-cli-fixture'),'isolated');
 const put=(file:string,text:string)=>{mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,text);};
 for(const [file,text]of Object.entries({'AGENTS.md':'root guidance','CLAUDE.md':'other root guidance',
  'src/AGENTS.md':'source guidance','src/deep/CLAUDE.md':'deep guidance','other/AGENTS.md':'other guidance',
  '中文🙂/AGENTS.md':'Unicode path guidance','..hidden/AGENTS.md':'legacy prefix rule excludes this target',
 }))put(join(workspace,file),text);
 put(join(home,'AGENTS.md'),'global guidance');
 const run=(input:Record<string,unknown>)=>{
  const p=spawnSync(binary,[],{input:JSON.stringify({workspace,home,...input}),encoding:'utf8',timeout:5000});
  assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);
 };
 const compare=(input:Record<string,any>,config:unknown[]=[])=>{
  const actual=run(input);
  const source=createProjectInstructionsPromptSource();
  const expected=assembleSystemContext({workspacePath:workspace,dataHomePath:home,
   includeGlobalInstructions:input.global===true,targetPaths:input.targets??[],configInstructions:config},
   {registry:createPromptSourceRegistry({sources:[source]})});
  const sort=(sections:Record<string,any>[])=>[...sections].sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id));
  assert.deepEqual(sort(actual.sections),expected.sections,JSON.stringify(input));cases++;
 };
 const configs=[{id:'Host ID🙂',title:'A typed Host instruction',content:'  configured guidance\n',source:null,priority:-2},
  {id:'other',title:'Other instruction',content:'a'.repeat(23999)+'🙂tail',source:'a source',priority:0}];
 for(const input of [ {},{global:true},{global:true,config:configs},
  {targets:['src/deep/missing.rs','src','src/deep/missing.rs','other']},
  {targets:['../escape/file','..hidden/file',root,join(workspace,'src/deep'),'中文🙂/file']},
  {global:true,targets:['src/../other/file','src/./deep/file'],config:configs},
  {global:true,config:[{id:'',title:'',content:'fallback fields',source:'',priority:0},
    {id:'empty',title:'empty',content:'',source:null,priority:1},
    {id:'space',title:'space',content:'   ',source:null,priority:2}]},
 ])compare(input,input.config??[]);
 // Global and workspace may name the same candidate. Preserve the original
 // global scope/priority and deduplicate the path before observation.
 const same=run({home:workspace,global:true});
 const expectedSame=assembleSystemContext({workspacePath:workspace,dataHomePath:workspace,includeGlobalInstructions:true},
  {registry:createPromptSourceRegistry({sources:[createProjectInstructionsPromptSource()]})});
 assert.deepEqual(same.sections,expectedSame.sections);cases++;
 // A symlink's physical target is read once under the same explicit Source
 // input; this is guidance discovery and never a file-effect authorization.
 symlinkSync(join(workspace,'src'),join(workspace,'alias'));
 compare({targets:['alias/deep/file']});
 const settingsCases=[null,{}, {locale:'en-US'}, {locale:' EN_any ',replyLanguage:null},
  {replyLanguage:'auto'}, {replyLanguage:''},{replyLanguage:'unknown'},
  {schemaVersion:3,systemInstructions:' \nConfigured guidance🙂 ',replyLanguage:'ja-JP',gitBranchPrefix:' custom/ '},
  {schemaVersion:0,systemInstructions:'x'.repeat(24001),gitBranchPrefix:' '},
  ...['zh-CN','zh-TW','en-US','ja-JP','ko-KR','fr-FR','de-DE','es-ES','ru-RU'].map(replyLanguage=>({replyLanguage})),
 ];
 for(const [index,settings]of settingsCases.entries()){
  const file=join(home,'settings.json');
  if(settings===null)rmSync(file,{force:true});else writeFileSync(file,JSON.stringify(settings));
  // Exercise the real existing TUI Host in an isolated copy: its legacy
  // migration writes must not alter the source being observed by native.
  const tsHome=join(root,`tui-${index}`);mkdirSync(tsHome);
  if(settings!==null)writeFileSync(join(tsHome,'settings.json'),JSON.stringify(settings));
  const original=settings===null?null:readFileSync(file,'utf8');
  const prompt=createTuiLanguageStore({userDataPath:tsHome}).getPromptSettings();
  compare({host:true},buildHostConfigInstructions(prompt));
  assert.equal(settings===null?null:readFileSync(file,'utf8'),original);
 }
 const legacyHome=join(root,'actual-legacy-v3-settings');
 mkdirSync(legacyHome);
 createTuiThemeStore({userDataPath:legacyHome,systemThemeWatch:false}).setMode('light');
 const legacyLanguage=createTuiLanguageStore({userDataPath:legacyHome});
 legacyLanguage.setLanguage('en-US');
 createTuiLocalAccessStore({userDataPath:legacyHome}).setAccessLevel('full_local');
 const legacySettings=readFileSync(join(legacyHome,'settings.json'),'utf8');
 const sharedFixture=readFileSync(new URL('../../packages/protocol/contracts/native-cli/settings-v3-from-tui.json',import.meta.url),'utf8');
 assert.equal(legacySettings,sharedFixture);
 const nativeSettings=join(home,'settings.json');
 writeFileSync(nativeSettings,legacySettings);
 compare({host:true},buildHostConfigInstructions(legacyLanguage.getPromptSettings()));
 assert.equal(readFileSync(nativeSettings,'utf8'),legacySettings);
 const withOnboarding=JSON.parse(legacySettings);
 withOnboarding.projectAgent.shellIntroPending=true;
 withOnboarding.projectAgent.shellIntroDismissed=false;
 writeFileSync(nativeSettings,JSON.stringify(withOnboarding));
 compare({host:true},buildHostConfigInstructions(legacyLanguage.getPromptSettings()));
 assert.deepEqual(run({cancel:true}),{error:'cancelled'});cases++;
 console.log(JSON.stringify({ok:true,cases,scope:'actual TS Source / TUI prompt settings -> native, owned files and unchanged original settings'}));
}finally{rmSync(root,{recursive:true,force:true});}
