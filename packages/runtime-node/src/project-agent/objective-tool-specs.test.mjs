import assert from 'node:assert/strict';
import test from 'node:test';
import { validateObjectiveToolInput } from './objective-tool-specs.mjs';
test('nested objective input rejects host fields and malformed probes or budgets before capability dispatch',()=>{
  const input={title:'CI',outcome:'keep green',anchorMessageId:'user',watches:[{watchId:'ci',kind:'schedule',schedule:{kind:'hourly',timezone:'UTC',everyHours:1},probe:{type:'deterministic',check:'command',spec:{command:'gh_run_list'}}}]};
  assert.equal(validateObjectiveToolInput('create_objective',input).ok,true);
  for(const value of [{...input,status:'active'}, {...input,budget:{maxAutoSessionsPerDay:4,maxProbeRunsPerDay:60}}, {...input,watches:[{...input.watches[0],nextRunAt:'forged'}]}, {...input,watches:[{...input.watches[0],probe:{type:'deterministic',check:'command',spec:{command:'bash'}}}]}])assert.equal(validateObjectiveToolInput('create_objective',value).ok,false);
  assert.equal(validateObjectiveToolInput('update_objective',{objectiveId:'a',milestones:[{id:'m',title:'task',sessionIds:[],status:'active',confirmed:true}]}).ok,false);
});
