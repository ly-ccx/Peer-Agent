import { strict as assert } from 'node:assert';
import { readFileSync,writeFileSync } from 'node:fs';
import { automaticAccessDecision } from '../../apps/tui/src/tui-automatic-access.ts';
import { PROJECT_AGENT_ALLOWED_CAPABILITIES,evaluateProjectAgentTurn } from '../../packages/runtime-node/src/project-agent/mode-policy.mjs';
const file=new URL('../../packages/protocol/contracts/native-cli/access-policy.json',import.meta.url);
const automatic:any[]=[];const modes:any[]=[];
for(const level of ['ask_before_local','session_local','restricted_local','full_local'])for(const bot of [false,true])for(const kind of ['capability-approval','other'])for(const approvalKind of ['file-write','shell-exec','other'])for(const risk of ['L0_inert','L1_local_read','L2_local_write','L3_external_write','L4_privileged','L5_destructive','unknown']){
 const prompt={confirmation:{kind,approvalKind},riskLevel:risk};automatic.push({level,bot,prompt,expected:automaticAccessDecision(level as any,prompt as any,bot)});
}
for(const capabilityId of [...PROJECT_AGENT_ALLOWED_CAPABILITIES,'local.file.write','local.shell.exec','unknown'])for(const role of ['project_agent','work_session'])for(const permissionKind of [undefined,'file-write','shell','browser','browser-launch','browser_navigation']){
 const input={role,capabilityId,...(permissionKind?{permissionKind}:{})};modes.push({input,expected:evaluateProjectAgentTurn(input)});
}
const caps=new URL('../../packages/protocol/contracts/native-cli/project-agent-capabilities.json',import.meta.url);
const catalog={schemaVersion:1,capabilities:PROJECT_AGENT_ALLOWED_CAPABILITIES};
if(process.argv.includes('--update'))writeFileSync(caps,JSON.stringify(catalog,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(caps,'utf8')),catalog);
const fixture={schemaVersion:1,source:'actual TUI automatic access and project-agent mode policy',allowedProjectCapabilities:PROJECT_AGENT_ALLOWED_CAPABILITIES,automatic,modes};
if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(fixture,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),JSON.parse(JSON.stringify(fixture)));
console.log(`${automatic.length} automatic access and ${modes.length} role/mode policy cases match.`);
