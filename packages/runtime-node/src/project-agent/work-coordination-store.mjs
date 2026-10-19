import { createHash } from 'node:crypto';
import { openSync, closeSync, fsyncSync, writeSync, readSync, fstatSync, readFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';
import { reduceCoordination } from './work-coordination.mjs';
import { admitCoordinationDecision } from './coordination-kernel.mjs';
import { createCoordinationJournalReader } from './coordination-journal-reader.mjs';
import { createRecoveryCheckpointView, createContinuationCheckpointView } from './recovery-checkpoint-view.mjs';

export function createWorkCoordinationStore({ rootDir, workspaceId, holdsLease = () => false, leaseEpoch = () => null, now = () => new Date().toISOString(), onJournalRead }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(workspaceId)) throw new Error('invalid_workspace');
  const dir = path.join(rootDir || pathOf('projectRuntime'), workspaceId);
  const file = path.join(dir, 'coordination.jsonl');
  const epoch = leaseEpoch();
  const reader = createCoordinationJournalReader({ file, onRead: onJournalRead });
  const readRecoveryCheckpoint = createRecoveryCheckpointView(path.join(dir, 'checkpoints'));
  const readContinuationCheckpoint = createContinuationCheckpointView(path.join(dir, 'checkpoints'));
  function assertOwner() {
    if (holdsLease() !== true || !epoch || leaseEpoch() !== epoch) throw new Error('coordination_lease_lost');
  }
  const read = reader.read;
  function recover() {
    assertOwner();
    // Most kicks see a complete append-only journal. Do not read its entire
    // body merely to inspect its last separator; the reader validates changes.
    let fd;
    try {
      fd = openSync(file, 'r');
      const size = fstatSync(fd).size, tail = Buffer.alloc(1);
      if (!size || readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] === 10) { read(); return; }
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    let body;
    try { body = readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!body || body.endsWith('\n')) { read(); return; }
    const boundary = body.lastIndexOf('\n') + 1;
    const tail = body.slice(boundary);
    try { JSON.parse(tail); } catch {
      // Completed records must replay before changing any byte. Never repair an interior corruption.
      let state = reduceEmpty();
      for (const line of body.slice(0, boundary).split('\n').filter(Boolean)) state = reduceCoordination(state, JSON.parse(line));
      const backup = `coordination-damaged-${createHash('sha256').update(body).digest('hex')}.jsonl`;
      durableFile(path.join(dir, backup), body);
      assertOwner(); durableFile(file, body.slice(0, boundary));
      append({ kind: 'journal_recovered', backup });
      return;
    }
    read(); // Validate a complete final record before merely adding its missing separator.
    assertOwner();
    const appendFd = openSync(file, 'a', 0o600);
    try { writeSync(appendFd, '\n'); fsyncSync(appendFd); } finally { closeSync(appendFd); }
  }
  function append(entry, options = {}) {
    assertOwner();
    return reader.commitEntry(() => ({ ...entry, schemaVersion: 1, epoch, at: now() }), record => {
      mkdirSync(dir, { recursive: true });
      assertOwner();
      const fd = openSync(file, 'a', 0o600);
      try { writeSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      const directory = openSync(dir, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }, options);
  }
  return {
    read, readWork: reader.readWork, readLifecycleFacts: reader.readLifecycleFacts,
    append, assertOwner, recover, journalFile: file, readRecoveryCheckpoint, readContinuationCheckpoint,
    coalesceWorks(owner, retired) {
      const state = read();
      const stamp = work => ({ ...work, revision: (state.works[work.workId]?.revision || 0) + 1, updatedAt: now() });
      return append({ kind: 'continuations_coalesced', owner: stamp(owner), retired: retired.map(work => stamp({ ...work,
        state: 'coalesced', end: 'coalesced', continuationOwnerWorkId: owner.workId })) });
    },
    dispatchOrigin(workId, attemptId, toolCallId) {
      let body;
      try { body = readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      for (const line of body.split('\n').filter(Boolean)) {
        const record = JSON.parse(line), work = record.work;
        const attempt = work?.budget?.attempts?.[attemptId];
        if (work?.workId === workId && work.attemptId && attempt?.role === 'project_agent'
          && attempt.pendingTools?.some(row => row.toolCallId === toolCallId)) {
          return { turnId: work.attemptId, epoch: record.epoch, at: record.at };
        }
      }
      return null;
    },
    decide(decision, host) {
      assertOwner();
      const admitted = admitCoordinationDecision(read(), decision, { ...host, workspaceId, holdsLease: true, now: now() });
      if (admitted.ok && !admitted.replayed) append(admitted.entry);
      return admitted;
    },
    bindSession(workId, goalRevision, sessionId, binding) { return append({ kind: 'coordination_binding', workId, goalRevision, sessionId, binding }); },
    advanceTransition(operationId, expectedPhase, patch) {
      assertOwner();
      if (Object.keys(patch).some(key => !['phase', 'replacementSessionId', 'error', 'updatedAt', 'handoff'].includes(key))) throw new Error('invalid_transition_patch');
      return append({ kind: 'coordination_transition', operationId, expectedPhase, patch: { ...patch, updatedAt: now() } });
    },
    checkpoint(workId, checkpoint) {
      assertOwner();
      const body = JSON.stringify(checkpoint);
      const name = createHash('sha256').update(workId + '\n' + body).digest('hex') + '.json';
      const directory = path.join(dir, 'checkpoints'); mkdirSync(directory, { recursive: true });
      const target = path.join(directory, name);
      assertOwner();
      if (!existsSync(target)) durableFile(target, body);
      return name;
    },
    readCheckpoint(ref) {
      if (!/^[a-f0-9]{64}\.json$/.test(ref || '')) throw new Error('invalid_checkpoint');
      return JSON.parse(readFileSync(path.join(dir, 'checkpoints', ref), 'utf8'));
    },
    transfer(events) { return append({ kind: 'transfer', events }); },
    handled(eventIds) { return append({ kind: 'handled', eventIds }); },
    pendingEvents() { return Object.values(read().events).filter(row => !row.handled).map(row => row.event); },
    saveWork(work, options = {}) { const old = reader.readWork(work.workId); return append({ kind: 'work', work: { ...old, ...work,
      revision: (old?.revision || 0) + 1, updatedAt: now() } }, options); },
  };
}
function reduceEmpty() { return { revision: 0, events: {}, works: {}, deliveries: {} }; }

function durableFile(target, body) {
  const temp = `${target}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, target);
  const directory = openSync(path.dirname(target), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
