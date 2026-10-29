import { SUPERVISION_BUCKETS } from './agent-supervision-state.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync, readFileSync, writeFileSync, fsyncSync, mkdirSync, readdirSync, lstatSync, realpathSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { journalLines } from './journal-lines.mjs';
import { readLegacySeal } from './coordination-legacy-integrity.mjs';
import { reduceCoordination } from './work-coordination.mjs';
import { historyCheckpointBindings } from './history-resumption.mjs';

const failure = code => Object.assign(new Error(code), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const blank = () => ({ revision: 0, events: {}, works: {}, deliveries: {} });
const buckets = ['works', 'events', 'deliveries', 'mandates', 'decisions', 'transitions', 'inputBindings', ...SUPERVISION_BUCKETS];
const stamp = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
function containedTree(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..') throw failure('coordination_repair_path_invalid');
    current = path.join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw failure('coordination_repair_path_invalid');
  }
  return current;
}
function regular(file) {
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw failure('coordination_repair_path_invalid');
}
function hashFile(file, end, seed = '') {
  regular(file); const fd = openSync(file, 'r'), hash = createHash('sha256').update(seed);
  try {
    const initial = fstatSync(fd, { bigint: true }), size = end ?? Number(initial.size), buffer = Buffer.alloc(256 * 1024);
    if (size > Number(initial.size) || size < 0) throw failure('coordination_repair_prefix_invalid');
    for (let offset = 0; offset < size;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!count) throw failure('coordination_read_changed'); hash.update(buffer.subarray(0, count)); offset += count;
    }
    if (stamp(initial) !== stamp(fstatSync(fd, { bigint: true })) || stamp(initial) !== stamp(lstatSync(file, { bigint: true }))) throw failure('coordination_read_changed');
    return { bytes: size, sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}
function inventory(directory, additional = []) {
  const files = ['coordination.jsonl', ...additional];
  function walk(relative) {
    const dir = path.join(directory, relative);
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw failure('coordination_repair_path_invalid');
    for (const name of readdirSync(dir).sort()) {
      const rel = path.join(relative, name), info = lstatSync(path.join(directory, rel));
      if (info.isSymbolicLink()) throw failure('coordination_repair_path_invalid');
      if (info.isDirectory()) walk(rel); else if (info.isFile()) files.push(rel); else throw failure('coordination_repair_path_invalid');
    }
  }
  walk('coordination-v2');
  return Object.fromEntries(files.sort().map(file => [file, !existsSync(containedTree(directory, file)) ? { missing: true } : hashFile(containedTree(directory, file))]));
}
function replay(file, state, { start = 0, end, v2 = false, hash = '', blobs, allowPartialTail = false, onRecord = () => {} } = {}) {
  regular(file); const fd = openSync(file, 'r');
  try {
    const size = end ?? fstatSync(fd).size;
    for (const line of journalLines(fd, { start, end: size })) if (line.text) {
      if (!line.terminated && !allowPartialTail) throw failure('coordination_repair_partial_tail');
      let entry;
      try { entry = JSON.parse(line.text); }
      catch (error) { if (!line.terminated && allowPartialTail) break; throw error; }
      if (v2) {
        const { hash: actual, ...body } = entry;
        if (entry.storageVersion !== 2 || entry.previousHash !== hash || digest(JSON.stringify(body)) !== actual) throw failure('coordination_hash_mismatch');
        hash = actual;
        if (entry.kind === 'payload_ref') {
          const ref = entry.payloadRef;
          if (!/^[a-f0-9]{64}$/.test(ref?.hash || '')) throw failure('coordination_payload_invalid');
          const file = path.join(blobs, ref.hash + '.json'); regular(file); const bytes = readFileSync(file);
          if (bytes.length !== ref.bytes || digest(bytes) !== ref.hash) throw failure('coordination_payload_invalid');
          entry = { ...JSON.parse(bytes), schemaVersion: 1, revision: entry.revision };
        }
      }
      state = reduceCoordination(state, entry);
      onRecord(state.revision, hash);
    }
    return { state, hash };
  } finally { closeSync(fd); }
}

/** Offline inspection; no Store, lease, execution, input consumption or cache mutation. */
export function inspectCoordinationFork(directory) {
  directory = realpathSync(directory);
  const sources = inventory(directory), v2 = path.join(directory, 'coordination-v2');
  const manifest = JSON.parse(readFileSync(path.join(v2, 'manifest.json'))), head = JSON.parse(readFileSync(path.join(v2, 'head.json')));
  if (manifest.schemaVersion !== 2 || manifest.minimumReaderVersion !== 2 || manifest.minimumWriterVersion !== 2
    || manifest.legacyFile !== 'coordination.jsonl' || manifest.generation !== head.generation || manifest.legacyVersion !== head.legacyVersion)
    throw failure('coordination_repair_baseline_invalid');
  const bytes = Number(manifest.legacyVersion.split(':')[2]);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes >= sources['coordination.jsonl'].bytes) throw failure('coordination_repair_no_fork');
  const legacy = path.join(directory, 'coordination.jsonl'), prefix = hashFile(legacy, bytes);
  const seal = readLegacySeal(directory, manifest);
  if (seal && (seal.seal.bytes !== prefix.bytes || seal.seal.sha256 !== prefix.sha256)) throw failure('coordination_legacy_changed');
  const base = replay(legacy, blank(), { end: bytes }).state;
  let current = { state: base, hash: '' };
  for (const file of Object.keys(sources).filter(file => /^coordination-v2\/segments\/\d{12}\.jsonl$/.test(file)).sort()) {
    current = replay(path.join(directory, file), current.state, { v2: true, hash: current.hash, blobs: path.join(v2, 'blobs') });
  }
  if (current.state.revision !== head.revision || current.hash !== head.hash) throw failure('coordination_journal_missing');
  const old = replay(legacy, base, { start: bytes }).state, conflicts = [], merged = blank();
  const checkpoints = [], refs = new Set();
  for (const [branch, state] of [['baseline', base], ['current', current.state], ['legacy', old]]) {
    for (const work of Object.values(state.works)) for (const { ref, owner } of historyCheckpointBindings(work)) {
      if (!/^[a-f0-9]{64}\.json$/.test(ref)) { checkpoints.push({ branch, workId: work.workId, ref, status: 'invalid_ref' }); continue; }
      const relative = 'checkpoints/' + ref, file = containedTree(directory, relative); refs.add(relative);
      if (!existsSync(file)) { checkpoints.push({ branch, workId: work.workId, ref, status: 'missing' }); continue; }
      const proof = hashFile(file), bound = hashFile(file, undefined, owner + '\n');
      checkpoints.push({ branch, workId: work.workId, ref, status: bound.sha256 + '.json' === ref ? 'verified' : 'hash_mismatch', ...proof });
    }
  }
  const boundSources = inventory(directory, [...refs]);
  for (const file of Object.keys(sources)) if (stable(sources[file]) !== stable(boundSources[file])) throw failure('coordination_read_changed');
  Object.assign(sources, boundSources);
  for (const bucket of buckets) {
    const a = base[bucket] || {}, b = current.state[bucket] || {}, c = old[bucket] || {};
    merged[bucket] = {};
    for (const id of new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(c)])) {
      const same = (x, y) => stable(x) === stable(y);
      const conflict = !same(b[id], c[id]) && !same(a[id], b[id]) && !same(a[id], c[id]);
      // Conflicts retain both originals in the archive and report. No timestamp arbitrates truth.
      const value = same(a[id], b[id]) ? c[id] : b[id];
      if (value !== undefined) merged[bucket][id] = structuredClone(value);
      if (conflict) conflicts.push({ bucket, id, baseline: a[id], current: b[id], legacy: c[id] });
    }
  }
  // No historical continuation or prepared reply is executed by repair or by startup.
  const heldWorkIds = [];
  for (const work of Object.values(merged.works)) {
    if (['cancelled', 'delivered', 'coalesced'].includes(work.state)) continue;
    heldWorkIds.push(work.workId);
    work.historyRecovery = { disposition: 'held', previousState: work.state, previousRecovery: work.recovery ?? null };
    work.recovery = { ...work.recovery, retryable: false, retryAt: undefined, reservationId: undefined,
      blockedCode: 'COORDINATION_RECONCILIATION_REQUIRED' };
  }
  merged.revision = 0;
  const result = { schemaVersion: 1, sourceFingerprint: digest(stable(sources)), sources, baselinePrefix: prefix,
    unsealedBaseline: !seal, generation: manifest.generation,
    baseRevision: base.revision, currentRevision: current.state.revision, legacyRevision: old.revision,
    conflicts, checkpoints, heldWorkIds, executionBlocked: true, state: merged };
  if (stable(sources) !== stable(inventory(directory, [...refs]))) throw failure('coordination_read_changed');
  return result;
}

/** Read the published recovery journal directly; inspection never repairs a cache or a torn tail. */
export function readRecoveredCoordination(directory, generation, { includeProof = false } = {}) {
  directory = realpathSync(directory);
  const v2 = containedTree(directory, 'coordination-v2');
  const manifestFile = containedTree(directory, 'coordination-v2/manifest.json');
  const headFile = containedTree(directory, 'coordination-v2/head.json');
  const segments = () => readdirSync(containedTree(directory, 'coordination-v2/segments')).sort()
    .filter(name => /^\d{12}\.jsonl$/.test(name)).map(name => `coordination-v2/segments/${name}`);
  const files = ['coordination-v2/manifest.json', 'coordination-v2/head.json', 'coordination-v2/baseline.jsonl', ...segments()];
  const proof = () => Object.fromEntries(files.map(file => [file, hashFile(containedTree(directory, file))]));
  const before = proof(), manifest = JSON.parse(readFileSync(manifestFile)), head = JSON.parse(readFileSync(headFile));
  const fence = containedTree(directory, 'coordination.jsonl');
  if (manifest.schemaVersion !== 2 || ![3, 4, 5, 6].includes(manifest.minimumReaderVersion)
    || manifest.minimumWriterVersion !== manifest.minimumReaderVersion || manifest.frozenLegacyFile !== 'baseline.jsonl'
    || manifest.generation !== generation || head.generation !== generation || manifest.legacyVersion !== head.legacyVersion
    || !lstatSync(fence).isDirectory()) throw failure('coordination_repair_plan_changed');
  let result = replay(containedTree(directory, 'coordination-v2/baseline.jsonl'), blank());
  let observedHead = result.state.revision === head.revision && result.hash === head.hash;
  for (const file of files.slice(3)) result = replay(containedTree(directory, file), result.state,
    { v2: true, hash: result.hash, blobs: containedTree(directory, 'coordination-v2/blobs'), allowPartialTail: file === files.at(-1),
      onRecord: (revision, hash) => { if (revision === head.revision && hash === head.hash) observedHead = true; } });
  if (!observedHead || result.state.revision < head.revision) throw failure('coordination_journal_missing');
  if (stable(before) !== stable(proof()) || stable(files.slice(3)) !== stable(segments())) throw failure('coordination_read_changed');
  return includeProof ? { state: result.state, sourceFingerprint: digest(stable(before)) } : result.state;
}
function durable(file, bytes) {
  const tmp = file + '.' + randomUUID() + '.tmp'; writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
  const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file); const parent = openSync(path.dirname(file), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}
function assertOffline(directory) {
  if (existsSync(path.join(directory, 'host.lease'))) throw failure('coordination_repair_active');
}

/** Explicit maintenance only. Caller reviews the prefix digest, including absent historical seal.
 * Re-entry resumes only this bound intent. Original journals remain byte-for-byte archived.
 */
export function recoverCoordinationForkBackup({ directory, sourceFingerprint, reviewedPrefixSha256, onStep = () => {}, assertMaintenanceOwner = null }) {
  // An online caller must drain the project and retain the same real lease epoch.
  // CLI/default callers retain the stricter offline-only interface.
  const offline = target => typeof assertMaintenanceOwner === 'function' ? assertMaintenanceOwner() : assertOffline(target);
  directory = realpathSync(directory); offline(directory);
  const intentFile = path.join(directory, 'coordination-recovery.json');
  let intent;
  if (existsSync(intentFile)) {
    regular(intentFile); intent = JSON.parse(readFileSync(intentFile));
    if (intent.schemaVersion !== 1 || intent.sourceFingerprint !== sourceFingerprint || intent.reviewedPrefixSha256 !== reviewedPrefixSha256
      || !/^[a-f0-9]{64}$/.test(sourceFingerprint) || intent.archive !== `.coordination-recovery/${sourceFingerprint}`)
      throw failure('coordination_repair_plan_changed');
  } else {
    const plan = inspectCoordinationFork(directory);
    if (plan.sourceFingerprint !== sourceFingerprint || plan.baselinePrefix.sha256 !== reviewedPrefixSha256) throw failure('coordination_repair_plan_changed');
    const archive = `.coordination-recovery/${sourceFingerprint}`, root = path.join(directory, archive);
    containedTree(directory, archive);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // Archive copies, candidate and intent are durable before changing any canonical path.
    for (const file of Object.keys(plan.sources)) {
      if (plan.sources[file].missing) continue;
      const p = containedTree(directory, archive + '/original/' + file);
      mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      if (!existsSync(p)) {
        const tmp = p + '.' + randomUUID() + '.tmp'; copyFileSync(path.join(directory, file), tmp);
        const fd = openSync(tmp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(tmp, p);
      }
      if (stable(hashFile(p)) !== stable(plan.sources[file])) throw failure('coordination_read_changed');
      const parent = openSync(path.dirname(p), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    const generation = randomUUID(), candidateName = 'candidate-' + generation, candidate = path.join(root, candidateName); mkdirSync(path.join(candidate, 'segments'), { recursive: true });
    const recovery = { sourceFingerprint, archive, executionBlocked: true, heldWorkIds: plan.heldWorkIds,
      conflicts: plan.conflicts.map(({ bucket, id }) => ({ bucket, id })) };
    const entry = { kind: 'history_reconciled', schemaVersion: 1, revision: 1, state: plan.state, recovery,
      stateHash: digest(stable(plan.state)), at: new Date().toISOString() };
    durable(path.join(candidate, 'baseline.jsonl'), JSON.stringify(entry) + '\n');
    const s = lstatSync(path.join(candidate, 'baseline.jsonl'), { bigint: true }), legacyVersion = stamp(s);
    const closure = Object.values(plan.state.transitions || {}).some(row => row.minimumExecutorVersion === 3 || row.reconciliationRef)
      || Object.values(plan.state.agentCommands || {}).some(row => row.completionRecorded === true);
    const minimumVersion = closure ? 6 : SUPERVISION_BUCKETS.some(bucket => Object.keys(plan.state[bucket] || {}).length) ? 5 : 3;
    durable(path.join(candidate, 'head.json'), JSON.stringify({ generation, legacyVersion, revision: 1, hash: '', minimumWriterVersion: minimumVersion }));
    durable(path.join(candidate, 'manifest.json'), JSON.stringify({ schemaVersion: 2, minimumReaderVersion: minimumVersion, minimumWriterVersion: minimumVersion,
      generation, legacyFile: 'coordination.jsonl', frozenLegacyFile: 'baseline.jsonl', legacyVersion }));
    durable(path.join(root, 'inspection.json'), JSON.stringify(plan));
    offline(directory);
    if (stable(plan.sources) !== stable(inventory(directory, Object.keys(plan.sources).filter(file => file.startsWith('checkpoints/'))))) throw failure('coordination_read_changed');
    const candidateProof = Object.fromEntries(['baseline.jsonl', 'head.json', 'manifest.json'].map(file => [file, hashFile(path.join(candidate, file))]));
    intent = { schemaVersion: 1, sourceFingerprint, reviewedPrefixSha256, archive, generation, candidateName, candidateProof, status: 'prepared' };
    durable(intentFile, JSON.stringify(intent)); onStep('prepared');
  }
  containedTree(directory, intent.archive);
  if (!/^candidate-[a-f0-9-]{36}$/.test(intent.candidateName)) throw failure('coordination_repair_plan_changed');
  const root = path.join(directory, intent.archive), original = path.join(root, 'original');
  // Revalidate durable copies on every resume. A lost/tampered archive never admits a repair.
  containedTree(directory, intent.archive + '/inspection.json');
  const plan = JSON.parse(readFileSync(path.join(root, 'inspection.json')));
  if (plan.sourceFingerprint !== sourceFingerprint || digest(stable(plan.sources)) !== sourceFingerprint
    || plan.baselinePrefix.sha256 !== reviewedPrefixSha256) throw failure('coordination_repair_plan_changed');
  for (const [file, proof] of Object.entries(plan.sources)) {
    if (proof.missing) { if (existsSync(containedTree(directory, file))) throw failure('coordination_read_changed'); continue; }
    if (stable(hashFile(containedTree(directory, intent.archive + '/original/' + file))) !== stable(proof)) throw failure('coordination_read_changed');
    if (file.startsWith('checkpoints/') && stable(hashFile(containedTree(directory, file))) !== stable(proof)) throw failure('coordination_read_changed');
  }
  const canonical = path.join(directory, 'coordination-v2'), legacy = path.join(directory, 'coordination.jsonl');
  if (intent.status === 'complete') {
    const manifest = JSON.parse(readFileSync(path.join(canonical, 'manifest.json')));
    if (manifest.generation !== intent.generation || !lstatSync(legacy).isDirectory()) throw failure('coordination_repair_plan_changed');
    return { ok: true, executionBlocked: true, archive: intent.archive, reused: true };
  }
  const validateCandidate = candidate => {
    for (const [file, proof] of Object.entries(intent.candidateProof || {})) {
      if (!['baseline.jsonl', 'head.json', 'manifest.json'].includes(file) || stable(hashFile(path.join(candidate, file))) !== stable(proof)) throw failure('coordination_read_changed');
    }
    if (Object.keys(intent.candidateProof || {}).length !== 3) throw failure('coordination_repair_plan_changed');
  };
  const staged = containedTree(directory, intent.archive + '/' + intent.candidateName);
  validateCandidate(existsSync(staged) ? staged : canonical);
  const movedV2 = path.join(root, 'moved-v2'), movedLegacy = path.join(root, 'moved-legacy.jsonl');
  offline(directory);
  if (!existsSync(movedV2)) {
    if (stable(plan.sources) !== stable(inventory(directory, Object.keys(plan.sources).filter(file => file.startsWith('checkpoints/'))))) throw failure('coordination_read_changed');
    renameSync(canonical, movedV2); onStep('v2-archived');
  }
  if (!existsSync(movedLegacy)) {
    if (stable(hashFile(legacy)) !== stable(plan.sources['coordination.jsonl'])) throw failure('coordination_read_changed');
    renameSync(legacy, movedLegacy); onStep('legacy-archived');
  }
  // The canonical baseline is a distinct inode, so a previously opened old descriptor cannot mutate it.
  if (stable(hashFile(movedLegacy)) !== stable(plan.sources['coordination.jsonl'])) throw failure('coordination_read_changed');
  if (!existsSync(legacy)) mkdirSync(legacy, { mode: 0o700 });
  if (!lstatSync(legacy).isDirectory() || lstatSync(legacy).isSymbolicLink()) throw failure('coordination_writer_fence_missing');
  onStep('writer-fenced'); offline(directory);
  validateCandidate(existsSync(staged) ? staged : canonical);
  if (!existsSync(canonical)) renameSync(staged, canonical);
  validateCandidate(canonical);
  const manifest = JSON.parse(readFileSync(path.join(canonical, 'manifest.json')));
  if (manifest.generation !== intent.generation) throw failure('coordination_repair_plan_changed');
  const parent = openSync(directory, 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
  onStep('published'); durable(intentFile, JSON.stringify({ ...intent, status: 'complete' }));
  return { ok: true, executionBlocked: true, archive: intent.archive, heldWorkIds: plan.heldWorkIds };
}
