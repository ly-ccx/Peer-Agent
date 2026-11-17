// Development-only oracle. Native writes do not execute JS.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createNodeFileProvider} from '../../packages/runtime-node/dist/file-provider.js';
const file=new URL('../../packages/protocol/contracts/native-cli/file-parents.json',import.meta.url);
const data=JSON.parse(readFileSync(file,'utf8'));
const root=realpathSync(mkdtempSync(join(tmpdir(),'peer-file-parents-')));
writeFileSync(join(root,'.native-cli-fixture'),'owned synthetic fixtures');
for(const [i,c] of data.cases.entries()){
 const home=join(root,String(i)),workspace=join(home,'workspace');mkdirSync(workspace,{recursive:true});
 for(const d of c.directories??[])mkdirSync(join(home,d),{recursive:true});
 if(c.alias)symlinkSync(join(home,c.alias.target),join(home,c.alias.path),'dir');
 const provider=createNodeFileProvider({workspaceRoot:workspace,requestApproval:()=>({granted:!c.denied,reason:'synthetic'})});
 const result=await provider.execute({capabilityId:'local.file.write',input:c.args,toolCall:{toolCallId:'call',capabilityId:'local.file.write',input:c.args}},{runId:'run',sessionId:'s',workspace:{root:workspace}});
 const target=resolve(workspace,c.args.path);
 const actual={status:result.status,output:result.output??null,error:result.error?.code??null,targetExists:existsSync(target),targetContent:existsSync(target)?readFileSync(target,'utf8'):null};
 if(process.argv.includes('--write'))c.expected=actual;else assert.deepEqual(actual,c.expected,c.name);
}
if(process.argv.includes('--write'))writeFileSync(file,JSON.stringify(data,null,2)+'\n');
console.log(JSON.stringify({ok:true,cases:data.cases.length,root,scope:data.provenance}));
