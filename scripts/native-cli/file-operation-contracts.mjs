// Development oracle only. The native CLI never executes this script or JS.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createNodeFileProvider} from '../../packages/runtime-node/dist/file-provider.js';
const file=new URL('../../packages/protocol/contracts/native-cli/file-operations.json',import.meta.url);
const data=JSON.parse(readFileSync(file,'utf8'));
const root=mkdtempSync(join(tmpdir(),'peer-file-contract-'));writeFileSync(join(root,'.native-cli-fixture'),'isolated');
for(const [index,c] of data.cases.entries()){
  const workspace=join(root,String(index));mkdirSync(workspace);
  for(const [name,value] of Object.entries(c.files)){
    const target=join(workspace,name);mkdirSync(dirname(target),{recursive:true});
    writeFileSync(target,typeof value==='string'?value:value.hex?Buffer.from(value.hex,'hex'):value.repeat.repeat(value.count));
  }
  const provider=createNodeFileProvider({workspaceRoot:workspace,requestApproval:()=>({granted:true,reason:'synthetic'})});
  for(const [i,step] of c.steps.entries()){
    const result=await provider.execute({capabilityId:step.capability,input:step.args,toolCall:{toolCallId:`call-${i}`,capabilityId:step.capability,input:step.args}},{runId:'run',sessionId:'s',workspace:{root:workspace}});
    const actual={status:result.status,output:result.output??null,error:result.error?.code??null};
    if(process.argv.includes('--write'))step.expected=actual;else assert.deepEqual(actual,step.expected,`${c.name}/${i}`);
  }
}
for(const c of data.locales){
  const env={...process.env};for(const k of ['LANG','LC_ALL','LC_MESSAGES','LC_COLLATE'])delete env[k];Object.assign(env,c.env);
  const code='console.log(JSON.stringify({locale:new Intl.Collator().resolvedOptions().locale,lower:"IİΣΟΣ".toLocaleLowerCase(),sort:["Z","a","A","ä","Å","é","中","🙂"].sort((a,b)=>a.localeCompare(b))}))';
  const r=spawnSync(process.execPath,['-e',code],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),c.expected);
}
if(process.argv.includes('--write'))writeFileSync(file,JSON.stringify(data,null,2)+'\n');
console.log(JSON.stringify({ok:true,cases:data.cases.length,steps:data.cases.reduce((n,c)=>n+c.steps.length,0),locales:data.locales.length,root,scope:data.provenance.reference}));
