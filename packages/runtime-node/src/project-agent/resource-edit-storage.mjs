import { createResourceEditExecutionTables, createResourceEditExecutionStorage, validateResourceEditExecutions, ensureResourceEditExecutionBudget } from './resource-edit-execution-storage.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from '../sqlite/connection.mjs';
import { pathOf } from '../data-store.mjs';
import { normalizeResourceTextDraft, normalizeResourceTextSnapshot, normalizeResourceEditTarget, resourceEditDigest, resourceEditToken, validResourceEditText } from '@peer-agent/protocol';
import { emptyResourceEditState, recoverResourceEditState, reduceResourceEdit } from '@peer-agent/runtime-core';

const activeEpochs = new Set();
const MANIFEST_BYTES = 2 * 1024 * 1024, BLOB_BYTES = 64 * 1024 * 1024, RECEIPT_RESERVE = 32 * 1024;
const digest = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const fail = code => ({ ok: false, code });
const problem = code => Object.assign(Error(code), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => structuredClone(value);
const safe = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const allOperations = manifest => [...manifest.operations, ...manifest.retiredOperations];
function metadata(raw) {
  if (!safe(raw, ['id', 'target', 'baseBlob', 'textBlob', 'revision', 'createdAt', 'updatedAt']) || !resourceEditDigest(raw.baseBlob) || !resourceEditDigest(raw.textBlob)) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
  const value = normalizeResourceTextDraft({ id: raw.id, target: raw.target, revision: raw.revision, createdAt: raw.createdAt, updatedAt: raw.updatedAt, baseText: '', text: '' });
  if (!value || value.target.base.contentVersion !== raw.baseBlob) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
  const { baseText: _base, text: _text, ...meta } = value;
  return { ...meta, baseBlob: raw.baseBlob, textBlob: raw.textBlob };
}
function encodeDraft(draft) {
  const { baseText, text, ...meta } = draft;
  return { ...meta, baseBlob: digest(baseText), textBlob: digest(text) };
}
function liveProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function directory(parent, name) {
  const location = path.join(parent, name);
  try { mkdirSync(location, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(location); if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
  return location;
}
function assertFile(file) {
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
}
function codeOf(error) {
  if (error?.errcode === 5 || error?.errcode === 6 || /SQLITE_BUSY|database is locked/.test(error?.message || '')) return 'RESOURCE_EDIT_STORAGE_BUSY';
  return typeof error?.code === 'string' && error.code.startsWith('RESOURCE_EDIT_') ? error.code : 'RESOURCE_EDIT_STORAGE_UNAVAILABLE';
}

/** Device-local intent and retained bytes only. This Module never opens a project file or invokes a capability. */
export function createResourceEditStorage({ rootDir = null, hostEpoch = randomUUID(), now = () => new Date().toISOString() } = {}) {
  if (!resourceEditToken(hostEpoch) || activeEpochs.has(hostEpoch)) throw TypeError('INVALID_RESOURCE_EDIT_HOST');
  activeEpochs.add(hostEpoch);
  const contexts = new Map(); let disposed = false;
  const ports = { hashText: digest, now };
  function connect(workspaceId, create = false) {
    if (disposed || !resourceEditToken(workspaceId)) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    if (contexts.has(workspaceId)) return contexts.get(workspaceId);
    const supplied = rootDir || pathOf('projectRuntime');
    if (!existsSync(supplied)) { if (!create) return null; mkdirSync(supplied, { recursive: true, mode: 0o700 }); }
    const root = realpathSync(supplied), workspace = path.join(root, workspaceId), folder = path.join(workspace, 'resource-edits'), file = path.join(folder, 'store.sqlite');
    if (!create && !existsSync(file)) return null;
    directory(root, workspaceId); directory(workspace, 'resource-edits');
    for (const suffix of ['', '-wal', '-shm', '-journal']) assertFile(file + suffix);
    if (!existsSync(file)) { const fd = openSync(file, 'wx', 0o600); closeSync(fd); }
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout=0;');
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (![0, 1, 2].includes(version) || db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
      if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=8388608; PRAGMA wal_autocheckpoint=256;');
      if (version === 0) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE manifest(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL CHECK(length(CAST(value AS BLOB)) <= ${MANIFEST_BYTES}));
          CREATE TABLE blobs(digest TEXT PRIMARY KEY, body BLOB NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0 AND bytes<=1048576 AND bytes=length(body)));
          CREATE TABLE operation_bodies(requestId TEXT PRIMARY KEY, baseBlob TEXT NOT NULL, proposedBlob TEXT NOT NULL);
          CREATE TABLE delivery_snapshots(id TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(length(CAST(value AS BLOB))<=65536), blob TEXT);
          CREATE TABLE host_owner(id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, epoch TEXT NOT NULL);
          `);
        createResourceEditExecutionTables(db); db.exec('PRAGMA user_version=2; COMMIT;');
      }
      const context = { db, workspaceId, writers: [], writerSequence: 0, file, schemaVersion: version === 0 ? 2 : version };
      const expected = ['manifest', 'blobs', 'operation_bodies', 'delivery_snapshots', 'host_owner', ...(context.schemaVersion === 2 ? ['execution_results'] : [])].sort();
      const actual = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name).sort();
      if (!equal(actual, expected)) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
      if (version === 1) {
        db.exec('BEGIN IMMEDIATE;'); const epoch = owner(context, true); load(context, epoch);
        createResourceEditExecutionTables(db); db.exec('PRAGMA user_version=2; COMMIT;'); context.schemaVersion = 2;
      }
      contexts.set(workspaceId, context); return context;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
  }
  function owner(context, claim) {
    const row = context.db.prepare('SELECT pid,epoch FROM host_owner WHERE id=1').get();
    if (row && row.epoch === hostEpoch && Number(row.pid) === process.pid) return hostEpoch;
    // Other workers can share this PID while having a different module-local epoch set.
    // An unknown epoch in a live process is busy, never evidence that its writer died.
    const alive = row && liveProcess(Number(row.pid));
    if (row && (!resourceEditToken(row.epoch) || alive)) {
      if (claim) throw problem('RESOURCE_EDIT_HOST_BUSY'); return row.epoch;
    }
    if (claim) context.db.prepare('INSERT OR REPLACE INTO host_owner VALUES(1,?,?)').run(process.pid, hostEpoch);
    return hostEpoch;
  }
  function readBlob(context, hash) {
    if (!resourceEditDigest(hash)) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    const row = context.db.prepare('SELECT body,bytes FROM blobs WHERE digest=?').get(hash);
    if (!row || Number(row.bytes) > 1024 * 1024) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    const body = Buffer.from(row.body), text = body.toString('utf8');
    if (body.byteLength !== Number(row.bytes) || digest(body) !== hash || !validResourceEditText(text) || !Buffer.from(text).equals(body)) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    return text;
  }
  function putBlob(context, text) {
    if (!validResourceEditText(text)) throw problem('RESOURCE_EDIT_TEXT_LIMIT');
    const hash = digest(text), existing = context.db.prepare('SELECT bytes FROM blobs WHERE digest=?').get(hash);
    if (existing) { if (readBlob(context, hash) !== text) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE'); return hash; }
    const total = Number(context.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM blobs').get().bytes);
    if (total + bytes(text) > BLOB_BYTES) throw problem('RESOURCE_EDIT_BLOB_LIMIT');
    const body = Buffer.from(text); context.db.prepare('INSERT INTO blobs VALUES(?,?,?)').run(hash, body, body.byteLength); return hash;
  }
  function load(context, epoch) {
    const row = context.db.prepare('SELECT revision,value FROM manifest WHERE id=1').get();
    if (!row) {
      if (context.schemaVersion === 2 && Number(context.db.prepare('SELECT COUNT(*) AS n FROM execution_results').get().n) || Number(context.db.prepare('SELECT COUNT(*) AS n FROM delivery_snapshots').get().n) || Number(context.db.prepare('SELECT COUNT(*) AS n FROM operation_bodies').get().n) || Number(context.db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n)) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
      return { schemaVersion: 1, workspaceId: context.workspaceId, revision: 0, drafts: [], operations: [], retiredOperations: [] };
    }
    if (typeof row.value !== 'string' || bytes(row.value) > MANIFEST_BYTES) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    const raw = JSON.parse(row.value);
    if (!safe(raw, ['schemaVersion', 'workspaceId', 'revision', 'drafts', 'operations', 'retiredOperations']) || raw.schemaVersion !== 1 || raw.workspaceId !== context.workspaceId
      || raw.revision !== Number(row.revision) || !Array.isArray(raw.drafts) || raw.drafts.length > 16) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    const drafts = raw.drafts.map(metadata), state = recoverResourceEditState({ ...raw, drafts: [] }, context.workspaceId, epoch, digest);
    if (!state || new Set(drafts.map(d => d.id)).size !== drafts.length || new Set(drafts.map(d => JSON.stringify(d.target))).size !== drafts.length) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    const manifest = { schemaVersion: 1, workspaceId: context.workspaceId, revision: state.revision, drafts, operations: state.operations, retiredOperations: state.retiredOperations };
    for (const draft of drafts) {
      if (draft.target.recipient.workspaceId !== context.workspaceId || [draft.baseBlob, draft.textBlob].some(hash => !context.db.prepare('SELECT 1 FROM blobs WHERE digest=?').get(hash))) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
      if (allOperations(manifest).some(op => op.draftId === draft.id && (!equal(op.target, draft.target) || op.draftRevision > draft.revision))) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    }
    for (const retained of context.db.prepare('SELECT requestId,baseBlob,proposedBlob FROM operation_bodies').all()) {
      const op = state.operations.find(op => op.requestId === retained.requestId);
      if (!op || op.target.base.contentVersion !== retained.baseBlob || op.proposedVersion !== retained.proposedBlob
        || [retained.baseBlob, retained.proposedBlob].some(hash => !context.db.prepare('SELECT 1 FROM blobs WHERE digest=?').get(hash))) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    }
    if (state.operations.some(op => op.phase !== 'settled' && !context.db.prepare('SELECT 1 FROM operation_bodies WHERE requestId=?').get(op.requestId))) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    const deliveries = context.db.prepare('SELECT id,value,blob FROM delivery_snapshots').all();
    if (deliveries.length > 1024 || deliveries.reduce((n, row) => n + bytes(row.value), 0) > MANIFEST_BYTES) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    let retainedDeliveries = 0;
    for (const row of deliveries) {
      const snapshot = normalizeResourceTextSnapshot(JSON.parse(row.value));
      if (snapshot?.availability === 'retained') retainedDeliveries++;
      if (!snapshot || snapshot.id !== row.id || snapshot.target.recipient.workspaceId !== context.workspaceId || snapshot.purpose !== 'delivery'
        || snapshot.availability === 'retained' && (row.blob !== snapshot.version || !context.db.prepare('SELECT 1 FROM blobs WHERE digest=?').get(row.blob))
        || snapshot.availability === 'cleaned' && row.blob !== null) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    }
    if (retainedDeliveries > 32) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    if (context.schemaVersion === 2) validateResourceEditExecutions(context, manifest);
    return manifest;
  }
  function hydrate(context, meta) {
    const { baseBlob, textBlob, ...draft } = meta;
    return { ...draft, baseText: readBlob(context, baseBlob), text: readBlob(context, textBlob) };
  }
  function writeManifest(context, manifest) {
    ensureResourceEditExecutionBudget(context, manifest);
    const value = JSON.stringify(manifest), reserved = manifest.operations.filter(op => op.phase !== 'settled').length * RECEIPT_RESERVE;
    if (bytes(value) + reserved > MANIFEST_BYTES) throw problem('RESOURCE_EDIT_MANIFEST_LIMIT');
    context.db.prepare('INSERT OR REPLACE INTO manifest VALUES(1,?,?)').run(manifest.revision, value);
  }
  function transaction(workspaceId, action, { create = false, claim = false } = {}) {
    let context, begun = false;
    try {
      context = connect(workspaceId, create);
      if (!context) return action(null, null, hostEpoch);
      context.db.exec(claim ? 'BEGIN IMMEDIATE' : 'BEGIN'); begun = true;
      const epoch = owner(context, claim), manifest = load(context, epoch), result = action(context, manifest, epoch);
      context.db.exec('COMMIT'); begun = false; result?.afterCommit?.();
      if (result && typeof result === 'object' && 'afterCommit' in result) { const { afterCommit: _after, ...value } = result; return value; }
      return result;
    } catch (error) { if (begun) try { context.db.exec('ROLLBACK'); } catch {} return fail(codeOf(error)); }
  }
  function collect(context, manifest) {
    const used = new Set(manifest.drafts.flatMap(d => [d.baseBlob, d.textBlob]));
    for (const row of context.db.prepare('SELECT baseBlob,proposedBlob FROM operation_bodies').all()) { used.add(row.baseBlob); used.add(row.proposedBlob); }
    for (const row of context.db.prepare('SELECT blob FROM delivery_snapshots WHERE blob IS NOT NULL').all()) used.add(row.blob);
    let removed = 0;
    for (const row of context.db.prepare('SELECT digest,bytes FROM blobs').all()) if (!used.has(row.digest)) { context.db.prepare('DELETE FROM blobs WHERE digest=?').run(row.digest); removed += Number(row.bytes); }
    return removed;
  }
  function snapshots(context, manifest) {
    const retained = new Set(context.db.prepare('SELECT requestId FROM operation_bodies').all().map(row => row.requestId));
    const rows = allOperations(manifest).filter(op => op.phase === 'settled' && op.receipt?.outcome === 'applied').flatMap(op => ['before', 'after'].map(purpose => ({
      id: `snapshot-${digest(`${op.requestId}:${purpose}`).slice(7)}`, target: op.target, version: purpose === 'before' ? op.target.base.contentVersion : op.proposedVersion,
      purpose, availability: retained.has(op.requestId) ? 'retained' : 'cleaned', operationId: op.requestId, evidenceRef: op.receipt.evidenceRef, toolCallId: op.receipt.toolCallId, createdAt: op.updatedAt,
    })));
    rows.push(...context.db.prepare('SELECT value FROM delivery_snapshots').all().map(row => normalizeResourceTextSnapshot(JSON.parse(row.value))));
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  const executions = createResourceEditExecutionStorage({ transaction, readBlob });
  return {
    ...executions,
    /** Metadata only. Reading an index never hydrates every saved text. */
    inspect(workspaceId) {
      return transaction(workspaceId, (context, manifest, epoch) => ({ ok: true, manifest: clone(manifest ?? { schemaVersion: 1, workspaceId, revision: 0, drafts: [], operations: [], retiredOperations: [] }), hostOwnedHere: !!context && !!context.db.prepare('SELECT 1 FROM host_owner WHERE id=1 AND pid=? AND epoch=?').get(process.pid, hostEpoch) }));
    },
    readDraft(workspaceId, id) {
      return transaction(workspaceId, (context, manifest) => {
        const meta = manifest?.drafts.find(d => d.id === id); return meta ? { ok: true, draft: hydrate(context, meta), manifestRevision: manifest.revision } : fail('RESOURCE_EDIT_DRAFT_MISSING');
      });
    },
    /** Host-only command. UI facts and real sender must be checked by the owning application Module. */
    apply(workspaceId, event, { manifestRevision } = {}) {
      return transaction(workspaceId, (context, manifest) => {
        if (!event || typeof event.type !== 'string') return fail('RESOURCE_EDIT_INVALID_REQUEST');
        if (manifestRevision !== undefined && manifestRevision !== manifest.revision) return fail('RESOURCE_EDIT_MANIFEST_CONFLICT');
        const target = event.type === 'open' ? normalizeResourceEditTarget(event.target) : null;
        const selected = event.type === 'open' ? manifest.drafts.find(d => d.id === event.id || target && equal(d.target, target)) : manifest.drafts.find(d => d.id === event.draftId);
        if (event.type === 'open' && !selected && manifest.drafts.length >= 16) return fail('RESOURCE_EDIT_DRAFT_LIMIT');
        const draft = selected ? hydrate(context, selected) : null;
        const state = { ...emptyResourceEditState(workspaceId, hostEpoch), revision: manifest.revision, drafts: draft ? [draft] : [], operations: manifest.operations,
          retiredOperations: manifest.retiredOperations, writers: context.writers.filter(w => manifest.drafts.some(d => d.id === w.draftId)), writerSequence: context.writerSequence };
        const result = reduceResourceEdit(state, event, ports); if (!result.ok) return result;
        let next = manifest;
        if (result.persist) {
          next = { schemaVersion: 1, workspaceId, revision: result.state.revision, drafts: [...manifest.drafts.filter(d => d.id !== selected?.id), ...result.state.drafts.map(encodeDraft)], operations: result.state.operations, retiredOperations: result.state.retiredOperations };
          if (event.type === 'reserve' && !manifest.operations.some(op => op.requestId === event.requestId)) {
            const op = result.value.operation;
            context.db.prepare('INSERT INTO operation_bodies VALUES(?,?,?)').run(op.requestId, op.target.base.contentVersion, op.proposedVersion);
          }
          if (event.type === 'archive') context.db.prepare('DELETE FROM operation_bodies WHERE requestId=?').run(event.requestId);
          // Superseded autosave bytes are not history. Preserve every current/operation reference.
          // The transaction restores old blobs and manifest together if any later step fails.
          collect(context, next);
          for (const item of result.state.drafts) { putBlob(context, item.baseText); putBlob(context, item.text); }
          writeManifest(context, next);
        }
        return { ok: true, ...clone(result.value), manifestRevision: next.revision, changed: result.persist, saved: true,
          afterCommit: () => { context.writers = result.state.writers; context.writerSequence = result.state.writerSequence; } };
      }, { create: true, claim: true });
    },
    operationText(workspaceId, requestId) {
      return transaction(workspaceId, (context, manifest) => {
        const op = manifest && allOperations(manifest).find(op => op.requestId === requestId); if (!op) return fail('RESOURCE_EDIT_OPERATION_MISSING');
        const bodies = context.db.prepare('SELECT baseBlob,proposedBlob FROM operation_bodies WHERE requestId=?').get(requestId);
        return bodies ? { ok: true, operation: clone(op), baseText: readBlob(context, bodies.baseBlob), text: readBlob(context, bodies.proposedBlob) } : fail('RESOURCE_EDIT_BODY_CLEANED');
      });
    },
    cleanup(workspaceId, requestIds = []) {
      return transaction(workspaceId, (context, manifest) => {
        if (!Array.isArray(requestIds) || requestIds.length > 64 || requestIds.some(id => !resourceEditToken(id))) return fail('RESOURCE_EDIT_INVALID_REQUEST');
        if (!context) return requestIds.length ? fail('RESOURCE_EDIT_OPERATION_MISSING') : { ok: true, removedBytes: 0 };
        const operations = allOperations(manifest);
        if (requestIds.some(id => !operations.some(op => op.requestId === id && op.phase === 'settled'))) return fail('RESOURCE_EDIT_OPERATION_PENDING');
        for (const id of requestIds) context.db.prepare('DELETE FROM operation_bodies WHERE requestId=?').run(id);
        const removedBytes = collect(context, manifest); return { ok: true, removedBytes };
      }, { claim: true });
    },
    listSnapshots(workspaceId, { cursor, limit = 32 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 || cursor !== undefined && !resourceEditToken(cursor)) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      return transaction(workspaceId, (context, manifest) => {
        const rows = context ? snapshots(context, manifest) : [], offset = cursor === undefined ? 0 : rows.findIndex(row => row.id === cursor) + 1;
        if (cursor !== undefined && !offset) return fail('RESOURCE_EDIT_CURSOR_EXPIRED');
        const items = rows.slice(offset, offset + limit);
        return { ok: true, items: clone(items), total: rows.length, nextCursor: offset + items.length < rows.length ? items.at(-1).id : null };
      });
    },
    snapshotInfo(workspaceId, id) {
      return transaction(workspaceId, (context, manifest) => {
        const snapshot = context && snapshots(context, manifest).find(row => row.id === id);
        return snapshot ? { ok: true, snapshot: clone(snapshot) } : fail('RESOURCE_EDIT_SNAPSHOT_MISSING');
      });
    },
    readSnapshot(workspaceId, id) {
      return transaction(workspaceId, (context, manifest) => {
        const snapshot = context && snapshots(context, manifest).find(row => row.id === id);
        if (!snapshot) return fail('RESOURCE_EDIT_SNAPSHOT_MISSING');
        return snapshot.availability === 'retained' ? { ok: true, snapshot: clone(snapshot), content: readBlob(context, snapshot.version) } : { ...fail('RESOURCE_EDIT_BODY_CLEANED'), snapshot: clone(snapshot) };
      });
    },
    /** Host-only actual delivery binding + governed read receipt; never exposed as an arbitrary UI write. */
    retainDelivery(workspaceId, raw, content) {
      const snapshot = normalizeResourceTextSnapshot(raw);
      if (!snapshot || snapshot.purpose !== 'delivery' || snapshot.availability !== 'retained' || snapshot.target.recipient.workspaceId !== workspaceId
        || !validResourceEditText(content) || digest(content) !== snapshot.version) return fail('RESOURCE_EDIT_INVALID_SNAPSHOT');
      return transaction(workspaceId, (context, manifest) => {
        const rows = context.db.prepare('SELECT id,value FROM delivery_snapshots').all();
        const same = rows.find(row => { const value = JSON.parse(row.value); return value.availability === 'retained' && value.evidenceRef === snapshot.evidenceRef && value.artifactRef === snapshot.artifactRef && value.version === snapshot.version && equal(value.target, snapshot.target); });
        const existing = rows.find(row => row.id === snapshot.id);
        if (existing && !equal(JSON.parse(existing.value), snapshot)) return fail('RESOURCE_EDIT_ID_CONFLICT');
        if (same) return { ok: true, snapshot: JSON.parse(same.value) };
        const value = JSON.stringify(snapshot);
        if (rows.length >= 1024) return fail('RESOURCE_EDIT_HISTORY_LIMIT');
        if (rows.filter(row => JSON.parse(row.value).availability === 'retained').length >= 32 || rows.reduce((n, row) => n + bytes(row.value), bytes(value)) > MANIFEST_BYTES) return fail('RESOURCE_EDIT_SNAPSHOT_LIMIT');
        collect(context, manifest); putBlob(context, content);
        context.db.prepare('INSERT INTO delivery_snapshots VALUES(?,?,?)').run(snapshot.id, value, snapshot.version);
        // Establish a non-empty manifest in the same transaction as the first retained version.
        if (!context.db.prepare('SELECT 1 FROM manifest WHERE id=1').get()) writeManifest(context, manifest);
        return { ok: true, snapshot: clone(snapshot) };
      }, { create: true, claim: true });
    },
    clearDelivery(workspaceId, id) {
      return transaction(workspaceId, (context, manifest) => {
        const row = context?.db.prepare('SELECT value FROM delivery_snapshots WHERE id=?').get(id);
        if (!row) return fail('RESOURCE_EDIT_SNAPSHOT_MISSING');
        const snapshot = { ...JSON.parse(row.value), availability: 'cleaned' };
        context.db.prepare('UPDATE delivery_snapshots SET value=?,blob=NULL WHERE id=?').run(JSON.stringify(snapshot), id);
        return { ok: true, snapshot, removedBytes: collect(context, manifest) };
      }, { claim: true });
    },
    releaseView(workspaceId, identity) {
      const context = contexts.get(workspaceId); if (!context) return;
      context.writers = context.writers.filter(item => !['viewId', 'windowId', 'generation'].every(key => item.writer[key] === identity?.[key]));
      if (!context.writers.length) transaction(workspaceId, (current, manifest) => {
        if (!manifest.operations.some(op => op.phase !== 'settled')) current.db.prepare('DELETE FROM host_owner WHERE id=1 AND pid=? AND epoch=?').run(process.pid, hostEpoch);
        return { ok: true };
      }, { claim: true });
    },
    close() {
      disposed = true; activeEpochs.delete(hostEpoch);
      for (const context of contexts.values()) {
        try { context.db.prepare('DELETE FROM host_owner WHERE id=1 AND pid=? AND epoch=?').run(process.pid, hostEpoch); } catch {}
        try { context.db.close(); } catch {} context.writers = [];
      }
      contexts.clear();
    },
  };
}
