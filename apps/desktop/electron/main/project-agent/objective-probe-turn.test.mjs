import assert from 'node:assert/strict';
import test from 'node:test';
import {runObjectiveProbeTurn} from './objective-probe-turn.mjs';
test('temporary objective probe keeps real SDK executions apart from model summaries and cannot claim summary-only evidence',async()=>{
 const request={workspaceId:'ws',workspacePath:'/fixture',objectiveId:'o',watchId:'w',question:'Read actual file'};let seen;
 const agentTurnExecutor={resolveGoalRole:()=>({ok:true,selection:{modelProviderId:'economy'}}),async runTurn(input){seen=input;input.sink.send('chat:stream:delta',{content:'unsupported claim'});return {ok:true};}};
 assert.equal((await runObjectiveProbeTurn({request,agentTurnExecutor})).unavailableReason,'agent_probe_no_evidence');assert.equal(seen.conversationId,null);assert.equal(seen.mode,'explorer');assert.equal(seen.sink.approver,'none');assert.equal(seen.permissionPolicy.kind,'objective_probe');
 const execution={call:{capabilityId:'local.file.read',arguments:{path:'a'}},grant:{granted:true},result:{status:'success',outputPreview:{content:'actual'}}};
 agentTurnExecutor.runTurn=async input=>{input.agentProgress.onToolExecution(execution);input.sink.send('chat:stream:delta',{content:'summary'});return {ok:true};};
 const result=await runObjectiveProbeTurn({request,agentTurnExecutor});assert.equal(result.ok,true);assert.deepEqual(result.toolExecutions,[execution]);assert.equal(result.succeeded,undefined);
});
