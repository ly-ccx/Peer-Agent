import { projectTuiGoalFacts } from './goal-reference.ts';
import { strict as assert } from 'node:assert';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';import { join } from 'node:path';import { tmpdir } from 'node:os';
import { createGoalPlanStore } from '../../packages/runtime-node/src/goal-plan-store.mjs';
const at='2026-11-14T04:00:00.000Z';const DateBefore=Date;
class FixedDate extends DateBefore{constructor(...args:any[]){super(...(args.length?args:[at]) as [any]);}static now(){return DateBefore.parse(at);}}
(globalThis as any).Date=FixedDate;
const file=new URL('../../packages/protocol/contracts/native-cli/goal-execution-facts.json',import.meta.url);
const root=mkdtempSync(join(tmpdir(),'peer-native-goal-contracts-'));const cases:any[]=[];

const base={planId:'p',conversationId:'c',status:'executing',version:1,createdAt:'2026-11-13T00:00:00.000Z',updatedAt:'2026-11-14T03:00:00.000Z',tasks:[{taskId:'t',status:'pending'}],future:{opaque:'preserved'}};
const selected={providerId:'provider',modelId:'model',modelProviderId:'provider::model',family:'openai',reasoningEffort:'high',fastMode:false};
const origin={anchorMessageId:'anchor',inputId:'input',surface:'tui',workspaceId:'w',sessionId:'s',workId:'work',parentConversationId:'bot',modelSelection:{worker:selected,explorer:selected,verifier:{...selected,sameFamilyAsWorker:true},source:{worker:'project'},resolvedAt:at},phase:'running',executionGeneration:'generation',coordinationBinding:{workId:'work',goalRevision:2,executionEpoch:'epoch'}};
function add(name:string,patch:any,progress?:any){
 const raw={...structuredClone(base),...patch};const folder=join(root,String(cases.length));mkdirSync(folder);writeFileSync(join(folder,'p.json'),JSON.stringify(raw));if(progress){mkdirSync(join(folder,'runner-progress'));writeFileSync(join(folder,'runner-progress/p.json'),JSON.stringify({planId:'p',...progress}));}
 const store=createGoalPlanStore({storeDir:folder});const plan=store.getPlan('p');assert.ok(plan,name);cases.push({name,now:at,raw,...(progress?{progress:{planId:'p',...progress}}:{}),expected:projectTuiGoalFacts(plan)});
}
add('ordinary executing',{});add('rejected approval overrides status',{approval:{decision:'reject'}});add('paused plan',{status:'paused'});
add('interrupted completed leaves',{status:'interrupted',tasks:[{status:'completed'}]});add('failed completed leaves',{status:'failed',tasks:[{status:'completed'},{status:'cancelled'}]});
add('unconsumed interruption holds',{status:'interrupted',tasks:[{status:'completed'}],runner:{enabled:true,status:'paused',updatedAt:at,interruption:{source:'stream_error',reason:'failed',interruptedAt:at}}});
add('recoverable live interruption consumed',{status:'interrupted',tasks:[{status:'completed'}],runner:{enabled:true,status:'running',updatedAt:at,interruption:{source:'stream_error',reason:'retrying',interruptedAt:at,recoverable:true,attempt:2}}});
add('malformed interruption is not a hold',{status:'interrupted',tasks:[{status:'completed'}],runner:{status:'paused',updatedAt:at,interruption:{source:'stream_error',reason:'missing time'}}});
add('failed leaf stays failed',{status:'failed',tasks:[{status:'failed'}]});add('runner counts normalized',{runner:{enabled:'truthy',status:'wrong',turnCount:-1.5,roundCount:2.8,toolCallCount:3.7,explorerCount:-1,runId:' run ',currentTaskId:' task ',intent:'verify',phase:'repair'}});
add('delegated current identity',{delegationOrigin:origin});add('legacy execution identity',{delegationOrigin:{...origin,coordinationBinding:undefined,executionGeneration:undefined}});
add('superseded origin stops inheritance',{delegationOrigin:{...origin,phase:'superseded',supersededBy:'new'}});
add('cancellation preserves unknown',{delegationOrigin:{...origin,cancellation:{operationId:'cancel',phase:'awaiting_outcome',unknownCalls:['call'],future:{keep:true}}}});
add('invalid origin normalizes absent',{delegationOrigin:{workspaceId:'w',sessionId:'s',phase:'paused'}});
add('execution control and scope metadata',{delegationOrigin:{...origin,executionControl:{operationId:'control',sessionId:'s',planId:'p',revision:2,phase:'draining',future:{keep:true}},capabilityAdmission:{required:[' local.file.read ','local.file.read'],inventoryHash:null,inventoryKnown:true,requirementsDeclared:true,checkedAt:at},dependsOn:[' a ','','b'],readOnly:false,verifying:true,priority:'high',isolation:'worktree',handoffAuthorizedAt:at}});
add('older runner progress ignored',{runner:{status:'running',updatedAt:at}},{status:'paused',updatedAt:'2026-11-14T03:00:00.000Z',runner:{status:'paused',updatedAt:'2026-11-14T03:00:00.000Z'}});
add('same time sidecar wins',{runner:{status:'running',updatedAt:at}},{status:'paused',updatedAt:at,runner:{status:'paused',updatedAt:at,turnCount:4}});
add('newer progress stops execution',{runner:{status:'running',updatedAt:'2026-11-14T02:00:00.000Z'}},{status:'interrupted',updatedAt:at,runner:{status:'paused',updatedAt:at,interruption:{source:'user',reason:'pause',interruptedAt:at}}});
add('approval remains rejected after sidecar',{approval:{decision:'reject'},runner:{status:'running',updatedAt:'2026-11-14T02:00:00.000Z'}},{status:'executing',updatedAt:at,runner:{status:'running',updatedAt:at}});
add('nested leaf progress',{tasks:[{status:'failed',subtasks:[{status:'completed'},{status:'failed'},{status:'waiting_user'}]},{status:'cancelled'}]});
add('numeric legacy conversation',{conversationId:123});add('malformed continuation preserved',{runner:{status:'paused',updatedAt:at,verificationContinuation:{malformed:'retained'}}});
const fixture={schemaVersion:1,source:'native TUI projection of actual createGoalPlanStore.getPlan',cases};
if(process.argv.includes('--update'))writeFileSync(file,JSON.stringify(fixture,null,2)+'\n');else assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),JSON.parse(JSON.stringify(fixture)));
(globalThis as any).Date=DateBefore;
console.log(`${cases.length} actual TS canonical Goal execution projections match.`);
