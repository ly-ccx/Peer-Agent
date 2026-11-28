// Development-only reference: real TS GitRead/Provider and owned Git repositories.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createGitRead,validateGitReadQuery} from '../../packages/runtime-node/src/git-read.mjs';
import {createLocalGitProvider} from '../../packages/runtime-node/src/local-git-provider.mjs';
import {NODE_GIT_CAPABILITY_MANIFESTS} from '../../packages/runtime-node/src/git-provider.ts';

const temporary=realpathSync(mkdtempSync(join(tmpdir(),'peer-native-git-contract-')));
// The legacy preview budget includes absolute paths. Keep their byte length
// identical on Darwin/Linux, then normalize only for the committed oracle.
assert.ok(temporary.length<199);
const root=join(temporary,'x'.repeat(199-temporary.length));mkdirSync(root);
writeFileSync(join(root,'.native-cli-fixture'),'isolated');
const home=join(root,'home');mkdirSync(home);
// GitRead deliberately strips GIT_*; this test-only executable removes the
// machine's system config too, without changing the product's executable seam.
const binary=join(root,'owned-git');
writeFileSync(binary,'#!/bin/sh\nexport GIT_CONFIG_NOSYSTEM=1\nexec /usr/bin/git "$@"\n',{mode:0o700});
process.env.HOME=home;process.env.XDG_CONFIG_HOME=join(home,'config');
process.env.PATH='/usr/bin:/bin';
// Git versions spell UTC's %cI as either Z or +00:00. A fixed nonzero
// committer offset keeps the actual raw timestamp contract portable; no
// production timestamp is rewritten or ignored by the oracle comparison.
const env={PATH:'/usr/bin:/bin',HOME:home,XDG_CONFIG_HOME:join(home,'config'),
  GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Native Fixture',GIT_AUTHOR_EMAIL:'native@example.invalid',
  GIT_COMMITTER_NAME:'Native Fixture',GIT_COMMITTER_EMAIL:'native@example.invalid',
  GIT_AUTHOR_DATE:'2026-11-17T00:00:00+05:30',GIT_COMMITTER_DATE:'2026-11-17T00:00:00+05:30',TZ:'UTC'};
const base=[{git:['init','--initial-branch=main','repo']},
  {write:'repo/tracked.txt',content:'original\n'},
  {git:['add','tracked.txt'],cwd:'repo'},{git:['commit','-m','base'],cwd:'repo'}];
const definitions=[
  {name:'clean',actions:[],input:{path:'repo'}},
  {name:'changes',actions:[{git:['mv','tracked.txt','renamed file.txt'],cwd:'repo'},
    {write:'repo/renamed file.txt',content:'changed\n'},{write:'repo/new\tname.txt',content:'fact'},
    {write:'repo/new\nline🦀.txt',content:'unicode'}],input:{path:'repo',limit:2}},
  {name:'status',actions:[{write:'repo/tracked.txt',content:'modified'}],input:{path:'repo',operation:'status',limit:1}},
  {name:'log',actions:[{write:'repo/second.txt',content:'second'},
    {git:['add','second.txt'],cwd:'repo'},{git:['commit','-m','second sk-ABCDEFGHIJKLMNOPQRSTUV'],cwd:'repo'}],input:{path:'repo',operation:'log',limit:2}},
  {name:'detached',actions:[{git:['checkout','--detach'],cwd:'repo'}],input:{path:'repo'}},
  {name:'branch-js-trim',actions:[{git:['checkout','-b','\ufeffbranch\ufeff'],cwd:'repo'}],input:{path:'repo'}},
  {name:'branch-next-line',actions:[{git:['checkout','-b','branch\u0085'],cwd:'repo'}],input:{path:'repo'}},
  {name:'unborn',base:[{git:['init','--initial-branch=main','repo']}],actions:[],input:{path:'repo'}},
  {name:'worktree',actions:[{git:['worktree','add','--detach','../linked'],cwd:'repo'}],input:{path:'linked'}},
  {name:'included-filter',actions:[{write:'outside-config',content:'[filter "hostile"]\n clean = touch UNEXPECTED_EXECUTION\n process = touch UNEXPECTED_EXECUTION\n required = true\n'},
    {git:['config','include.path','../../outside-config'],cwd:'repo'},
    {git:['config','core.fsmonitor','touch UNEXPECTED_EXECUTION'],cwd:'repo'},
    {write:'repo/.gitattributes',content:'*.txt filter=hostile\n'},{write:'repo/tracked.txt',content:'changed'}],input:{path:'repo'}},
  {name:'submodule',actions:[{git:['update-index','--add','--cacheinfo','160000','<HEAD>','dependency'],cwd:'repo'},
    {git:['commit','-m','gitlink without recursive inspection'],cwd:'repo'}],input:{path:'repo'}},
  {name:'origin-redaction',actions:[{git:['config','remote.origin.url','https://user:private-token@example.invalid/repo?access_token=secret'],cwd:'repo'}],input:{path:'repo'}},
  {name:'long-origin',actions:[{git:['config','remote.origin.url','https://example.invalid/'+'x'.repeat(5000)],cwd:'repo'}],input:{path:'repo'},nativeFieldsTruncated:['origin']},
  {name:'long-subject',actions:[{git:['commit','--allow-empty','-m','x'.repeat(5000)],cwd:'repo'}],input:{path:'repo'},nativeFieldsTruncated:['commits.subject']},
  {name:'preview',actions:Array.from({length:96},(_,i)=>({write:`repo/${String(i).padStart(3,'0')}-${'name'.repeat(20)}.txt`,content:'fact'})),input:{path:'repo',limit:200}},
  {name:'not-repository',actions:[{mkdir:'outside'}],input:{path:'outside'}},
  {name:'missing',actions:[],input:{path:'missing'}},
];
function normalize(value,scope){
  if(Array.isArray(value))return value.map(v=>normalize(v,scope));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,
    ['startedAt','finishedAt','completedAt'].includes(k)?'<time>':normalize(v,scope)]));
  return typeof value==='string'?value.replaceAll(scope,'<root>'):value;
}
const vectors=[];
for(const spec of definitions){
  const scope=join(root,spec.name);mkdirSync(scope);
  const run=(args,cwd='.')=>execFileSync(binary,args,{cwd:join(scope,cwd),env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  for(const action of [...(spec.base??base),...spec.actions]){
    if(action.git){const args=action.git.map(v=>v==='<HEAD>'?run(['rev-parse','HEAD'],'repo'):v);run(args,action.cwd);}
    else if(action.write){const path=join(scope,action.write);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,action.content);}
    else mkdirSync(join(scope,action.mkdir),{recursive:true});
  }
  const input={...spec.input,path:resolve(scope,spec.input.path)};
  let indexPath;
  try{indexPath=resolve(input.path,run(['rev-parse','--git-path','index'],spec.input.path));}catch{}
  const beforeIndex=indexPath&&existsSync(indexPath)?readFileSync(indexPath):null;
  const authorized=[];let engine,error;
  try{engine=await createGitRead({binary})(input,{authorize:async path=>{authorized.push(path);assert.ok(path===scope||path.startsWith(scope+'/'),'fixture read escaped owned repository');}});}
  catch(e){error=e.reason??(e.code==='ENOENT'?'git_path_not_found':'unexpected_git_error');}
  const requested=[];
  const provider=createLocalGitProvider({workspaceRoot:join(scope,'repo'),artifactBaseDir:join(scope,'artifacts'),query:createGitRead({binary})});
  const call={toolCallId:'actual-git-call',capabilityId:'local.git.query',arguments:input};
  const observed=await provider.executeCapability({call},{toolContext:{conversationId:'c'},requestPermission:async p=>{requested.push(p.filePath);return {granted:true,validate:()=>true};}});
  if(spec.name==='included-filter'){
    assert.ok(engine.configurationSources.includes(join(scope,'outside-config')));
    assert.equal(engine.status.filtersDisabled,true);assert.equal(engine.status.clean,null);
    assert.ok(requested.includes(join(scope,'outside-config')));
  }
  const preview=structuredClone(observed.result.outputPreview);
  let artifact=null;
  if(preview.artifactPath){artifact=JSON.parse(readFileSync(preview.artifactPath,'utf8'));preview.artifactPath='<artifact>';preview.retrievalHint.path='<artifact>';
    assert.deepEqual(normalize(artifact,scope),normalize({kind:'local_git_observation',...engine},scope));}
  assert.equal(existsSync(join(scope,'repo/UNEXPECTED_EXECUTION')),false);
  if(indexPath){assert.deepEqual(existsSync(indexPath)?readFileSync(indexPath):null,beforeIndex);assert.equal(existsSync(indexPath+'.lock'),false);}
  const {granted,scope:grantScope}=observed.grant;
  vectors.push({name:spec.name,base:spec.base??base,actions:spec.actions,input:spec.input,
    engine:engine?normalize(engine,scope):{error},authorized:normalize(authorized,scope),nativeFieldsTruncated:spec.nativeFieldsTruncated??[],
    provider:normalize({status:observed.result.status,grant:{granted,scope:grantScope},requested,preview,artifact},scope)});
}
const invalid=[null,[],{}, {path:'.',command:'touch x'},{path:'.',env:{}},{path:'.',operation:'fetch'},
  {path:'.',limit:201},{path:'.',limit:0},{path:'.',limit:1.5},{path:'x\nname'},{path:'x\u0000name'}];
for(const input of invalid)assert.throws(()=>validateGitReadQuery(input),{reason:'git_query_invalid_input'});
const failures=[];
for(const [name,options]of [['output-limit',{maxBytes:1}],['timeout',{timeoutMs:0}],['missing-git',{binary:join(root,'no-executable')}]]){
  let reason;try{await createGitRead({binary,...options})({path:join(root,'clean/repo')},{authorize:async()=>{}});}catch(e){reason=e.reason;}assert.ok(reason);failures.push({name,reason});
}
const denialRoot=join(root,'worktree');
const deniedProvider=createLocalGitProvider({workspaceRoot:join(denialRoot,'repo'),query:createGitRead({binary}),artifactBaseDir:join(denialRoot,'denied-artifacts')});
const denied=await deniedProvider.executeCapability({call:{toolCallId:'denied',capabilityId:'local.git.query',arguments:{path:join(denialRoot,'linked')}}});
assert.equal(denied.result.status,'denied');assert.equal(denied.result.outputPreview.reason,'git_read_permission_required');
assert.equal(existsSync(join(denialRoot,'denied-artifacts')),false);
const {operation,limit}=validateGitReadQuery({path:'.'});
const contract={schemaVersion:1,manifest:NODE_GIT_CAPABILITY_MANIFESTS[0],defaults:{operation,limit},limits:{executionMs:15000,rawBytes:8388608,pathBytes:8192,statusEntries:16384,statusPathBytes:4194304,configSources:128,originEntries:128,filterKeys:128,filterKeyBytes:512,observationJsonBytes:8388608,previewUnits:4000},provenance:'Actual legacy TS GitRead and LocalGitProvider over real synthetic Git repositories; system configuration isolated by test-only Git wrapper. No Node/Bun engine is shipped.'};
const cases={schemaVersion:1,vectors,invalid,failures,outsideDenial:{status:denied.result.status,reason:denied.result.outputPreview.reason,granted:denied.grant.granted}};
for(const [name,value]of [['git-query.json',contract],['git-query-cases.json',cases]]){
  const path=new URL('../../packages/protocol/contracts/native-cli/'+name,import.meta.url);
  if(process.argv.includes('--write'))writeFileSync(path,JSON.stringify(value,null,2)+'\n');else assert.deepEqual(value,JSON.parse(readFileSync(path,'utf8')));
}
writeFileSync(join(root,'observations.json'),JSON.stringify(cases,null,2)+'\n');
console.log(JSON.stringify({ok:true,root,cases:vectors.length,invalid:invalid.length,failures:failures.length,scope:'Actual TS GitRead/Provider/files using real owned Git, not a native Host or permission UI claim.'}));
