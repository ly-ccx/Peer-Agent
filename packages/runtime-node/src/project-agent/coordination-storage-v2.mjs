import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from '../sqlite/connection.mjs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { copyFile, truncate } from 'node:fs/promises';
import { mkdirSync, readFileSync, renameSync, existsSync, statSync, openSync, closeSync, fsyncSync, writeSync, fstatSync, readSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { prepareLegacyIntegrity, acceptsLegacyIntegrity } from './coordination-legacy-integrity.mjs';
import { journalLines } from './journal-lines.mjs';
import { reduceCoordination } from './work-coordination.mjs';
import { encodeWorkUpdate } from './work-delta.mjs';
import { COORDINATION_WORKER_SOURCE } from './coordination-worker-source.generated.mjs';

const buckets = ['events', 'works', 'deliveries', 'mandates', 'decisions', 'transitions', 'inputBindings'];
const empty = () => ({ revision: 0, events: {}, works: {}, deliveries: {} });
const token = file => { try { const s = statSync(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; } catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; } };
const fail = code => Object.assign(new Error(code), { code });
const corruptIndex = error => error.code === 'coordination_index_corrupt' || [11, 26].includes(Number(error.errcode) & 255);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function writeAll(fd, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  for (let offset = 0; offset < bytes.length;) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!count) throw fail('coordination_write_incomplete'); offset += count;
  }
}
function syncPath(file) { const fd = openSync(file, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function readHead(file, generation) {
  let proof; try { proof = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw fail(error.code === 'ENOENT' ? 'coordination_head_missing' : 'coordination_head_invalid'); }
  if (!proof || typeof proof.generation !== 'string' || !proof.generation || !Number.isSafeInteger(proof.revision) || proof.revision < 0
    || typeof proof.hash !== 'string' || !/^(?:[a-f0-9]{64})?$/.test(proof.hash)
    || typeof proof.legacyVersion !== 'string' || !proof.legacyVersion) throw fail('coordination_head_invalid');
  if (generation !== undefined && proof.generation !== generation) throw fail('coordination_head_generation_mismatch');
  return proof;
}
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const x of Object.values(value)) freeze(x); } return value; };
const statements = new WeakMap();
function statement(db, sql) { let cache = statements.get(db); if (!cache) statements.set(db, cache = new Map()); if (!cache.has(sql)) cache.set(sql, db.prepare(sql)); return cache.get(sql); }

function database(file, { derived = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
  db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=${derived ? 'NORMAL' : 'FULL'};`);
  db.exec('CREATE TABLE IF NOT EXISTS objects (bucket TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(bucket,id));'
    + 'CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, value TEXT NOT NULL);'
    + 'CREATE TABLE IF NOT EXISTS observations (workId TEXT, id TEXT, PRIMARY KEY(workId,id));'
    + 'CREATE TABLE IF NOT EXISTS dispatches (workId TEXT, attemptId TEXT, callId TEXT, value TEXT, PRIMARY KEY(workId,attemptId,callId));');
  return db;
  } catch (error) { db.close(); throw error; }
}
const getMeta = (db, id) => { const row = statement(db, 'SELECT value FROM meta WHERE id=?').get(id); return row ? JSON.parse(row.value) : undefined; };
const putMeta = (db, id, value) => statement(db, 'INSERT OR REPLACE INTO meta VALUES (?,?)').run(id, JSON.stringify(value));
const get = (db, bucket, id) => { const row = statement(db, 'SELECT value FROM objects WHERE bucket=? AND id=?').get(bucket, id); return row ? JSON.parse(row.value) : undefined; };
const all = (db, bucket) => Object.fromEntries(statement(db, 'SELECT id,value FROM objects WHERE bucket=?').all(bucket).map(row => [row.id, JSON.parse(row.value)]));
function head(db, id) { return get(db, 'works', id); }
function snapshot(db, receipts = false) {
  const state = { revision: getMeta(db, 'revision') || 0 };
  for (const bucket of buckets) { const rows = all(db, bucket); if (Object.keys(rows).length || ['works', 'events', 'deliveries'].includes(bucket)) state[bucket] = rows; }
  if (receipts) for (const row of db.prepare('SELECT workId,id FROM observations').iterate()) {
    const work = state.works[row.workId]; if (work?.budget) (work.budget.observations ||= {})[row.id] = true;
  }
  if (getMeta(db, 'lastRecovery')) state.lastRecovery = getMeta(db, 'lastRecovery');
  return state;
}

function apply(db, record, { blobs, receiptCache } = {}) {
  if (record.storageVersion === 2) {
    const { hash, ...body } = record;
    if (record.previousHash !== (getMeta(db, 'eventHash') || '') || digest(body) !== hash) throw fail('coordination_hash_mismatch');
  }
  const envelope = record;
  if (record.kind === 'payload_ref') {
    if (!/^[a-f0-9]{64}$/.test(record.payloadRef?.hash || '')) throw fail('coordination_payload_invalid');
    const file = path.join(blobs, record.payloadRef.hash + '.json');
    if (!existsSync(file)) throw fail('coordination_payload_missing');
    const bytes = readFileSync(file);
    if (bytes.length !== record.payloadRef.bytes || createHash('sha256').update(bytes).digest('hex') !== record.payloadRef.hash) throw fail('coordination_payload_invalid');
    record = { ...JSON.parse(bytes), revision: envelope.revision, schemaVersion: 1 };
  }
  const before = empty(); before.revision = getMeta(db, 'revision') || 0;
  const ids = [record.workId, record.work?.workId, record.owner?.workId, ...(record.retired || []).map(w => w.workId)].filter(Boolean);
  for (const id of ids) { const work = head(db, id); if (work) before.works[id] = work; }
  if (['transfer', 'handled'].includes(record.kind)) before.events = all(db, 'events');
  if (record.kind.startsWith('reply_')) {
    const id = record.message?.id || record.messageId, value = get(db, 'deliveries', id);
    if (value) before.deliveries[id] = value;
  }
  if (record.kind.startsWith('coordination_')) for (const key of ['mandates', 'decisions', 'transitions', 'inputBindings']) before[key] = all(db, key);
  if (record.kind === 'usage_observed' && db.prepare('SELECT 1 FROM observations WHERE workId=? AND id=?').get(record.workId, record.observationId)) {
    const work = before.works[record.workId]; if (work?.budget) work.budget.observations = { [record.observationId]: true };
  }
  const next = reduceCoordination(before, record);
  for (const bucket of buckets) for (const [id, original] of Object.entries(next[bucket] || {})) {
    let value = original;
    if (bucket === 'works' && value.budget?.observations) {
      if (receiptCache && receiptCache.workId !== id) { receiptCache.workId = id; receiptCache.ids.clear(); }
      for (const key of Object.keys(value.budget.observations)) {
        if (receiptCache?.ids.has(key)) continue;
        statement(db, 'INSERT OR IGNORE INTO observations VALUES (?,?)').run(id, key);
        if (receiptCache && receiptCache.ids.size < 65536) receiptCache.ids.add(key);
      }
      const { observations, ...budget } = value.budget; value = { ...value, budget };
    }
    if (bucket === 'works') for (const [attemptId, attempt] of Object.entries(value.budget?.attempts || {})) {
      if (attempt.role !== 'project_agent' || !value.attemptId) continue;
      for (const call of attempt.pendingTools || []) if (call.toolCallId) db.prepare('INSERT OR IGNORE INTO dispatches VALUES (?,?,?,?)').run(id, attemptId, call.toolCallId,
        JSON.stringify({ turnId: value.attemptId, epoch: record.epoch, at: record.at }));
    }
    if (JSON.stringify(before[bucket]?.[id]) !== JSON.stringify(value)) db.prepare('INSERT OR REPLACE INTO objects VALUES (?,?,?)').run(bucket, id, JSON.stringify(value));
  }
  putMeta(db, 'revision', next.revision);
  if (envelope.storageVersion === 2) putMeta(db, 'eventHash', envelope.hash);
  if (next.lastRecovery) putMeta(db, 'lastRecovery', next.lastRecovery);
}

function replay(db, file, start = 0, onRead, requireV2 = false, options) {
  if (!existsSync(file)) return 0;
  const before = token(file), fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    for (const line of journalLines(fd, { start, end: size, onRead })) if (line.text) {
      let record;
      try { record = JSON.parse(line.text); }
      catch (error) {
        if (!line.terminated) throw Object.assign(fail('coordination_partial_tail'), { file, validEnd: line.start, sourceToken: before });
        throw error;
      }
      if (requireV2 && record.storageVersion !== 2) throw fail('coordination_schema_unsupported');
      apply(db, record, options);
    }
    if (token(file) !== before) throw fail('coordination_read_changed');
    return size;
  } finally { closeSync(fd); }
}

function sourceFiles(dir, legacy) {
  const segments = path.join(dir, 'segments');
  return [legacy, ...(existsSync(segments) ? readdirSync(segments).filter(x => /^\d{12}\.jsonl$/.test(x)).sort().map(x => path.join(segments, x)) : [])];
}
function anchor(file, size) {
  if (!existsSync(file)) return 'missing';
  const fd = openSync(file, 'r'), digest = createHash('sha256');
  try {
    for (const offset of [0, Math.max(0, size - 192)]) {
      const bytes = Buffer.alloc(Math.min(size, 192));
      if (readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length) throw fail('coordination_read_changed');
      digest.update(bytes);
    }
    return digest.digest('hex');
  } finally { closeSync(fd); }
}
function rebuild({ dir, legacy, target, generation, requireHead = false, legacyIntegrity }) {
  const db = database(target), versions = {}, options = { blobs: path.join(dir, 'blobs'), receiptCache: { workId: null, ids: new Set() } };
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const file of sourceFiles(dir, legacy)) {
      const size = replay(db, file, 0, undefined, file !== legacy, options); versions[file] = token(file);
      putMeta(db, `offset:${file}`, size); putMeta(db, `anchor:${file}`, anchor(file, size));
      if (existsSync(file)) syncPath(file);
    }
    const headFile = path.join(dir, 'head.json');
    if (requireHead && !existsSync(headFile)) throw fail('coordination_head_missing');
    if (existsSync(headFile)) {
      const expected = readHead(headFile, generation);
      if (!acceptsLegacyIntegrity(path.dirname(dir), legacy, expected, legacyIntegrity)) throw fail('coordination_legacy_changed');
      if ((getMeta(db, 'revision') || 0) < expected.revision
        || (getMeta(db, 'revision') || 0) === expected.revision && (getMeta(db, 'eventHash') || '') !== expected.hash) throw fail('coordination_journal_missing');
    }
    if (legacyIntegrity) {
      if (token(legacy) !== legacyIntegrity.version) throw fail('coordination_read_changed');
      putMeta(db, 'legacyIntegrity', legacyIntegrity);
    }
    putMeta(db, 'generation', generation); putMeta(db, 'sources', versions); db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const directory of new Set([path.dirname(dir), path.dirname(path.dirname(dir)), ...Object.keys(versions).filter(existsSync).map(file => path.dirname(file))])) syncPath(directory);
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

/** Journal authority and derived SQL state share one commit/recovery seam. */
export function createCoordinationStorageV2({ directory, legacyFile, assertOwner, onRead = () => {}, segmentBytes = 32 * 1024 * 1024 }) {
  const dir = path.join(directory, 'coordination-v2'), manifestFile = path.join(dir, 'manifest.json');
  const headFile = path.join(dir, 'head.json');
  const indexDirectory = path.join(directory, '.read-models'), pointerFile = path.join(indexDirectory, 'coordination-current.json');
  let db, dbIdentity, indexFile, manifest, cached, cachedRevision, preparing;
  function load() {
    if (!existsSync(manifestFile)) throw fail('coordination_recovery_pending');
    const next = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (next.schemaVersion !== 2 || next.minimumReaderVersion !== 2 || next.minimumWriterVersion !== 2) throw fail('coordination_schema_unsupported');
    if (manifest && next.generation !== manifest.generation) { db?.close(); db = undefined; cached = undefined; }
    manifest = next;
    if (!existsSync(headFile)) throw fail('coordination_head_missing');
    if (!existsSync(pointerFile)) throw fail('coordination_recovery_pending');
    let pointer;
    try { pointer = JSON.parse(readFileSync(pointerFile, 'utf8')); } catch { throw fail('coordination_index_corrupt'); }
    if (pointer.schemaVersion !== 1 || pointer.generation !== manifest.generation || !/^coordination-[a-f0-9-]{36}\.sqlite$/.test(pointer.file || '')) throw fail('coordination_index_corrupt');
    const nextFile = path.join(indexDirectory, pointer.file);
    if (indexFile !== nextFile) { db?.close(); db = undefined; cached = undefined; indexFile = nextFile; }
    if (!existsSync(indexFile)) throw fail('coordination_recovery_pending');
    const identity = token(indexFile).split(':').slice(0, 2).join(':');
    if (db && identity !== dbIdentity) { db.close(); db = undefined; cached = undefined; }
    if (!db) {
      // The journal and durable head are the receipts; an atomic cache commit
      // may be lost on power failure and is caught up from its source offset.
      db = database(indexFile, { derived: true }); dbIdentity = identity;
      if (db.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') throw fail('coordination_index_corrupt');
    }
    if (!acceptsLegacyIntegrity(directory, legacyFile, manifest, getMeta(db, 'legacyIntegrity'))) throw fail('coordination_legacy_changed');
    if (getMeta(db, 'generation') !== manifest.generation) throw fail('coordination_recovery_pending');
    const previous = getMeta(db, 'sources') || {}, files = sourceFiles(dir, legacyFile);
    if (Object.keys(previous).some(file => !files.includes(file))) throw fail('coordination_read_changed');
    for (const file of files) if (token(file) !== previous[file]) {
      // Only the active append-only segment may advance without a rebuild.
      if (file === legacyFile || file !== files.at(-1)) throw fail('coordination_read_changed');
      const offset = getMeta(db, `offset:${file}`) || 0;
      const size = existsSync(file) ? statSync(file).size : 0;
      if (size <= offset) throw fail('coordination_read_changed');
      if (previous[file] && (token(file).split(':').slice(0, 2).join(':') !== previous[file].split(':').slice(0, 2).join(':')
        || anchor(file, offset) !== getMeta(db, `anchor:${file}`))) throw fail('coordination_read_changed');
      db.exec('BEGIN IMMEDIATE');
      try {
        replay(db, file, offset, onRead, true, { blobs: path.join(dir, 'blobs') }); putMeta(db, `offset:${file}`, size);
        putMeta(db, `anchor:${file}`, anchor(file, size));
        previous[file] = token(file); putMeta(db, 'sources', previous); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    {
      const expected = readHead(headFile, manifest.generation);
      if (expected.legacyVersion !== manifest.legacyVersion) throw fail('coordination_legacy_changed');
      if ((getMeta(db, 'revision') || 0) < expected.revision
        || (getMeta(db, 'revision') || 0) === expected.revision && (getMeta(db, 'eventHash') || '') !== expected.hash) throw fail('coordination_journal_missing');
    }
    return db;
  }
  async function prepare() {
    if (preparing) return preparing;
    preparing = (async () => {
      assertOwner();
      try {
        load();
        // A matching derived receipt was already checked by load. Only the
        // original pre-seal baseline needs a one-time proof on this fast path.
        if (manifest.legacyVersion === token(legacyFile)) await prepareLegacyIntegrity({ directory, legacyFile, baseline: manifest, assertOwner, onRead });
        assertOwner(); load(); finishRecovery(); return;
      } catch (error) {
        if (!['coordination_recovery_pending', 'coordination_read_changed', 'coordination_partial_tail', 'coordination_legacy_changed'].includes(error.code) && !corruptIndex(error)) throw error;
      }
      const priorHead = existsSync(headFile) ? readHead(headFile) : null;
      const generation = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')).generation
        : priorHead?.generation ?? randomUUID();
      const baseline = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : priorHead;
      const legacyIntegrity = baseline ? await prepareLegacyIntegrity({ directory, legacyFile, baseline, assertOwner, onRead }) : null;
      assertOwner();
      mkdirSync(indexDirectory, { recursive: true });
      const filename = `coordination-${randomUUID()}.sqlite`, published = path.join(indexDirectory, filename);
      const target = `${published}.tmp`;
      const requireHead = existsSync(manifestFile) || existsSync(headFile);
      const build = () => new Promise((resolve, reject) => {
        const worker = new Worker(COORDINATION_WORKER_SOURCE, { eval: true, ...(!process.versions.bun ? { resourceLimits: { maxOldGenerationSizeMb: 192 } } : {}), workerData: { coordinationRebuild: { dir, legacy: legacyFile, target, generation, requireHead, legacyIntegrity } } });
        let settled = false;
        const finish = error => { if (settled) return; settled = true; clearTimeout(timer); if (error) { void worker.terminate(); reject(error); } else resolve(); };
        const timer = setTimeout(() => finish(fail('coordination_recovery_timeout')), 300000);
        worker.once('message', result => finish(result.ok ? null : Object.assign(new Error(result.message), result)));
        worker.once('error', finish); worker.once('exit', code => finish(fail(`coordination_worker_exit:${code}`)));
      });
      try { await build(); }
      catch (error) {
        const files = sourceFiles(dir, legacyFile);
        if (error.code !== 'coordination_partial_tail' || error.file !== files.at(-1) || token(error.file) !== error.sourceToken) throw error;
        assertOwner();
        const backup = `${error.file}.damaged-${randomUUID()}`, repaired = `${error.file}.repair-${randomUUID()}`;
        await copyFile(error.file, backup); await copyFile(backup, repaired); await truncate(repaired, error.validEnd);
        for (const file of [backup, repaired]) { const fd = openSync(file, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
        mkdirSync(dir, { recursive: true });
        durable(path.join(dir, 'recovery.json'), JSON.stringify({ backup: path.relative(directory, backup), source: path.relative(directory, error.file), validEnd: error.validEnd, sourceToken: error.sourceToken }));
        assertOwner(); if (token(error.file) !== error.sourceToken) throw fail('coordination_read_changed');
        renameSync(repaired, error.file);
        const parent = openSync(path.dirname(error.file), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
        // A new build has no accepted rows from the failed candidate transaction.
        await build();
      }
      assertOwner(); db?.close(); db = undefined;
      // An old client may still have its SQLite file and sidecars open. Publish
      // a distinct basename so its commit/close cannot touch the new cache.
      renameSync(target, published);
      durable(pointerFile, JSON.stringify({ schemaVersion: 1, generation, file: filename }));
      if (!existsSync(manifestFile)) {
        mkdirSync(path.join(dir, 'segments'), { recursive: true });
        const candidate = database(published);
        let legacyVersion;
        try {
          legacyVersion = getMeta(candidate, 'sources')?.[legacyFile] || 'missing';
          if (!priorHead && legacyVersion !== token(legacyFile)) throw fail('coordination_legacy_changed');
          // Preserve an earlier activation marker when only its manifest was lost.
          legacyVersion = priorHead?.legacyVersion ?? legacyVersion;
          await prepareLegacyIntegrity({ directory, legacyFile, baseline: { generation, legacyVersion }, assertOwner, onRead });
          assertOwner();
          durable(headFile, JSON.stringify({ generation, legacyVersion, revision: getMeta(candidate, 'revision') || 0, hash: getMeta(candidate, 'eventHash') || '' }));
        }
        finally { candidate.close(); }
        const value = { schemaVersion: 2, minimumReaderVersion: 2, minimumWriterVersion: 2, generation, legacyFile: path.basename(legacyFile), legacyVersion };
        durable(manifestFile, JSON.stringify(value));
        syncPath(directory); syncPath(path.dirname(directory));
      }
      load();
      finishRecovery();
    })().finally(() => { preparing = undefined; });
    return preparing;
  }
  function finishRecovery() {
      const recoveryFile = path.join(dir, 'recovery.json');
      if (existsSync(recoveryFile)) {
        const recovery = JSON.parse(readFileSync(recoveryFile, 'utf8'));
        if (getMeta(db, 'lastRecovery')?.backup !== recovery.backup) write({ kind: 'journal_recovered', ...recovery, epoch: 'storage-recovery', at: new Date().toISOString() }, { returnState: false });
      }
  }
  function active() { return existsSync(dir); }
  function write(entry, { returnState = true } = {}) {
    assertOwner(); load();
    const raw = typeof entry === 'function' ? entry() : entry;
    const encoded = raw.kind === 'work' ? { ...raw, ...encodeWorkUpdate(head(db, raw.work.workId), raw.work) } : raw;
    let payload = encoded;
    const encodedBytes = Buffer.from(JSON.stringify(encoded));
    if (encodedBytes.length > 64 * 1024 * 1024) throw fail('coordination_record_too_large');
    if (encodedBytes.length > 60 * 1024) {
      const hash = createHash('sha256').update(encodedBytes).digest('hex'), blobs = path.join(dir, 'blobs');
      mkdirSync(blobs, { recursive: true });
      const file = path.join(blobs, hash + '.json');
      if (!existsSync(file)) durable(file, encodedBytes);
      payload = { kind: 'payload_ref', payloadRef: { hash, bytes: encodedBytes.length } };
    }
    const record = JSON.parse(JSON.stringify({ ...payload, schemaVersion: 1, storageVersion: 2,
      previousHash: getMeta(db, 'eventHash') || '', revision: (getMeta(db, 'revision') || 0) + 1 }));
    record.hash = digest(record);
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    if (bytes.length > 64 * 1024) throw fail('coordination_record_too_large');
    db.exec('BEGIN IMMEDIATE');
    let persisted = false;
    try {
      // Validate before appending any bytes. Rollback keeps this a private candidate.
      apply(db, record, { blobs: path.join(dir, 'blobs') }); assertOwner();
      const files = sourceFiles(dir, legacyFile).filter(file => file !== legacyFile);
      let file = files.at(-1);
      if (!file || statSync(file).size + bytes.length > segmentBytes) file = path.join(dir, 'segments', `${String(files.length + 1).padStart(12, '0')}.jsonl`);
      const fd = openSync(file, 'a', 0o600);
      try {
        const size = fstatSync(fd).size;
        if (size) { const readFd = openSync(file, 'r'), tail = Buffer.alloc(1); try { readSync(readFd, tail, 0, 1, size - 1); } finally { closeSync(readFd); }
          if (tail[0] !== 10) writeAll(fd, '\n'); }
        writeAll(fd, bytes); fsyncSync(fd); persisted = true;
      } finally { closeSync(fd); }
      const directoryFd = openSync(path.dirname(file), 'r'); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      durable(headFile, JSON.stringify({ generation: manifest.generation, legacyVersion: manifest.legacyVersion, revision: record.revision, hash: record.hash }));
      const sources = getMeta(db, 'sources') || {}; sources[file] = token(file);
      putMeta(db, 'sources', sources); putMeta(db, `offset:${file}`, statSync(file).size);
      putMeta(db, `anchor:${file}`, anchor(file, statSync(file).size)); assertOwner(); db.exec('COMMIT');
      cached = undefined;
      return returnState ? snapshot(db, true) : undefined;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      if (persisted) throw Object.assign(fail('durable_pending_projection'), { operationId: raw.operationId, cause: error });
      throw error;
    }
  }
  return { active, prepare,
    read() { load(); return snapshot(db, true); },
    readSnapshot() { load(); const revision = getMeta(db, 'revision') || 0; if (!cached || cachedRevision !== revision) { cached = freeze(snapshot(db)); cachedRevision = revision; } return cached; },
    readWork(id) { load(); return head(db, id); },
    readLifecycleFacts() { load(); const state = { revision: getMeta(db, 'revision') || 0 }; for (const key of ['mandates', 'transitions', 'decisions']) state[key] = all(db, key);
      state.workStates = Object.fromEntries(Object.entries(all(db, 'works')).map(([id, work]) => [id, { state: work.state, stopScope: work.stopScope }])); return state; },
    commitEntry: (entry, _persist, options) => write(entry, options),
    hasObservation(workId, id) { load(); return Boolean(db.prepare('SELECT 1 FROM observations WHERE workId=? AND id=?').get(workId, id)); },
    dispatchOrigin(workId, attemptId, callId) { load(); const row = db.prepare('SELECT value FROM dispatches WHERE workId=? AND attemptId=? AND callId=?').get(workId, attemptId, callId); return row ? JSON.parse(row.value) : null; },
    close() { db?.close(); db = undefined; },
  };
}

function durable(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, 'w', 0o600);
  try { writeAll(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file); const dir = openSync(path.dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}

if (!isMainThread && workerData?.coordinationRebuild) {
  try { rebuild(workerData.coordinationRebuild); parentPort.postMessage({ ok: true }); }
  catch (error) { parentPort.postMessage({ ok: false, code: error.code, message: error.message, file: error.file, validEnd: error.validEnd, sourceToken: error.sourceToken }); }
}
