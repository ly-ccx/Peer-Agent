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

test('idle and terminal recovery never discover the task roster; eligible custody reads it once', () => {
 const f=fixture(); let reads=0, checkpointReads=0;
 const readCheckpoint=f.store.readCheckpoint;f.store.readCheckpoint=ref=>{checkpointReads++;return readCheckpoint(ref);};
 const resolveRoster=()=>{reads++;return f.sessions;};
 const c=createRunnerCoordination({store:f.store,inbox:{},workspaceId:'w',conversationId:'c',readMessages:()=>[],remember:()=>{},resolveRoster});
 try {
  assert.equal(c.recoverJob(),null);assert.deepEqual(c.pending(),[]);assert.equal(reads,0);
  for(let n=0;n<12;n++) f.seed('paused'+n,{state:'paused',stopScope:'work',anchorInputIds:['historical-user-'+n]});
  assert.equal(c.recoverJob(),null);c.pending();assert.equal(reads,0,'historical paused work must not trigger all-plan discovery');
  assert.equal(checkpointReads,0,'terminal user history must not be read merely to sort recovery priority');
  for(let n=0;n<12;n++) f.seed('wake'+n);
  const job=c.recoverJob();assert.ok(job);assert.equal(reads,1,'one synchronous recovery uses one current roster');
  assert.equal(Object.values(f.store.read().works).filter(w=>w.state==='coalesced').length,11);
  reads=0; f.sessions.length=0;c.recoverJob();assert.equal(reads,1,'next recovery rechecks changed child facts');
 }finally{f.close();}
});

test('custody accepts a lazy roster and does not read it for ineligible work',()=>{
 const f=fixture();let reads=0;const sessions=()=>{reads++;return f.sessions;};
 try{
  f.seed('paused',{state:'paused',stopScope:'work'});
  reconcileContinuationCustody({store:f.store,conversationId:'c',sessions});assert.equal(reads,0);
  f.seed('a');f.seed('b');reconcileContinuationCustody({store:f.store,conversationId:'c',sessions});
  assert.equal(reads,1);assert.equal(Object.values(f.store.read().works).filter(w=>w.state==='coalesced').length,1);
 }finally{f.close();}
});

test('an empty recovery decision reads one authoritative inventory', () => {
 for (const immutable of [false, true]) {
 const f=fixture();let reads=0;const port=immutable?'readSnapshot':'read', original=f.store[port];
 f.store[port]=()=>{reads++;return original();};
 if (immutable) f.store.read=()=>assert.fail('recovery observation must not copy all work');
 else f.store.readSnapshot=undefined;
 const c=createRunnerCoordination({store:f.store,inbox:{},workspaceId:'w',conversationId:'c',readMessages:()=>[],remember:()=>{},resolveRoster:()=>[]});
 try {assert.equal(c.recoverJob(),null);assert.equal(reads,1,'empty work needs one inventory and no repair scans');}
 finally{f.close();}
 }
});

test('a recovery write invalidates the decision snapshot before selecting the next job', () => {
 const f=fixture();
 try {
  f.seed('changed',{state:'waiting_children',reportedWait:{sessionStates:[{sessionId:'missing',status:'running',sourceRevision:'old'}]}});
  const c=createRunnerCoordination({store:f.store,inbox:{},workspaceId:'w',conversationId:'c',readMessages:()=>[],remember:()=>{},resolveRoster:()=>f.sessions});
  assert.equal(c.recoverJob()?.workId,'changed');
  assert.equal(f.store.read().works.changed.state,'runnable');
 }finally{f.close();}
});

test('unchanged single custody discovers compact facts; merging rereads and preserves full checkpoint data', () => {
 const f=fixture();
 try {
  f.seed('single');
  const work=f.store.read().works.single, original=f.store.readCheckpoint(work.checkpointRef);
  original.outcome.privateNativePayload='retain actual execution data';
  original.job.events[0].payload={actual:'full event payload'};
  f.store.saveWork({...work,checkpointRef:f.store.checkpoint('single',original)});
  const read=f.store.readCheckpoint;let fullReads=0;
  f.store.readCheckpoint=ref=>{fullReads++;return read(ref);};
  f.reconcile();f.reconcile();assert.equal(fullReads,0,'steady discovery must not parse full execution history');
  f.store.transfer([{eventId:'fresh',kind:'report_available',sessionId:'s',payload:{actual:'new full payload'}}]);
  f.reconcile();assert.equal(fullReads,1,'a real merge reads the original checkpoint');
  const result=read(f.store.read().works.single.checkpointRef);
  assert.equal(result.outcome.privateNativePayload,original.outcome.privateNativePayload);
  assert.deepEqual(result.job.events.map(event=>event.payload),[{actual:'full event payload'},{actual:'new full payload'}]);
 }finally{f.close();}
});

test('one selection prepares once across user, event and background priority', () => {
 const f=fixture();let reads=0, fullReads=0;const original=f.store.readSnapshot, fullRead=f.store.read;
 f.store.readSnapshot=()=>{reads++;return original();};f.store.read=()=>{fullReads++;return fullRead();};
 const c=createRunnerCoordination({store:f.store,inbox:{},workspaceId:'w',conversationId:'c',readMessages:()=>[],remember:()=>{},resolveRoster:()=>[]});
 try {
  assert.deepEqual(c.selectNext(),{job:null});assert.equal(reads,1,'one inventory serves all empty priority queues');
  assert.equal(fullReads,0,'immutable observations must avoid unrelated payload copies');
  f.seed('background');f.store.transfer([{eventId:'fresh',kind:'needs_user',sessionId:'other'}]);
  assert.equal(c.selectNext().events[0].eventId,'fresh','an unowned event precedes a background continuation');
  f.seed('human',{anchorInputIds:['i']});
  assert.equal(c.selectNext().job.workId,'human','a user continuation precedes the unowned event');
  const human=f.store.read().works.human;f.store.saveWork({...human,state:'cancelled',stopScope:'work'});
  f.store.handled(['fresh']);
  assert.equal(c.selectNext().job.workId,'background','new selection observes cancellation and event acknowledgement');
 }finally{f.close();}
});

test('a missing user checkpoint is blocked and selection rereads before returning another job', () => {
 const f=fixture();
 try {
  f.seed('missing',{anchorInputIds:['i'],updatedAt:'2026-10-19T23:59:00Z'});
  f.seed('valid',{anchorInputIds:['other']});
  const broken=f.store.read().works.missing, checkpoint=f.store.readCheckpoint(broken.checkpointRef);
  checkpoint.job.userInputs=[{inputId:'i',createdAt:'2099-01-01T00:00:00Z'}];
  f.store.saveWork({...broken,checkpointRef:f.store.checkpoint('missing',checkpoint)});
  const read=f.store.readCheckpoint;f.store.readCheckpoint=ref=>ref===f.store.read().works.missing.checkpointRef?null:read(ref);
  const c=createRunnerCoordination({store:f.store,inbox:{},workspaceId:'w',conversationId:'c',readMessages:()=>[],remember:()=>{},resolveRoster:()=>[]});
  assert.equal(c.selectNext().job.workId,'valid');
  assert.equal(f.store.read().works.missing.recovery.blockedCode,'RECOVERY_CHECKPOINT_UNAVAILABLE');
 }finally{f.close();}
});
