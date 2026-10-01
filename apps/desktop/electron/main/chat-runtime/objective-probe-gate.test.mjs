import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {evaluateObjectiveProbeCall} from './objective-probe-gate.mjs';
import {executeProjectedModelTool} from './projected-tool-executor.mjs';
test('objective probe policy refuses every side effect and realpath escape, including aggregate lanes',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'probe-gate-')),outside=mkdtempSync(path.join(os.tmpdir(),'probe-other-'));
 try{
  writeFileSync(path.join(root,'a'),'actual');writeFileSync(path.join(outside,'private'),'private');symlinkSync(outside,path.join(root,'escape'));
  const policy={kind:'objective_probe',workspacePath:root};const check=(capabilityId,args={})=>evaluateObjectiveProbeCall({policy,call:{capabilityId,arguments:args},workspacePath:root});
  for(const capability of ['local.file.write','local.file.edit','local.shell.exec','local.mcp.call','local.skill.invoke','local.browser.navigate','local.goal.create'])assert.equal(check(capability).allowed,false,capability);
  assert.equal(check('local.file.read',{path:'a'}).allowed,true);
  assert.equal(check('local.file.read',{path:'escape/private'}).reason,'objective_probe_outside_workspace');
  assert.equal(check('local.search.aggregate',{queries:[{path:'.'},{path:outside}]}).allowed,false);
  assert.equal(evaluateObjectiveProbeCall({policy,call:{capabilityId:'local.file.read',arguments:{path:'a'}},workspacePath:outside}).allowed,false);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('actual projected tools cannot use full access to write or follow an escaped read in an objective probe',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'probe-projection-')),outside=mkdtempSync(path.join(os.tmpdir(),'probe-projection-other-'));
 try{
  writeFileSync(path.join(outside,'private'),'secret');symlinkSync(outside,path.join(root,'escape'));
  const toolContext={mode:'chat',permissionMode:'full-access',permissionPolicy:{kind:'objective_probe',workspacePath:root},readFiles:new Map()};
  for(const [name,args]of [['write_file',{path:path.join(root,'forbidden'),content:'no'}],['read_file',{path:'escape/private'}]]){
   const result=await executeProjectedModelTool({name,args,workspacePath:root,toolContext,toolCallId:`probe-${name}`});
   assert.equal(result.execution.grant.granted,false);assert.equal(result.execution.result.status,'denied');assert.ok(result.execution.result.evidence);
  }
  assert.equal(existsSync(path.join(root,'forbidden')),false);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
