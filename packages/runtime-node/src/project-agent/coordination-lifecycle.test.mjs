import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCoordinationLifecycle } from './coordination-lifecycle.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget, createWorkBudgetGuard } from './work-budget.mjs';
import { createDelegationProvider } from './delegation-provider.mjs';

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'coordination-effects-'));
  const options = { rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'one', formatVersion: 2, fenceLegacyWrites: true };
  const store = createWorkCoordinationStore(options);
  await store.prepare();
  store.saveWork({ workId: 'goal', parentConversationId: 'parent', state: 'waiting_children' });
  const release = registerWorkBudget('w', store);
  t.after(() => { release(); rmSync(root, { recursive: true, force: true }); });
  const sessions = new Map(), spawns = [], cancellations = [], messages = [];
  const users = ['u1','u2','u3'].map(id => ({ id, inputId: id, role: 'user', kind: 'user_input' }));
  let unknown = false, enabled = true;
  const ports = { readMessages: () => users, readSession: ({ sessionId }) => sessions.get(sessionId), holdsLease: () => true,
    isEnabled: () => enabled,
    spawn: async (task, context) => {
      const existing = spawns.find(row => row.operationId === context.coordinationOperationId);
      if (existing) return existing;
      const sessionId = `s${spawns.length+1}`;
      const binding = { ...context.coordinationBinding, sessionId };
      store.bindSession(binding.workId, binding.goalRevision, sessionId, binding);
      const result = { sessionId, operationId: context.coordinationOperationId, workspaceId: 'w', status: 'running',
        origin: { workId: 'goal', parentConversationId: 'parent', coordinationBinding: binding }, task };
      sessions.set(sessionId, result); spawns.push(result); return result;
    },
    requestCancel: async ({ sessionId, operationId }) => {
      cancellations.push(sessionId); const row = sessions.get(sessionId);
      row.origin.cancellation = { operationId, phase: unknown ? 'awaiting_outcome' : 'completed' };
      if (!unknown) row.status = 'cancelled'; return { pending: unknown };
    },
    send: async (input, context) => { messages.push({ input, context }); return { ok: true }; },
    takeover: async () => ({ error: 'human_decision_required' }) };
  const lifecycle = createCoordinationLifecycle(ports);
  const context = (id, op, extra={}) => ({ workspaceId: 'w', conversationId: 'parent', workId: 'goal', currentInputAnchors: [id], deliveryKey: op, ...extra });
  const task = id => ({ anchorMessageIds: [id], title: 'bounded work', brief: 'inspect implementation' });
  return { store, ports, lifecycle, context, task, sessions, spawns, cancellations, messages, enabled: value => { enabled=value; }, unknown: () => { unknown=true; }, reopen: () => createWorkCoordinationStore(options) };
}

test('a current user can cancel a returned result; an ordinary wake cannot abandon it', async t => {
 const f=await fixture(t);
 const opened=await f.lifecycle.coordinate({action:'parallel',reason:'original',task:f.task('u1')},f.context('u1','original'));
 f.sessions.get(opened.sessionId).status='result_ready';
 const event={eventId:'result',sessionId:opened.sessionId,kind:'result_ready'};f.store.transfer([event]);
 const cancel={action:'cancel',sessionId:opened.sessionId,expectedRevision:1,reason:'no longer needed'};
 const wake=await f.lifecycle.coordinate(cancel,f.context('','wake',{currentInputAnchors:[],events:[event]}));
 assert.equal(wake.error,'current_user_required');assert.deepEqual(f.cancellations,[]);
 const result=await f.lifecycle.coordinate(cancel,f.context('u2','user-cancel'));
 assert.equal(result.ok,true);assert.equal(result.phase,'completed');
 assert.equal(f.sessions.get(opened.sessionId).status,'cancelled');assert.deepEqual(f.cancellations,[opened.sessionId]);
 await f.lifecycle.recover('w');assert.deepEqual(f.cancellations,[opened.sessionId]);
});

test('a returned legacy session is adopted only from current user input before repair',async t=>{
  const f=await fixture(t);
  f.sessions.set('legacy',{sessionId:'legacy',planId:'old-plan',workspaceId:'w',status:'result_ready',origin:{parentConversationId:'parent'}});
  const lifecycle=createCoordinationLifecycle({...f.ports,takeover:async()=>({ok:true})});
  const input={action:'resume',sessionId:'legacy',expectedRevision:0,reason:'Correct the missing analysis'};
  assert.equal((await lifecycle.coordinate(input,f.context('','wake',{currentInputAnchors:[]}))).error,'current_user_required');
  assert.equal(f.store.read().mandates?.goal,undefined);
  const receipt=await lifecycle.coordinate(input,f.context('u1','adopt'));
  assert.equal(receipt.ok,true,JSON.stringify(receipt));
  assert.equal(receipt.phase,'completed');
  assert.deepEqual(f.store.read().mandates.goal.sessionIds,['legacy']);
  assert.deepEqual(f.store.read().mandates.goal.rootInputIds,['u1']);
  assert.equal(f.store.read().transitions.adopt.minimumExecutorVersion,3);
  assert.equal(f.spawns.length,0);
});

test('current user can finish cancellation on stopped work without reopening admission', async t => {
 const f=await fixture(t);
 const opened=await f.lifecycle.coordinate({action:'parallel',reason:'original',task:f.task('u1')},f.context('u1','original'));
 f.store.saveWork({workId:'goal',state:'cancelled',stopScope:'work'});
 const cancelled=await f.lifecycle.coordinate({action:'cancel',sessionId:opened.sessionId,expectedRevision:1,reason:'withdraw'},f.context('u2','cancel-stopped'));
 assert.equal(cancelled.ok,true);assert.equal(cancelled.phase,'completed');
 assert.equal(f.store.read().works.goal.stopScope,'work');assert.equal(f.store.read().works.goal.state,'cancelled');
 const repeated=await f.lifecycle.coordinate({action:'cancel',sessionId:opened.sessionId,expectedRevision:2,reason:'already withdrawn'},f.context('u3','cancel-again'));
 assert.equal(repeated.ok,true);assert.deepEqual(f.cancellations,[opened.sessionId]);
  assert.equal((await f.lifecycle.coordinate({action:'replace',sessionId:opened.sessionId,expectedRevision:3,reason:'revive',task:f.task('u3')},f.context('u3','replace-stopped'))).error,'work_execution_stopped');
});

test('parallel work survives a sibling cancellation and cancellation events cannot revive it', async t => {
  const f = await fixture(t);
  const a = await f.lifecycle.coordinate({ action:'parallel', reason:'A', task:f.task('u1') },f.context('u1','a'));
  const b = await f.lifecycle.coordinate({ action:'parallel', reason:'B', task:f.task('u1') },f.context('u1','b'));
  const profile = id => ({ workspaceId:'w', workId:'goal', coordinationBinding:f.sessions.get(id).origin.coordinationBinding });
  const guardA=createWorkBudgetGuard(profile(a.sessionId)), guardB=createWorkBudgetGuard(profile(b.sessionId));
  const result=await f.lifecycle.coordinate({ action:'cancel',reason:'stop A',sessionId:a.sessionId,expectedRevision:1 },f.context('u2','cancel'));
  assert.equal(result.phase,'completed'); assert.equal(f.sessions.get(a.sessionId).status,'cancelled');
  const fullRead = f.store.read;
  f.store.read = () => assert.fail('binding checks must not clone unrelated work');
  try { assert.throws(()=>guardA.beforeTool(),/execution_revision_stale/); guardB.beforeTool(); }
  finally { f.store.read = fullRead; }
  f.store.transfer([{eventId:'e',sessionId:a.sessionId,kind:'cancelled'}]);
  const wake = await f.lifecycle.coordinate({action:'parallel',reason:'revive',task:f.task('u1')},f.context('', 'wake',{currentInputAnchors:[],events:[{eventId:'e',sessionId:a.sessionId}]}));
  assert.equal(wake.error,'event_out_of_scope'); assert.equal(f.spawns.length,2);
});

test('one synchronous coordination decision reads its current parent messages once', async t => {
  const f = await fixture(t); let reads = 0;
  const lifecycle = createCoordinationLifecycle({ ...f.ports, readMessages: id => { reads++; return f.ports.readMessages(id); } });
  const result = await lifecycle.coordinate({ action: 'parallel', reason: 'inspect', task: f.task('u1') }, f.context('u1', 'once'));
  assert.equal(result.ok, true); assert.equal(reads, 1);
  assert.equal(f.spawns.length, 1);
});

test('query discovers an owned legacy session without a revision, mutation, mandate or execution', async t => {
  const f = await fixture(t);
  f.sessions.set('legacy', { sessionId: 'legacy', workspaceId: 'w', status: 'waiting_agent', origin: { parentConversationId: 'parent' } });
  const before = f.store.read();
  const result = await f.lifecycle.coordinate({ action: 'query', sessionId: 'legacy', reason: 'discover current state' }, f.context('', 'query', { currentInputAnchors: [] }));
  assert.equal(result.ok, true); assert.equal(result.legacy, true); assert.equal(result.goalRevision, null);
  assert.equal(result.session.status, 'waiting_agent');
  assert.deepEqual(f.store.read(), before); assert.equal(f.spawns.length, 0);
  assert.equal((await f.lifecycle.coordinate({ action: 'query', sessionId: 'legacy' }, { ...f.context('', 'q'), conversationId: 'other' })).error, 'out_of_scope');
  assert.equal((await f.lifecycle.coordinate({ action: 'query', sessionId: 'legacy' }, f.context('', 'q', { scopedSessionIds: ['unrelated'] }))).error, 'out_of_scope');
});

test('a wake corrects a string revision and user-only entry point, then hands off under the original mandate', async t => {
  const f = await fixture(t);
  const started = await f.lifecycle.coordinate({ action: 'parallel', reason: 'original', task: f.task('u1') }, f.context('u1', 'original'));
  f.sessions.get(started.sessionId).status = 'waiting_agent';
  const event = { eventId: 'interrupted', sessionId: started.sessionId, kind: 'interrupted' };
  f.store.transfer([event]);
  let takeovers = 0;
  const lifecycle = createCoordinationLifecycle({ ...f.ports, takeover: async () => { takeovers++; return { ok: true }; } });
  const provider = createDelegationProvider({ supervisor: { get: f.ports.readSession,
    coordinateWork: (input, context) => lifecycle.coordinate(input, context) } });
  const context = { mode: 'project_agent', role: 'project_agent', workspaceId: 'w', conversationId: 'parent',
    turnId: 'wake', currentInputAnchors: [], messages: f.ports.readMessages(),
    turnProfile: { workId: 'goal', context: { turnKind: 'wake', events: [event] } } };
  let ordinal = 0;
  const execute = async (tool, input) => (await provider.executeCapability({ call: {
    toolCallId: `call-${ordinal}`, capabilityId: `local.delegation.${tool}`, arguments: input,
  } }, { ...context, toolCallOrdinal: ordinal++ })).result.output;
  const input = { action: 'handoff', sessionId: started.sessionId, reason: 'recover retained work', expectedRevision: '1.0' };
  const bad = await execute('coordinate_work', input);
  assert.equal(bad.error, 'invalid_input'); assert.match(bad.message, /integer, not a string/);
  assert.equal(takeovers, 0);
  const direct = await execute('resume_session', { sessionId: started.sessionId, anchorMessageId: 'u1' });
  assert.equal(direct.error, 'current_user_required');
  assert.equal(direct.suggestedCall.tool, 'coordinate_work');
  const query = await execute(direct.suggestedCall.tool, direct.suggestedCall.arguments);
  assert.equal(query.goalRevision, 1);
  assert.ok(JSON.stringify(query).indexOf('goalRevision') < JSON.stringify(query).indexOf('session'));
  const recovered = await execute('coordinate_work', { ...input, expectedRevision: query.goalRevision, workId: query.workId });
  assert.equal(recovered.ok, true); assert.equal(recovered.phase, 'completed');
  assert.equal(takeovers, 1); assert.equal(f.spawns.length, 1);
  const foreign = await execute('coordinate_work', { action: 'query', sessionId: 'unrelated', reason: 'inspect' });
  assert.equal(foreign.error, 'out_of_scope'); assert.equal(takeovers, 1);
});

test('capability failure precedes replacement revision and cancellation of existing work', async t => {
  const f = await fixture(t);
  const original = await f.lifecycle.coordinate({ action: 'parallel', reason: 'original', task: f.task('u1') }, f.context('u1', 'original'));
  const before = f.store.read();
  const diagnostic = { stage: 'delegation_admission', reason: 'delegation_capability_unavailable', missing: ['local.shell.exec'], retryable: false, userActionRequired: false };
  const checked = createCoordinationLifecycle({ ...f.ports, admitTask: async () => ({ ok: false, error: 'delegation_capability_unavailable', diagnostic }) });
  const result = await checked.coordinate({ action: 'replace', reason: 'cannot execute', sessionId: original.sessionId,
    expectedRevision: 1, task: f.task('u2') }, f.context('u2', 'blocked-replacement'));
  assert.equal(result.error, 'delegation_capability_unavailable'); assert.deepEqual(result.diagnostic, diagnostic);
  assert.deepEqual(f.store.read(), before); assert.deepEqual(f.cancellations, []); assert.equal(f.spawns.length, 1);
  assert.equal(f.sessions.get(original.sessionId).status, 'running');
});

test('replacement replay and consecutive corrections follow durable lineage without duplicate tasks', async t => {
  const f=await fixture(t), a=await f.lifecycle.coordinate({action:'parallel',reason:'A',task:f.task('u1')},f.context('u1','a'));
  const replace={action:'replace',reason:'correct direction',sessionId:a.sessionId,expectedRevision:1,task:f.task('u2')};
  const b=await f.lifecycle.coordinate(replace,f.context('u2','replace'));
  assert.equal(b.phase,'completed'); assert.equal(f.spawns.length,2);
  assert.equal((await f.lifecycle.coordinate(replace,f.context('u2','replace'))).replayed,true);
  assert.equal(f.spawns.length,2);
  const c=await f.lifecycle.coordinate({...replace,expectedRevision:2,task:f.task('u3')},f.context('u3','again',{scopedSessionIds:[a.sessionId]}));
  assert.equal(c.phase,'completed'); assert.deepEqual(f.cancellations,[a.sessionId,b.sessionId]);
  assert.equal(f.store.read().transitions.again.oldSessionId,b.sessionId);
  assert.equal((await f.lifecycle.coordinate({...replace,reason:'other'},f.context('u2','replace'))).error,'operation_identity_conflict');
  assert.equal((await f.lifecycle.coordinate(replace,{...f.context('u2','replace'),conversationId:'other'})).error,'out_of_scope');
  assert.equal(f.reopen().read().transitions.again.replacementSessionId,c.sessionId);
});

test('unknown external outcome preserves the old task and does not dispatch a replacement', async t => {
  const f=await fixture(t), a=await f.lifecycle.coordinate({action:'parallel',reason:'A',task:f.task('u1')},f.context('u1','a'));
  f.unknown(); const result=await f.lifecycle.coordinate({action:'replace',reason:'correct',sessionId:a.sessionId,expectedRevision:1,task:f.task('u2')},f.context('u2','replace'));
  assert.equal(result.phase,'awaiting_outcome'); assert.equal(result.error,'execution_outcome_unknown');
  await f.lifecycle.recover('w'); assert.equal(f.spawns.length,1);
});

test('session projection keeps replacement lineage after an update and a progress query',async t=>{
  const f=await fixture(t), a=await f.lifecycle.coordinate({action:'parallel',reason:'A',task:f.task('u1')},f.context('u1','a'));
  const b=await f.lifecycle.coordinate({action:'replace',reason:'correct A',sessionId:a.sessionId,expectedRevision:1,task:f.task('u2')},f.context('u2','replace'));
  await f.lifecycle.coordinate({action:'augment',reason:'extra context',text:'inspect the rounded corners',sessionId:b.sessionId,expectedRevision:2},f.context('u3','update'));
  await f.lifecycle.coordinate({action:'query',reason:'progress',sessionId:b.sessionId,expectedRevision:2},f.context('u3','query'));
  const facts=f.lifecycle.forSession('w',b.sessionId);
  assert.equal(facts.action,'augment');
  assert.equal(facts.operationId,'update');
  assert.equal(facts.priorSessionId,a.sessionId);
  assert.equal(facts.replacementSessionId,b.sessionId);
  assert.equal(facts.replacementTitle,'bounded work');
});

test('parallel work referencing another session does not claim replacement lineage',async t=>{
  const f=await fixture(t), a=await f.lifecycle.coordinate({action:'parallel',reason:'A',task:f.task('u1')},f.context('u1','a'));
  const b=await f.lifecycle.coordinate({action:'parallel',reason:'B alongside A',sessionId:a.sessionId,expectedRevision:1,task:f.task('u2')},f.context('u2','b'));
  const facts=f.lifecycle.forSession('w',b.sessionId);
  assert.equal(facts.action,'parallel');
  assert.equal(facts.priorSessionId,undefined);
  assert.equal(facts.replacementSessionId,undefined);
});

test('started-step recovery finishes its receipt without redispatching a persisted task', async t => {
  const f=await fixture(t);
  f.store.decide({operationId:'crash',workId:'goal',expectedRevision:0,action:'parallel',reason:'A',sourceInputIds:['u1'],sourceEventIds:[],payload:{task:f.task('u1'),context:{workspaceId:'w',parentConversationId:'parent'}}},
    {parentConversationId:'parent',currentInputIds:['u1']});
  f.store.advanceTransition('crash','recorded',{phase:'ready'});
  f.store.advanceTransition('crash','ready',{phase:'started',replacementSessionId:'persisted'});
  await f.lifecycle.recover('w'); assert.equal(f.spawns.length,0); assert.equal(f.reopen().read().transitions.crash.phase,'completed');
});

test('rollback settles registered cancellation without dispatching its replacement or reviving the old task',async t=>{
  const f=await fixture(t), a=await f.lifecycle.coordinate({action:'parallel',reason:'A',task:f.task('u1')},f.context('u1','a'));
  const result=f.store.decide({operationId:'replace',workId:'goal',expectedRevision:1,action:'replace',sessionId:a.sessionId,reason:'correct A',sourceInputIds:['u2'],sourceEventIds:[],
    payload:{task:f.task('u2'),context:f.context('u2','replace')}},{parentConversationId:'parent',currentInputIds:['u2']});
  assert.equal(result.ok,true);
  f.enabled(false); await f.lifecycle.recover('w');
  assert.equal(f.sessions.get(a.sessionId).status,'cancelled');
  assert.equal(f.store.read().transitions.replace.phase,'ready');
  assert.equal(f.spawns.length,1);
  assert.equal((await f.lifecycle.coordinate({action:'parallel',reason:'new',task:f.task('u3')},f.context('u3','new'))).error,'autonomous_coordination_disabled');
  f.enabled(true); await f.lifecycle.recover('w'); await f.lifecycle.recover('w');
  assert.equal(f.spawns.length,2);assert.equal(f.sessions.get(a.sessionId).status,'cancelled');
});

test('legacy adoption requires this turn canonical human input; human approval remains pending',async t=>{
  const f=await fixture(t);
  f.sessions.set('legacy',{sessionId:'legacy',workspaceId:'w',status:'running',origin:{parentConversationId:'parent'}});
  const input={action:'handoff',reason:'take over',sessionId:'legacy',expectedRevision:0};
  const wake=await f.lifecycle.coordinate(input,f.context('', 'wake',{currentInputAnchors:[],events:[{eventId:'file-instruction',sessionId:'legacy'}]}));
  assert.equal(wake.error,'current_user_required'); assert.equal(f.store.read().mandates,undefined);
  const result=await f.lifecycle.coordinate(input,f.context('u2','adopt'));
  assert.equal(result.error,'human_decision_required'); assert.equal(f.sessions.get('legacy').status,'running');
  assert.deepEqual(f.store.read().mandates.goal.rootInputIds,['u2']);
});

test('a fulfilled mandate cannot create work from a late event; a fresh human correction preserves the accepted result',async t=>{
  const f=await fixture(t), a=await f.lifecycle.coordinate({action:'parallel',reason:'A',task:f.task('u1')},f.context('u1','a'));
  f.sessions.get(a.sessionId).status='accepted';
  f.store.transfer([{eventId:'done',sessionId:a.sessionId,kind:'result_ready'}]);
  assert.equal(f.lifecycle.facts('w','parent')[0].lifecycle,'fulfilled');
  const wake=await f.lifecycle.coordinate({action:'parallel',reason:'repeat',task:f.task('u1')},f.context('','wake',{currentInputAnchors:[],events:[{eventId:'done',sessionId:a.sessionId}]}));
  assert.equal(wake.error,'mandate_inactive');
  const corrected=await f.lifecycle.coordinate({action:'replace',reason:'new requirement',sessionId:a.sessionId,expectedRevision:1,task:f.task('u2')},f.context('u2','correct'));
  assert.equal(corrected.phase,'completed'); assert.equal(f.sessions.get(a.sessionId).status,'accepted');
  assert.equal(f.cancellations.length,0); assert.equal(f.spawns.length,2);
});

test('session lifecycle queries do not clone execution history or authorize from compact facts', async t => {
  const f=await fixture(t);
  const a=await f.lifecycle.coordinate({action:'parallel',reason:'A',task:f.task('u1')},f.context('u1','a'));
  f.sessions.get(a.sessionId).status='accepted';
  const original=f.store.read;f.store.read=()=>{throw Error('full-state probe');};
  try {
    assert.equal(f.lifecycle.forSession('w',a.sessionId).phase,'completed');
    assert.equal(f.lifecycle.facts('w','parent')[0].lifecycle,'fulfilled');
    f.store.saveWork({workId:'goal',state:'cancelled',stopScope:'work'});
    assert.equal(f.lifecycle.facts('w','parent')[0].lifecycle,'cancelled');
    await assert.rejects(f.lifecycle.coordinate({action:'parallel',reason:'B',task:f.task('u2')},f.context('u2','b')),/full-state probe/);
  } finally {f.store.read=original;}
});
