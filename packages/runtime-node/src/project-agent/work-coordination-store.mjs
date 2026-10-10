import { createHash } from 'node:crypto';
import { openSync, closeSync, fsyncSync, writeSync, readFileSync, mkdirSync, renameSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';
import { reduceCoordination } from './work-coordination.mjs';
import { admitCoordinationDecision } from './coordination-kernel.mjs';

export function createWorkCoordinationStore({ rootDir, workspaceId, holdsLease = () => false, leaseEpoch = () => null, now = () => new Date().toISOString() }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(workspaceId)) throw new Error('invalid_workspace');
  const dir = path.join(rootDir || pathOf('projectRuntime'), workspaceId);
  const file = path.join(dir, 'coordination.jsonl');
  const epoch = leaseEpoch();
  let cached = null, cacheStamp = '';
  const stamp = () => { const info = statSync(file); return `${info.ino}:${info.size}:${info.mtimeMs}`; };
  function assertOwner() {
    if (holdsLease() !== true || !epoch || leaseEpoch() !== epoch) throw new Error('coordination_lease_lost');
  }
  function read() {
    let body;
    let currentStamp;
    try { currentStamp = stamp(); if (cached && currentStamp === cacheStamp) return structuredClone(cached); body = readFileSync(file, 'utf8'); }
    catch (error) { cached = null; if (error.code === 'ENOENT') return reduceEmpty(); throw error; }
    let state = reduceEmpty();
    for (const line of body.split('\n')) {
      if (!line) continue;
      state = reduceCoordination(state, JSON.parse(line));
    }
    cached = state; cacheStamp = currentStamp;
    return structuredClone(state);
  }
  function recover() {
    assertOwner();
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
    const fd = openSync(file, 'a', 0o600);
    try { writeSync(fd, '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  }
  function append(entry) {
    assertOwner();
    const state = read();
    const record = { ...entry, schemaVersion: 1, epoch, revision: state.revision + 1, at: now() };
    const next = reduceCoordination(state, record);
    mkdirSync(dir, { recursive: true });
    assertOwner();
    const fd = openSync(file, 'a', 0o600);
    try { writeSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    const directory = openSync(dir, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    cached = next; cacheStamp = stamp();
    // A failed/replaced snapshot cannot lose truth: read() always replays the journal.
    const snapshot = path.join(dir, 'coordination-snapshot.json');
    try { writeFileSync(snapshot + '.tmp', JSON.stringify(next), { mode: 0o600 }); renameSync(snapshot + '.tmp', snapshot); } catch { /* rebuildable cache */ }
    return next;
  }
  return {
    read, append, assertOwner, recover,
    decide(decision, host) {
      assertOwner();
      const admitted = admitCoordinationDecision(read(), decision, { ...host, workspaceId, holdsLease: true, now: now() });
      if (admitted.ok && !admitted.replayed) append(admitted.entry);
      return admitted;
    },
    bindSession(workId, goalRevision, sessionId) { return append({ kind: 'coordination_binding', workId, goalRevision, sessionId }); },
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
    saveWork(work) { const old = read().works[work.workId]; return append({ kind: 'work', work: { ...old, ...work,
      revision: (old?.revision || 0) + 1, updatedAt: now() } }); },
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
