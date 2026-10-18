import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { reconcileContinuationCustody } from './continuation-custody.mjs';
import { createRunnerCoordination } from './runner-coordination.mjs';
import { replyRecoveryAdmission } from './reply-recovery-admission.mjs';

function fixture() {
 const root = mkdtempSync(path.join(tmpdir(), 'peer-custody-'));
 const options = { rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'lease' };
 let store = createWorkCoordinationStore(options);
 const sessions = [{ sessionId: 's', status: 'waiting_agent', sourceRevision: 'r1' }];
 const seed = (id, extra = {}, eventKind = 'report_available') => {
  const event = { eventId: `e-${id}`, kind: eventKind, sessionId: 's', at: '2026-10-18T00:00:00Z' };
  store.transfer([event]);
  const job = { kind: 'wake', events: [event], workId: id, userInputs: [] };
  const checkpointRef = store.checkpoint(id, { job, outcome: { rounds: [] } });
  store.saveWork({ schemaVersion: 1, workspaceId: 'w', parentConversationId: 'c', workId: id, state: 'runnable',
   sessionIds: ['s'], anchorInputIds: [], consumedEventIds: [], pendingEventIds: [event.eventId],
   waitFor: [], stopScope: 'reply', checkpointRef, ...extra });
 };
 return { get store() { return store; }, seed, sessions,
  reconcile() { reconcileContinuationCustody({ store, conversationId: 'c', sessions }); },
  restart() { store = createWorkCoordinationStore(options); }, close() { rmSync(root, { recursive: true, force: true }); } };
}

test('thirty persisted duplicate wakes have one owner, preserve checkpoints and progress across restart', () => {
 const f = fixture();
 try {
  for (let n = 0; n < 30; n++) f.seed(`w${n}`, { progressFacts: [`fact${n}`], repeats: n % 2, budget: { tokens: n } });
  const original = f.store.read(); f.reconcile();
  const works = Object.values(f.store.read().works), owner = works.find(w => w.state === 'runnable');
  assert.equal(works.filter(w => w.state === 'coalesced').length, 29);
  assert.equal(owner.progressFacts.length, 30); assert.equal(owner.repeats, 1);
  assert.equal(f.store.readCheckpoint(owner.checkpointRef).job.events.length, 30);
  for (const work of works.filter(w => w.state === 'coalesced')) {
   assert.equal(work.continuationOwnerWorkId, owner.workId);
   assert.equal(work.checkpointRef, original.works[work.workId].checkpointRef);
   assert.deepEqual(work.budget, original.works[work.workId].budget);
   assert.equal(replyRecoveryAdmission(work, f.store.readCheckpoint(work.checkpointRef)).code, 'STALE_TURN');
  }
  const revision = f.store.read().revision; f.restart(); f.reconcile(); assert.equal(f.store.read().revision, revision);
  f.store.transfer([{ eventId: 'fresh', kind: 'report_available', sessionId: 's' }]); f.reconcile();
  assert.equal(Object.values(f.store.read().works).filter(w => w.state === 'runnable').length, 1);
  assert.ok(f.store.read().works[owner.workId].pendingEventIds.includes('fresh'));
 } finally { f.close(); }
});

test('human input, cancellation, uncertain execution, control and pending delivery cannot be coalesced', () => {
 const f = fixture();
 try {
  f.seed('normal'); f.seed('human', { anchorInputIds: ['input'] }); f.seed('cancel', { state: 'cancelled' });
  f.seed('pause', { state: 'paused' }); f.seed('unknown', { budget: { uncertainDispatches: [{}] } });
  f.seed('active', { budget: { attempts: { a: { pendingTools: [{toolCallId:'pending'}] } } } });
  f.seed('control', { pendingControl: { action: 'cancel' } }); f.seed('recovery', { recovery: { autoAttempts: 1 } });
  f.seed('critical', {}, 'needs_user'); f.seed('delivery');
  f.store.append({kind:'reply_prepared',message:{id:'prepared',meta:{workId:'delivery'}}});
  f.reconcile(); assert.equal(Object.values(f.store.read().works).some(w => w.state === 'coalesced'), false);
  const c = createRunnerCoordination({store:f.store,inbox:{},conversationId:'c',workspaceId:'w',readMessages:()=>[],remember:()=>{},resolveRoster:()=>f.sessions});
  assert.equal(c.recoverUserJob().workId, 'human', 'a yielded user reply outranks all old wakes');
 } finally { f.close(); }
});

test('newest unresolved user input resumes before older user and background continuations',()=>{
 const f=fixture();
 try {
  f.seed('wake');f.seed('new',{anchorInputIds:['new']});f.seed('old',{anchorInputIds:['old']});
  for(const [id,createdAt] of [['new','2026-10-18T12:30:00Z'],['old','2026-10-18T01:00:00Z']]) {
   const work=f.store.read().works[id],checkpoint=f.store.readCheckpoint(work.checkpointRef);
   checkpoint.job.kind='user';checkpoint.job.userInputs=[{inputId:id,createdAt,text:'status?'}];
   f.store.saveWork({...work,checkpointRef:f.store.checkpoint(id,checkpoint)});
  }
  const c=createRunnerCoordination({store:f.store,inbox:{},workspaceId:'w',conversationId:'c',readMessages:()=>[],remember:()=>{},resolveRoster:()=>f.sessions});
  assert.equal(c.recoverUserJob().workId,'new');
 }finally{f.close();}
});
