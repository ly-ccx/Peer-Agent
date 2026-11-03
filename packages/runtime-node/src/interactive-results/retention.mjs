import { interactiveDigest, interactiveToken, normalizeInteractiveOwner, normalizeInteractiveReference } from '@peer-agent/protocol';
import { decode, encode, jsonDigest, problem } from './storage.mjs';
import { checkedInteractiveSnapshot } from './state-record.mjs';
import { interactiveProcessAlive, readLiveInteractiveViewPins } from './view-pins.mjs';

export const INTERACTIVE_RETENTION_SOURCES = Object.freeze(['views', 'drafts', 'inputs', 'messages', 'delegation', 'verification']);
const CATEGORY = 'interactive-cleanup', TOMBSTONE_LIMIT = 256;
const same = (a, b) => encode(a) === encode(b);
const copy = value => structuredClone(value);
const known = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => fields.includes(key));
const count = value => Number.isSafeInteger(value) && value >= 0;
const synchronous = fn => typeof fn === 'function' && fn.constructor?.name !== 'AsyncFunction';
function reference(raw) { const result = normalizeInteractiveReference(raw); if (!result) throw problem('interactive_reference_invalid'); return result; }

/** Internal maintenance only. No public delete port exists until every root store is guarded. */
export function createInteractiveRetention({ resultStore, stateStore, assertOwner, acquireRoots, now = () => new Date().toISOString(), onStep = () => {} }) {
  const storage = resultStore.storage;
  function current(owner) {
    if (typeof assertOwner !== 'function' || assertOwner(owner) !== true) throw problem('interactive_scope_denied');
  }
  function roots(owner, work) {
    current(owner);
    if (!synchronous(acquireRoots)) throw problem('interactive_retention_unavailable');
    const guard = acquireRoots(copy(owner));
    try {
      if (guard?.then) Promise.resolve(guard).then(value => { try { value?.release?.(); } catch {} }, () => {});
      if (!guard || guard.then || !known(guard, ['sources', 'pins', 'followupIds', 'assertCurrent', 'release'])
        || !known(guard.sources, INTERACTIVE_RETENTION_SOURCES) || Object.keys(guard.sources).length !== INTERACTIVE_RETENTION_SOURCES.length
        || Object.values(guard.sources).some(value => !interactiveDigest(value)) || !synchronous(guard.assertCurrent) || !synchronous(guard.release)
        || !Array.isArray(guard.pins) || guard.pins.length > 16_384 || !Array.isArray(guard.followupIds) || guard.followupIds.length > 16_384)
        throw problem('interactive_retention_unavailable');
      const pins = guard.pins.map(pin => {
        const ref = normalizeInteractiveReference(pin?.reference);
        if (!known(pin, ['source', 'reference']) || !INTERACTIVE_RETENTION_SOURCES.includes(pin.source) || !ref || !same(ref.owner, owner))
          throw problem('interactive_retention_unavailable');
        return { source: pin.source, reference: ref };
      });
      if (guard.followupIds.some(id => !interactiveToken(id)) || new Set(guard.followupIds).size !== guard.followupIds.length)
        throw problem('interactive_retention_unavailable');
      const followupIds = [...guard.followupIds].sort();
      const assertCurrent = () => { current(owner); if (guard.assertCurrent() !== true) throw problem('interactive_retention_stale'); return true; };
      assertCurrent();
      const normalized = { sources: guard.sources, pins: pins.sort((a, b) => encode(a).localeCompare(encode(b))), followupIds };
      const result = work(normalized, assertCurrent);
      if (result?.then) throw problem('interactive_retention_unavailable');
      assertCurrent(); return result;
    } finally { if (typeof guard?.release === 'function') guard.release(); }
  }
  function metadata(context, row, owner, resultId) {
    const meta = decode(row.metadata), ref = normalizeInteractiveReference(meta.reference);
    if (!ref || !same(ref.owner, owner) || ref.resultId !== resultId || row.id !== resultId || row.version !== ref.contentVersion
      || row.owner !== encode(owner) || !['available', 'cleaned'].includes(row.availability)) throw problem('interactive_storage_corrupt');
    const original = resultStore.getOperation({ owner, conversationId: meta.source?.conversationId, toolCallId: meta.source?.toolCallId });
    if (!original || original.unchanged || !same(original.reference, ref) || !same(original.metadata, meta)
      || !['published', 'index_pending'].includes(original.publicationStatus)) throw problem('interactive_storage_corrupt');
    return { meta, original };
  }
  function savedReceipt(context, ref) {
    const row = context?.db.prepare('SELECT body FROM presentation WHERE category=? AND id=? AND owner=?').get(CATEGORY, ref.resultId, encode(ref.owner));
    if (!row) return null;
    const value = decode(row.body), headRef = normalizeInteractiveReference(value.reference);
    if (!known(value, ['schemaVersion', 'reference', 'requestId', 'expectedDigest', 'cleanedAt', 'versions', 'stateRowsRemoved', 'saveRowsRemoved', 'objectBytesRemoved', 'receiptDigest'])
      || value.schemaVersion !== 1 || !headRef || !same(headRef.owner, ref.owner) || headRef.resultId !== ref.resultId
      || !interactiveToken(value.requestId) || !interactiveDigest(value.expectedDigest)
      || !Number.isFinite(Date.parse(value.cleanedAt)) || !Array.isArray(value.versions) || !value.versions.length
      || !['stateRowsRemoved', 'saveRowsRemoved', 'objectBytesRemoved'].every(key => count(value[key]))) throw problem('interactive_cleanup_corrupt');
    const { receiptDigest, ...body } = value;
    if (!interactiveDigest(receiptDigest) || jsonDigest(body) !== receiptDigest) throw problem('interactive_cleanup_corrupt');
    const seen = new Set();
    for (const version of value.versions) {
      const target = normalizeInteractiveReference(version?.reference);
      if (!known(version, ['reference', 'source', 'dataLevel', 'title', 'textFallback', 'truncated']) || !target || !same(target.owner, ref.owner) || target.resultId !== ref.resultId
        || seen.has(target.contentVersion) || typeof version.title !== 'string' || version.title.length > 160
        || typeof version.textFallback !== 'string' || version.textFallback.length > 256 || typeof version.truncated !== 'boolean') throw problem('interactive_cleanup_corrupt');
      const record = context.db.prepare('SELECT * FROM versions WHERE id=? AND version=?').get(ref.resultId, target.contentVersion);
      if (!record || record.availability !== 'cleaned') throw problem('interactive_cleanup_corrupt');
      const { meta } = metadata(context, record, ref.owner, ref.resultId);
      if (!same(version.source, meta.source) || version.dataLevel !== meta.dataLevel) throw problem('interactive_cleanup_corrupt');
      seen.add(target.contentVersion);
    }
    const actual = context.db.prepare('SELECT COUNT(*) AS n FROM versions WHERE id=? AND owner=?').get(ref.resultId, encode(ref.owner)).n;
    const head = context.db.prepare('SELECT owner,head FROM results WHERE id=?').get(ref.resultId);
    if (Number(actual) !== seen.size || !seen.has(ref.contentVersion) || !seen.has(headRef.contentVersion)
      || !head || head.owner !== encode(ref.owner) || head.head !== headRef.contentVersion) throw problem('interactive_cleanup_corrupt');
    return copy(value);
  }
  function readReceipt(raw) {
    const ref = reference(raw); current(ref.owner);
    const context = storage.connect(ref.owner.workspaceId);
    const value = savedReceipt(context, ref); current(ref.owner); return value;
  }
  function inspect(context, ref, snapshot, assertCurrent) {
    assertCurrent();
    const head = context.db.prepare('SELECT owner,head FROM results WHERE id=?').get(ref.resultId);
    if (!head || head.owner !== encode(ref.owner)) throw problem('interactive_result_unavailable');
    if (head.head !== ref.contentVersion) throw problem('version_conflict');
    const rows = context.db.prepare('SELECT * FROM versions WHERE id=? ORDER BY version').all(ref.resultId);
    if (!rows.length) throw problem('interactive_result_unavailable');
    const reasons = new Map(), block = source => reasons.set(source, (reasons.get(source) ?? 0) + 1);
    const summaries = [], objects = new Set();
    for (const row of rows) {
      const { meta, original } = metadata(context, row, ref.owner, ref.resultId);
      if (row.availability === 'cleaned') throw problem('interactive_cleanup_corrupt');
      if (original.publicationStatus !== 'published') block('publication');
      const fixed = resultStore.getVersion(meta.reference, { allowPending: true });
      const state = context.db.prepare('SELECT snapshot FROM states WHERE id=? AND version=?').get(ref.resultId, row.version);
      if (state) checkedInteractiveSnapshot(decode(state.snapshot), meta.reference, fixed);
      for (const saved of context.db.prepare('SELECT * FROM saves WHERE id=? AND version=?').all(ref.resultId, row.version)) {
        const snapshot = checkedInteractiveSnapshot(decode(saved.receipt), meta.reference, fixed);
        if (!interactiveDigest(saved.argsDigest) || saved.requestId !== snapshot.requestId || snapshot.stateRevision < 1) throw problem('interactive_storage_corrupt');
      }
      summaries.push({ reference: meta.reference, source: meta.source, dataLevel: meta.dataLevel, title: fixed.content.title, textFallback: fixed.content.textFallback.slice(0, 256),
        truncated: fixed.content.textFallback.length > 256 });
      objects.add(row.object);
    }
    const states = context.db.prepare('SELECT * FROM states WHERE id=? ORDER BY version').all(ref.resultId);
    const saves = context.db.prepare('SELECT * FROM saves WHERE id=? ORDER BY version,requestId').all(ref.resultId);
    if (saves.some(row => !rows.some(version => version.version === row.version))) throw problem('interactive_storage_corrupt');
    for (const row of states) {
      if (!rows.some(version => version.version === row.version)) throw problem('interactive_storage_corrupt');
      if (row.writer) {
        const writer = decode(row.writer);
        if (!Number.isSafeInteger(writer.pid) || writer.pid <= 0 || !['token', 'hostEpoch', 'viewId', 'windowId', 'viewGeneration', 'generation'].every(key => interactiveToken(writer[key])))
          throw problem('interactive_storage_corrupt');
        if (interactiveProcessAlive(writer.pid)) block('writer');
      }
    }
    const attempts = context.db.prepare('SELECT id,body FROM attempts ORDER BY id').all();
    for (const row of attempts) {
      const attempt = decode(row.body), owner = normalizeInteractiveOwner(attempt.callRef?.owner);
      if (!owner || !['prepared', 'failed', 'committed'].includes(attempt.phase)) throw problem('interactive_storage_corrupt');
      if (same(owner, ref.owner) && attempt.phase === 'prepared') block('publication');
    }
    const operations = context.db.prepare('SELECT id,phase,receipt FROM operations WHERE owner=? ORDER BY id').all(encode(ref.owner));
    for (const row of operations) {
      const operation = decode(row.receipt), target = normalizeInteractiveReference(operation.reference);
      if (!target || !same(target.owner, ref.owner) || !['published', 'index_pending'].includes(row.phase)) throw problem('interactive_storage_corrupt');
      if (row.phase === 'index_pending') block('publication');
    }
    const activeViews = readLiveInteractiveViewPins(context, ref.owner);
    for (const pin of activeViews) if (pin.reference.resultId === ref.resultId) block('views');
    for (const pin of snapshot.pins) if (pin.reference.resultId === ref.resultId) block(pin.source);
    for (const id of snapshot.followupIds) {
      if (!stateStore) throw problem('interactive_retention_unavailable');
      const followup = stateStore.readFollowup(ref.owner, id);
      if (followup.result.resultId === ref.resultId) block('followup');
    }
    const removable = [...objects].filter(hash => !context.db.prepare("SELECT 1 FROM versions WHERE object=? AND id<>? AND availability='available' LIMIT 1").get(hash, ref.resultId)
      && !context.db.prepare('SELECT 1 FROM materials WHERE object=? LIMIT 1').get(hash));
    const objectBytes = removable.reduce((sum, hash) => {
      const object = context.db.prepare('SELECT bytes FROM objects WHERE hash=?').get(hash);
      if (!object || !count(Number(object.bytes))) throw problem('interactive_storage_corrupt');
      return sum + Number(object.bytes);
    }, 0);
    const digest = jsonDigest({ reference: ref, rows, states, saves, attempts, operations, activeViews, removable, roots: snapshot });
    assertCurrent();
    return { preview: { reference: ref, cleanupDigest: digest, versionCount: rows.length, stateCount: states.length, saveCount: saves.length,
      objectBytes, blockers: [...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([source, count]) => ({ source, count })) }, summaries, removable };
  }
  function preview(raw) {
    const ref = reference(raw);
    return roots(ref.owner, (snapshot, assertCurrent) => {
      const context = storage.connect(ref.owner.workspaceId);
      if (!context) throw problem('interactive_result_unavailable');
      context.db.exec('BEGIN');
      try { const result = inspect(context, ref, snapshot, assertCurrent).preview; context.assertFile(); context.db.exec('COMMIT'); return copy(result); }
      catch (error) { try { context.db.exec('ROLLBACK'); } catch {} throw error; }
    });
  }
  function cleanup({ reference: raw, expectedDigest, requestId }) {
    const ref = reference(raw); current(ref.owner);
    if (!interactiveToken(requestId) || !interactiveDigest(expectedDigest)) throw problem('interactive_cleanup_invalid');
    const existing = readReceipt(ref);
    if (existing) {
      if (!same(existing.reference, ref) || existing.requestId !== requestId || existing.expectedDigest !== expectedDigest) throw problem('interactive_cleanup_parameter_conflict');
      return existing;
    }
    if (!storage.connect(ref.owner.workspaceId)) throw problem('interactive_result_unavailable');
    const receipt = roots(ref.owner, (snapshot, assertCurrent) => storage.transaction(ref.owner.workspaceId, context => {
      assertCurrent();
      const previous = savedReceipt(context, ref);
      if (previous) {
        if (!same(previous.reference, ref) || previous.requestId !== requestId || previous.expectedDigest !== expectedDigest) throw problem('interactive_cleanup_parameter_conflict');
        return previous;
      }
      const { preview, summaries, removable } = inspect(context, ref, snapshot, assertCurrent);
      if (preview.cleanupDigest !== expectedDigest) throw problem('interactive_retention_stale');
      if (preview.blockers.length) throw problem('interactive_cleanup_blocked');
      if (Number(context.db.prepare('SELECT COUNT(*) AS n FROM presentation WHERE category=? AND owner=?').get(CATEGORY, encode(ref.owner)).n) >= TOMBSTONE_LIMIT)
        throw problem('interactive_cleanup_limit');
      const body = { schemaVersion: 1, reference: ref, requestId, expectedDigest, cleanedAt: now(), versions: summaries,
        stateRowsRemoved: preview.stateCount, saveRowsRemoved: preview.saveCount, objectBytesRemoved: preview.objectBytes };
      if (!Number.isFinite(Date.parse(body.cleanedAt))) throw problem('interactive_cleanup_invalid');
      const value = { ...body, receiptDigest: jsonDigest(body) };
      context.db.prepare("UPDATE versions SET availability='cleaned' WHERE id=? AND owner=?").run(ref.resultId, encode(ref.owner));
      context.db.prepare('INSERT INTO presentation VALUES(?,?,?,?)').run(CATEGORY, ref.resultId, encode(ref.owner), encode(value));
      context.db.prepare('DELETE FROM states WHERE id=?').run(ref.resultId);
      context.db.prepare('DELETE FROM saves WHERE id=?').run(ref.resultId);
      onStep('cleanup_retired'); assertCurrent();
      for (const hash of removable) context.db.prepare('DELETE FROM objects WHERE hash=?').run(hash);
      onStep('cleanup_before_commit'); assertCurrent();
      return copy(value);
    }));
    onStep('cleanup_committed'); return receipt;
  }
  return { preview, cleanup, readReceipt };
}
