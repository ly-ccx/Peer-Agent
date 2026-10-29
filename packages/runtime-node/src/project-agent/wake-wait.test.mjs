import test from 'node:test';
import assert from 'node:assert/strict';
import { hostWakeWait, waitResult } from './wake-wait.mjs';
import { createDelegationProvider } from './delegation-provider.mjs';
import { validateDelegationInput } from './tool-specs.mjs';

test('host waiting is confined to routine current owned execution, never human waits or repair', () => {
  const job = { kind: 'wake', events: [{ kind: 'session_resumed', sessionId: 's' }] };
  const work = { workId: 'w', sessionIds: ['s'] };
  const rows = [{ sessionId: 's', status: 'running' }];
  assert.deepEqual(hostWakeWait(job, work, rows), { sessionIds: ['s'], source: 'host' });
  for (const status of ['waiting_user', 'waiting_agent', 'result_ready', 'interrupted', 'cancelled', 'accepted']) {
    assert.equal(hostWakeWait(job, work, [{ ...rows[0], status }]), null);
  }
  for (const extra of [{ kind: 'user' }, { interactive: true }, { continuation: true }, { userInputs: [{}] },
    { events: [{ kind: 'result_ready', sessionId: 's' }] }, { events: [{ kind: 'permission_timeout', sessionId: 's' }] }]) {
    assert.equal(hostWakeWait({ ...job, ...extra }, work, rows), null);
  }
  assert.equal(hostWakeWait(job, { ...work, recovery: { failureKind: 'fatal' } }, rows), null);
  assert.equal(hostWakeWait(job, { ...work, sessionIds: [] }, rows), null);
  assert.equal(hostWakeWait(job, work, [{ ...rows[0], needsUser: true }]), null);
});

test('waiting tool validates current ownership and returns paired grant, evidence and terminal control', async () => {
  const session = { workspaceId: 'w', status: 'running', origin: { parentConversationId: 'c', workId: 'work' } };
  const provider = createDelegationProvider({ supervisor: { get: () => session } });
  const context = { mode: 'project_agent', workspaceId: 'w', conversationId: 'c', currentInputAnchors: [],
    turnProfile: { workId: 'work', context: { turnKind: 'wake', events: [{ sessionId: 's', kind: 'session_running' }] } } };
  const call = { call: { toolCallId: 'wait', capabilityId: 'local.delegation.wait_for_sessions', arguments: { sessionIds: ['s'] } } };
  const result = await provider.executeCapability(call, context);
  assert.equal(result.grant.granted, true); assert.equal(result.result.evidence.toolCallId, 'wait');
  assert.equal(result.result.outputPreview.control.reason, 'project_agent_wait');
  assert.deepEqual(waitResult(result.result), { ok: true, kind: 'project_agent_wait', sessionIds: ['s'] });
  for (const status of ['waiting_user', 'waiting_agent', 'result_ready', 'cancelled']) {
    session.status = status;
    const denied = await provider.executeCapability(call, context);
    assert.equal(denied.grant.granted, false); assert.equal(denied.result.outputPreview.control, undefined);
    assert.equal(waitResult(denied.result), null, 'idempotency cannot replay an obsolete wait');
  }
  session.status = 'running'; session.origin.workId = 'other';
  assert.equal((await provider.executeCapability(call, context)).result.output.error, 'out_of_scope');
  session.origin.workId = 'work';
  assert.equal((await provider.executeCapability(call, { ...context, currentInputAnchors: ['new-user'] })).result.output.error, 'background_wait_required');
  assert.equal(validateDelegationInput('wait_for_sessions', { sessionIds: ['s', 's'] }).ok, false);
});

test('a background observer can wait on its durable result event without owning the spawning work', async () => {
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const path=await import('node:path');
 const {createWorkCoordinationStore}=await import('./work-coordination-store.mjs');
 const {registerWorkBudget}=await import('./work-budget.mjs');const {admitSessionWait}=await import('./wake-wait.mjs');
 const root=mkdtempSync(path.join(tmpdir(),'observer-wait-'));
 const store=createWorkCoordinationStore({rootDir:root,workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'owner'});
 const unregister=registerWorkBudget('w',store);
 const event={eventId:'result',sessionId:'s',kind:'report_available'};
 store.transfer([event]);store.saveWork({workId:'observer',parentConversationId:'c',state:'runnable',stopScope:'reply',pendingEventIds:['result']});
 const view={workspaceId:'w',conversationId:'c',workId:'observer',currentInputAnchors:[],turnKind:'wake',events:[event]};
 const session={workspaceId:'w',status:'running',origin:{parentConversationId:'c',workId:'spawner'}};
 try {
  assert.equal((await admitSessionWait({sessionIds:['s']},view,()=>session)).ok,true);
  assert.equal((await admitSessionWait({sessionIds:['s']},{...view,events:[{...event,eventId:'invented'}]},()=>session)).error,'out_of_scope');
  assert.equal((await admitSessionWait({sessionIds:['s']},view,()=>({...session,workspaceId:'elsewhere'}))).error,'out_of_scope');
  store.saveWork({...store.read().works.observer,state:'cancelled',stopScope:'work'});
  assert.equal((await admitSessionWait({sessionIds:['s']},view,()=>session)).error,'out_of_scope');
 }finally{unregister();rmSync(root,{recursive:true,force:true});}
});
