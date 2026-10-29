import { createHash, randomUUID } from 'node:crypto';
import {
  openSync,
  closeSync,
  fsyncSync,
  writeSync,
  readSync,
  fstatSync,
  readFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  copyFileSync,
  truncateSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';
import { reduceCoordination } from './work-coordination.mjs';
import { admitCoordinationDecision } from './coordination-kernel.mjs';
import { createCoordinationJournalReader } from './coordination-journal-reader.mjs';
import { createRecoveryCheckpointView, createContinuationCheckpointView } from './recovery-checkpoint-view.mjs';
import { createCoordinationStorageV2 } from './coordination-storage-v2.mjs';
import { protectCoordinationWriter } from './coordination-writer-fence.mjs';
import { journalLines } from './journal-lines.mjs';

export function createWorkCoordinationStore({ rootDir, workspaceId, holdsLease = () => false, leaseEpoch = () => null, now = () => new Date().toISOString(), onJournalRead, formatVersion = 1, segmentBytes, fenceLegacyWrites = false }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(workspaceId)) throw new Error('invalid_workspace');
  const dir = path.join(rootDir || pathOf('projectRuntime'), workspaceId);
  const file = path.join(dir, 'coordination.jsonl');
  const epoch = leaseEpoch();
  const legacyReader = createCoordinationJournalReader({ file, onRead: onJournalRead });
  const storage = createCoordinationStorageV2({ directory: dir, legacyFile: file, assertOwner, onRead: onJournalRead, segmentBytes });
  const useV2 = () => formatVersion === 2 || storage.active();
  const reader = Object.fromEntries(['read', 'readSnapshot', 'readWork', 'readLifecycleFacts', 'commitEntry'].map(method =>
    [method, (...args) => (useV2() ? storage : legacyReader)[method](...args)]));
  const readRecoveryCheckpoint = createRecoveryCheckpointView(path.join(dir, 'checkpoints'));
  const readContinuationCheckpoint = createContinuationCheckpointView(path.join(dir, 'checkpoints'));
  function assertOwner() {
    if (holdsLease() !== true || !epoch || leaseEpoch() !== epoch) throw new Error('coordination_lease_lost');
  }
  const read = reader.read;
  function recover() {
    assertOwner();
    if (useV2()) return reader.readSnapshot();
    // Most kicks see a complete append-only journal. Do not read its entire
    // body merely to inspect its last separator; the reader validates changes.
    let fd;
    try {
      fd = openSync(file, 'r');
      const size = fstatSync(fd).size, tail = Buffer.alloc(1);
      if (!size || readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] === 10) { read(); return; }
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    const source = statSync(file, { bigint: true });
    let damagedAt = null, state = reduceEmpty();
    fd = openSync(file, 'r');
    try { for (const line of journalLines(fd, { end: Number(source.size) })) {
      if (!line.text) continue;
      let record;
      try { record = JSON.parse(line.text); } catch (error) { if (line.terminated) throw error; damagedAt = line.start; break; }
      state = reduceCoordination(state, record);
    } } finally { closeSync(fd); }
    if (damagedAt !== null) {
      const backup = `coordination-damaged-${randomUUID()}.jsonl`, repaired = `${file}.repair-${randomUUID()}`;
      copyFileSync(file, path.join(dir, backup)); copyFileSync(path.join(dir, backup), repaired); truncateSync(repaired, damagedAt);
      for (const target of [path.join(dir, backup), repaired]) { const handle = openSync(target, 'r'); try { fsyncSync(handle); } finally { closeSync(handle); } }
      const current = statSync(file, { bigint: true }); assertOwner();
      if (['ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => current[key] !== source[key])) throw new Error('coordination_read_changed');
      renameSync(repaired, file); const handle = openSync(dir, 'r'); try { fsyncSync(handle); } finally { closeSync(handle); }
      append({ kind: 'journal_recovered', backup }); return;
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
    read, readSnapshot: reader.readSnapshot, readWork: reader.readWork, readLifecycleFacts: reader.readLifecycleFacts,
    append, assertOwner, recover, prepare: async () => {
      if (!useV2()) return;
      // Finish an interrupted owned fence before trying to load mismatched head/manifest.
      if (fenceLegacyWrites && existsSync(path.join(dir, 'coordination-fence.json'))) await protectCoordinationWriter({ directory: dir, assertOwner });
      await storage.prepare();
      if (fenceLegacyWrites && await protectCoordinationWriter({ directory: dir, assertOwner })) await storage.prepare();
    }, close: storage.close,
    journalFile: file, readRecoveryCheckpoint, readContinuationCheckpoint,
    enableSupervision() { assertOwner(); if (!useV2()) throw new Error('coordination_recovery_pending'); storage.enableSupervision(); },
    readSupervision: (bucket, id) => useV2() ? storage.readSupervision(bucket, id) : undefined,
    querySupervision: (bucket, field, value, options) => useV2() ? storage.querySupervision(bucket, field, value, options) : [],
    observeUsage(workId, observationId, usage) {
      assertOwner();
      if (useV2() && storage.hasObservation(workId, observationId)) return false;
      if (!useV2() && reader.readWork(workId)?.budget?.observations?.[observationId]) return false;
      append({ kind: 'usage_observed', workId, observationId, tokens: usage?.totalTokens ?? null, costUsd: usage?.estimatedCostUsd ?? null }, { returnState: false });
      return true;
    },
    coalesceWorks(owner, retired) {
      const state = read();
      const stamp = work => ({ ...work, revision: (state.works[work.workId]?.revision || 0) + 1, updatedAt: now() });
      return append({ kind: 'continuations_coalesced', owner: stamp(owner), retired: retired.map(work => stamp({ ...work,
        state: 'coalesced', end: 'coalesced', continuationOwnerWorkId: owner.workId })) });
    },
    dispatchOrigin(workId, attemptId, toolCallId) {
      if (useV2()) return storage.dispatchOrigin(workId, attemptId, toolCallId);
      let fd;
      try { fd = openSync(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      try { for (const line of journalLines(fd, { end: fstatSync(fd).size })) {
        if (!line.text) continue;
        const record = JSON.parse(line.text), work = record.work;
        const attempt = work?.budget?.attempts?.[attemptId];
        if (work?.workId === workId && work.attemptId && attempt?.role === 'project_agent'
          && attempt.pendingTools?.some(row => row.toolCallId === toolCallId)) {
          return { turnId: work.attemptId, epoch: record.epoch, at: record.at };
        }
      } } finally { closeSync(fd); }
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
      if (Object.keys(patch).some(key => !['phase', 'replacementSessionId', 'error', 'updatedAt', 'handoff', 'executionAdmission', 'executionEffect', 'executionAttemptRef'].includes(key))) throw new Error('invalid_transition_patch');
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
    pendingEvents() { return structuredClone(Object.values(reader.readSnapshot().events).filter(row => !row.handled).map(row => row.event)); },
    saveWork(work, options = {}) { const old = reader.readWork(work.workId);
      if (useV2() && old && Object.entries(work).every(([key, value]) => ['revision', 'updatedAt'].includes(key) || JSON.stringify(old[key]) === JSON.stringify(value))) return options.returnState === false ? undefined : read();
      return append({ kind: 'work', work: { ...old, ...work,
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
