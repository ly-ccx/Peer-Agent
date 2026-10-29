import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createInputQueue } from './input-queue.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { createHostLease } from './host-lease.mjs';
import { createProjectAgentRunner } from './runner.mjs';
import { createExecutionScheduler } from './execution-scheduler.mjs';

const checksum = root => Object.fromEntries(readdirSync(root, { recursive: true }).filter(name => !name.endsWith('.lock')).flatMap(name => {
  try { return [[name, createHash('sha256').update(readFileSync(path.join(root,name))).digest('hex')]]; } catch { return []; }
}));
test('actual queue, inbox and lease diagnostics leave every byte and cursor unchanged, including archived events and corruption', t => {
  const root = mkdtempSync(path.join(os.tmpdir(),'peer-diagnostic-read-')); t.after(() => rmSync(root,{recursive:true,force:true}));
  const id = 'ws-1', dir = path.join(root,id); mkdirSync(dir);
  const input = createInputQueue({rootDir:root,holdsLease:()=>true,resolveConversationId:()=> 'conv',hasMessage:()=>false,appendMessage(){}});
  input.submitInput({workspaceId:id,inputId:'one',surface:'desktop',text:'private'});
  input.consume(id); input.submitInput({workspaceId:id,inputId:'two',surface:'tui',text:'private'});
  const inbox = createProjectInbox({rootDir:root}); inbox.append(id,[{eventId:'new',kind:'progress',at:'2026-10-02T00:00:00.000Z'}]);
  writeFileSync(path.join(dir,'inbox-2026-10-01.jsonl.gz'), gzipSync(JSON.stringify({eventId:'old',seq:0,at:'2026-10-01T00:00:00.000Z'})+'\n'));
  const lease = createHostLease({rootDir:root,hostId:'diagnostic',surface:'desktop',pid:process.pid});t.after(()=>lease.close());lease.acquire(id);
  const before = checksum(root);
  assert.deepEqual(input.diagnosticSnapshot(id),{depth:1,executionDepth:1,cursor:'one',executedCursor:null});
  assert.equal(lease.diagnosticSnapshot(id).hostId,'diagnostic');
  assert.throws(()=>inbox.diagnosticSnapshot(id), /CORRUPT_INBOX/);
  assert.deepEqual(checksum(root),before);
  writeFileSync(path.join(dir,'inbox-2026-10-01.jsonl.gz'),gzipSync(JSON.stringify({eventId:'old',seq:1,at:'2026-10-01T00:00:00.000Z'})+'\n'));
  const valid = checksum(root);assert.equal(inbox.diagnosticSnapshot(id).events.length,2);assert.deepEqual(checksum(root),valid);
  writeFileSync(path.join(dir,'input-cursor.json'),'{bad');assert.throws(()=>input.diagnosticSnapshot(id));
  writeFileSync(path.join(dir,'input-cursor.json'),JSON.stringify({ completedInputIds: ['/private/secret'] }));assert.throws(()=>input.diagnosticSnapshot(id), /CORRUPT_INPUT_CURSOR/);
  writeFileSync(path.join(dir,'host.lease'),'{bad');assert.throws(()=>lease.diagnosticSnapshot(id),/CORRUPT_LEASE/);
  assert.throws(()=>input.diagnosticSnapshot('../outside'));assert.throws(()=>inbox.diagnosticSnapshot('../outside'));assert.throws(()=>lease.diagnosticSnapshot('../outside'));
});

test('inbox diagnostics select the latest numbered archives and remain bounded without rewriting files', t => {
  const root=mkdtempSync(path.join(os.tmpdir(),'peer-diagnostic-archives-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(path.join(root,'ws'));
  for(const [suffix,start] of [['',1],['-2',201],['-10',401]]) {
    const events=Array.from({length:200},(_,i)=>({eventId:`e-${start+i}`,seq:start+i,at:'2026-10-01T00:00:00.000Z'}));
    writeFileSync(path.join(root,'ws',`inbox-2026-10-01${suffix}.jsonl.gz`),gzipSync(events.map(e=>JSON.stringify(e)).join('\n')+'\n'));
  }
  writeFileSync(path.join(root,'ws','inbox.jsonl'),JSON.stringify({eventId:'e-601',seq:601})+'\n');
  const before=checksum(root), snapshot=createProjectInbox({rootDir:root}).diagnosticSnapshot('ws');
  assert.equal(snapshot.events.length,200);assert.equal(snapshot.events[0].seq,402);assert.equal(snapshot.events.at(-1).seq,601);
  assert.deepEqual(checksum(root),before);
});

test('scheduler diagnostics observe both occupied task slots and model-turn waits without admission or release', async t => {
  const root=mkdtempSync(path.join(os.tmpdir(),'peer-diagnostic-scheduler-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const scheduler=createExecutionScheduler({rootDir:root,getConcurrency:()=>1});
  const plans=['running','queued'].map((id,i)=>({planId:id,status:i?'paused':'executing',createdAt:'2026-10-01T00:00:00.000Z',delegationOrigin:{workspaceId:'ws',sessionId:id,phase:i?'queued':'running',readOnly:false,priority:'high'}}));
  scheduler.reconcile(plans);
  let release, invoked=0;
  const first=scheduler.withTurn({workspaceId:'ws',planId:'running'},()=>new Promise(resolve=>{release=resolve;}));await Promise.resolve();
  const second=scheduler.withTurn({workspaceId:'ws',planId:'queued'},()=>{invoked++;});
  const before=checksum(root), snapshot=scheduler.diagnosticSnapshot();
  assert.deepEqual(snapshot.stats,{active:1,waiting:1,limit:1});assert.equal(snapshot.projects[0].slots.write,1);
  assert.equal(snapshot.projects[0].queue[0].reason,'write_slot');assert.equal(snapshot.queue[0].planId,'queued');
  assert.equal(invoked,0);assert.deepEqual(checksum(root),before);assert.deepEqual(scheduler.diagnosticSnapshot(),snapshot);
  release();await Promise.all([first,second]);assert.equal(invoked,1);
});

test('a failed provider round records error timing while the old history stays byte-identical', async t => {
  const messages=[{id:'old',kind:'agent_turn',content:'old'}], old=JSON.stringify(messages[0]);
  const runner=createProjectAgentRunner({workspaceId:'ws',conversationId:'conv',inbox:{takeBatch:()=>({events:[],throughSeq:0}),commitBatch(){}},retryDelays:[],resolveModel:()=>({ok:true,modelProviderId:'fixture'}),
    appendMessage:(_,m)=>messages.push(m),executeTurn:async()=>({terminalStatus:'error',retryable:false,text:'provider failure'})});
  t.after(()=>runner.dispose());await runner.enqueueUserInputs([{inputId:'input',text:'go',surface:'desktop'}]);
  assert.equal(JSON.stringify(messages[0]),old);
  const timing=messages.findLast(m=>m.kind==='agent_turn').meta.diagnosticTiming;
  assert.equal(timing.outcome,'error');assert.ok(timing.durationMs>=0);
});
test('actual runner measures a completed job across provider retries without rewriting old history', async t => {
  const messages=[{id:'old',kind:'agent_turn',content:'old'}], old=JSON.stringify(messages[0]);let calls=0;
  const runner=createProjectAgentRunner({workspaceId:'ws-1',conversationId:'conv',inbox:{takeBatch:()=>({events:[],throughSeq:0}),commitBatch(){}},
    retryDelays:[5],resolveModel:()=>({ok:true,modelProviderId:'fixture'}),appendMessage:(_,m)=>messages.push(m),
    executeTurn:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return calls===1?{terminalStatus:'error',retryable:true}:{terminalStatus:'done',text:'reply'};}});
  t.after(()=>runner.dispose());await runner.enqueueUserInputs([{inputId:'input',text:'go',surface:'desktop'}]);
  assert.equal(calls,2);assert.equal(JSON.stringify(messages[0]),old);
  const timing=messages.findLast(m=>m.kind==='agent_turn').meta.diagnosticTiming;
  assert.equal(timing.outcome,'done');assert.ok(timing.durationMs>=10);assert.ok(Date.parse(timing.finishedAt)>=Date.parse(timing.startedAt));
});
