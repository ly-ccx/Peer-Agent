// Development oracle only. The product has no JS runtime dependency.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRuntimeProjection} from '../../packages/runtime-core/src/projection.ts';
import {TUI_RUNTIME_MODES} from '../../apps/tui/src/tui-mode.ts';
import {createTuiHost} from '../../apps/tui/src/tui-host.ts';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const file=new URL('../../packages/protocol/contracts/native-cli/runtime-projection.json',import.meta.url);
const data=JSON.parse(readFileSync(file,'utf8'));
assert.deepEqual(data.modes,[...TUI_RUNTIME_MODES]);
let checks=0;
for(const c of data.cases) {
 const observed=[];
 for(const mode of data.modes) {
  const tool={name:'fixture',capabilityId:'local.fixture',description:'Synthetic manifest',inputSchema:{type:'object'},...c.manifest};
  try {
   const projection=createRuntimeProjection([tool],{mode,createdAt:'2026-11-18T00:00:00.000Z'});
   observed.push({mode,available:projection.tools.length===1});
  } catch(error) {
   assert.equal((error as {code:string}).code,'invalid_tool_definition');
   observed.push({mode,error:'manifest_invalid'});
  }
  checks++;
 }
 if(process.argv.includes('--write')) c.expected=observed;
 else assert.deepEqual(observed,c.expected,c.name);
}
const root=mkdtempSync(join(tmpdir(),'peer-native-mode-reference-'));
mkdirSync(join(root,'workspace'));mkdirSync(join(root,'home'));
writeFileSync(join(root,'.native-cli-fixture'),'isolated');
const host=createTuiHost({workspaceRoot:join(root,'workspace'),userDataPath:join(root,'home'),accessLevel:'ask_before_local',hookRunner:null});
try {
 const supported=new Set(['local.file.read','local.file.list','local.file.search','local.file.edit','local.file.write','local.search.aggregate','local.git.query','local.shell.exec','local.web.fetch']);
 const membership=TUI_RUNTIME_MODES.map(mode=>({mode,capabilities:host.toolDefinitionsForMode!(mode).map(t=>t.capabilityId).filter(id=>supported.has(id)).sort()}));
 if(process.argv.includes('--write'))data.localMembership=membership;
 else assert.deepEqual(membership,data.localMembership,'Actual TUI migrated local capability membership');
}finally{await host.dispose()}
if(process.argv.includes('--write'))writeFileSync(file,JSON.stringify(data,null,2)+'\n');
console.log(JSON.stringify({ok:true,cases:data.cases.length,checks,scope:'Actual shared TS projection validates and filters the same synthetic manifests for every existing runtime mode. No execution or permission granted.'}));
