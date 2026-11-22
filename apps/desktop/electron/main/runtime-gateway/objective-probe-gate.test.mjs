import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateObjectiveProbeCall, objectiveProbeDenial } from './objective-probe-gate.mjs';
import { createLocalToolHost } from './local-tool-host.mjs';
test('objective probe policy refuses every side effect and realpath escape, including aggregate lanes',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'probe-gate-')),outside=mkdtempSync(path.join(os.tmpdir(),'probe-other-'));
 try{
  writeFileSync(path.join(root,'a'),'actual');writeFileSync(path.join(outside,'private'),'private');symlinkSync(outside,path.join(root,'escape'));
  const policy={kind:'objective_probe',workspacePath:root};const check=(capabilityId,args={})=>evaluateObjectiveProbeCall({policy,call:{capabilityId,arguments:args},workspacePath:root});
  for(const capability of ['local.file.write','local.file.edit','local.shell.exec','local.mcp.call','local.skill.invoke','local.browser.navigate','local.goal.create'])assert.equal(check(capability).allowed,false,capability);
  assert.equal(check('local.file.read',{path:'a'}).allowed,true);
  assert.equal(check('local.file.read',{path:'escape/private'}).reason,'objective_probe_outside_workspace');
  assert.equal(check('local.search.aggregate',{queries:[{path:'.'},{path:outside}]}).allowed,false);
  writeFileSync(path.join(outside,'large'),Buffer.alloc(1024*1024+1));
  for(const target of ['private','large','missing']){
   assert.equal(check('local.file.read',{path:path.join(outside,target)}).reason,'objective_probe_outside_workspace');
   assert.equal(check('local.file.read',{path:`../${path.basename(outside)}/${target}`}).reason,'objective_probe_outside_workspace');
   assert.equal(check('local.file.read',{path:`escape/${target}`}).reason,'objective_probe_outside_workspace');
  }
  assert.equal(evaluateObjectiveProbeCall({policy,call:{capabilityId:'local.file.read',arguments:{path:'a'}},workspacePath:outside}).allowed,false);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('actual local tool host cannot bypass objective probe read-only gate even with full-access approval', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'probe-projection-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'probe-projection-other-'));
  const host = createLocalToolHost({
    workspaceRoot: root,
    userDataPath: root,
    sessionStore: { getSession() { return { locale: 'en-US' }; } },
  });
  try {
    writeFileSync(path.join(outside, 'private'), 'secret');
    symlinkSync(outside, path.join(root, 'escape'));
    const policy = { kind: 'objective_probe', workspacePath: root };
    const checks = [
      { toolCallId: 'probe-write', name: 'write_file', capabilityId: 'local.file.write', arguments: { path: path.join(root, 'forbidden'), content: 'no' } },
      { toolCallId: 'probe-read', name: 'read_file', capabilityId: 'local.file.read', arguments: { path: 'escape/private' } },
    ];
    for (const call of checks) {
      const verdict = evaluateObjectiveProbeCall({ policy, call, workspacePath: root });
      assert.equal(verdict.applies, true);
      assert.equal(verdict.allowed, false);
      const denied = objectiveProbeDenial(call, verdict.reason);
      assert.equal(denied.execution.grant.granted, false);
      assert.equal(denied.execution.result.status, 'denied');
      assert.ok(denied.execution.result.evidence);
      const blockedByHost = await host.execute(
        { call },
        {
          toolContext: { workspacePath: root, permissionMode: 'full-access', permissionPolicy: policy },
          requestPermission: async () => ({ granted: true, duration: 'always' }),
        },
      );
      assert.notEqual(blockedByHost?.result?.status, 'success');
    }
    assert.equal(existsSync(path.join(root, 'forbidden')), false);
  } finally {
    host.unsubscribeRuntimeEvents();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
