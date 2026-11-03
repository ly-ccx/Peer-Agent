import { interactiveDigest, interactiveToken, normalizeInteractiveOwner } from '@peer-agent/protocol';
import { decode, encode, jsonDigest, problem } from './storage.mjs';
import { materialKey, readMaterialRecord, RETIRED_MATERIAL } from './material-record.mjs';

const LIMIT = 256;
function target(raw) {
  const owner = normalizeInteractiveOwner(raw?.owner), source = raw?.source;
  const id = materialKey(source);
  if (!owner || !id || !interactiveDigest(source.expectedContentVersion)) throw problem('material_snapshot_unavailable');
  return { owner, source: structuredClone(source), id };
}

export function createMaterialRetention({ resultStore, current, roots, now, onStep }) {
  const { storage } = resultStore;
  function read(context, selection) {
    const row = context?.db.prepare('SELECT owner,object,metadata FROM materials WHERE id=?').get(selection.id);
    const record = readMaterialRecord(row, selection.owner, selection.source);
    if (!record) throw problem('material_snapshot_unavailable');
    return { row, ...record };
  }
  function guarded(selection, work) {
    return roots(selection.owner, (retention, assertRetention, heldMaterialResponsibility) => {
      if (typeof heldMaterialResponsibility !== 'function') throw problem('interactive_retention_unavailable');
      const material = heldMaterialResponsibility({ owner: structuredClone(selection.owner), source: structuredClone(selection.source) });
      try {
        if (!material || material.then || !interactiveDigest(material.digest) || typeof material.blocked !== 'boolean'
          || typeof material.assertCurrent !== 'function' || typeof material.release !== 'function') throw problem('interactive_retention_unavailable');
        const assertCurrent = () => {
          assertRetention();
          if (material.assertCurrent() !== true) throw problem('interactive_retention_stale');
        };
        assertCurrent();
        return work({ retention, materialDigest: material.digest, blocked: material.blocked }, assertCurrent);
      } finally {
        if (material?.then) Promise.resolve(material).then(value => { try { value?.release?.(); } catch {} }, () => {});
        else material?.release?.();
      }
    });
  }
  function inspect(context, selection, record, guards, assertCurrent) {
    assertCurrent();
    const { owner, source } = selection, ownerKey = encode(owner), sourceKey = encode(source);
    const blockers = new Set(guards.blocked ? ['source'] : []);
    storage.readObject(context, record.row.object);
    const versions = context.db.prepare("SELECT id,version,metadata FROM versions WHERE owner=? AND availability='available' ORDER BY id,version").all(ownerKey);
    for (const row of versions) {
      const reference = decode(row.metadata)?.reference;
      if (reference?.resultId !== row.id || reference.contentVersion !== row.version || encode(reference.owner) !== ownerKey)
        throw problem('interactive_storage_corrupt');
      const { provenance } = resultStore.getVersion(reference, { allowPending: true });
      for (const entry of provenance) {
        const candidate = entry?.source;
        if (!candidate || (candidate.kind !== 'model-data' && (!materialKey(candidate) || !interactiveDigest(candidate.expectedContentVersion))))
          throw problem('interactive_storage_corrupt');
        if (encode(candidate) === sourceKey) blockers.add('published-version');
      }
    }
    const attempts = context.db.prepare('SELECT body FROM attempts ORDER BY id').all();
    for (const row of attempts) {
      const attempt = decode(row.body), attemptOwner = normalizeInteractiveOwner(attempt?.callRef?.owner);
      if (!attemptOwner || !['prepared', 'failed', 'committed'].includes(attempt.phase)) throw problem('interactive_storage_corrupt');
      if (encode(attemptOwner) === ownerKey && attempt.phase === 'prepared') blockers.add('publication');
    }
    const pending = context.db.prepare("SELECT id FROM operations WHERE owner=? AND phase='index_pending' ORDER BY id").all(ownerKey);
    if (pending.length) blockers.add('publication');
    const ordered = [...blockers].sort();
    const cleanupDigest = jsonDigest({ selection, row: record.row, guards, versions, attempts, pending, blockers: ordered });
    assertCurrent();
    return { owner, source, cleanupDigest, blockers: ordered };
  }
  function previewMaterial(raw) {
    const selection = target(raw);
    return guarded(selection, (guards, assertCurrent) => {
      const context = storage.connect(selection.owner.workspaceId);
      if (!context) throw problem('material_snapshot_unavailable');
      context.db.exec('BEGIN');
      try {
        const record = read(context, selection);
        if (record.retired) throw problem('material_snapshot_cleaned');
        const preview = inspect(context, selection, record, guards, assertCurrent);
        context.assertFile(); context.db.exec('COMMIT'); return preview;
      } catch (error) { try { context.db.exec('ROLLBACK'); } catch {} throw error; }
    });
  }
  function readMaterialReceipt(raw) {
    const selection = target(raw);
    current(selection.owner);
    const record = read(storage.connect(selection.owner.workspaceId), selection);
    current(selection.owner);
    return record.retired ?? null;
  }
  function cleanupMaterial(raw) {
    const selection = target(raw), { owner, source, id } = selection, { expectedDigest, requestId } = raw;
    if (!interactiveDigest(expectedDigest) || !interactiveToken(requestId)) throw problem('interactive_cleanup_invalid');
    const sameRequest = receipt => {
      if (receipt.requestId !== requestId || receipt.expectedDigest !== expectedDigest) throw problem('interactive_cleanup_parameter_conflict');
      return receipt;
    };
    const previous = readMaterialReceipt(selection);
    if (previous) return sameRequest(previous);
    return guarded(selection, (guards, assertCurrent) => storage.transaction(owner.workspaceId, context => {
      const record = read(context, selection);
      if (record.retired) return sameRequest(record.retired);
      const preview = inspect(context, selection, record, guards, assertCurrent);
      if (preview.cleanupDigest !== expectedDigest) throw problem('interactive_retention_stale');
      if (preview.blockers.length) throw problem('interactive_cleanup_blocked');
      if (Number(context.db.prepare("SELECT COUNT(*) AS n FROM materials WHERE owner=? AND object=''").get(encode(owner)).n) >= LIMIT)
        throw problem('interactive_cleanup_limit');
      const body = { schemaVersion: 1, kind: RETIRED_MATERIAL, owner, source, contentVersion: source.expectedContentVersion,
        requestId, expectedDigest, cleanedAt: now() };
      if (!Number.isFinite(Date.parse(body.cleanedAt))) throw problem('interactive_cleanup_invalid');
      const receipt = { ...body, receiptDigest: jsonDigest(body) }, hash = record.row.object;
      context.db.prepare("UPDATE materials SET object='',metadata=? WHERE id=? AND owner=?").run(encode(receipt), id, encode(owner));
      if (!context.db.prepare("SELECT 1 FROM versions WHERE object=? AND availability='available' LIMIT 1").get(hash)
        && !context.db.prepare('SELECT 1 FROM materials WHERE object=? LIMIT 1').get(hash))
        context.db.prepare('DELETE FROM objects WHERE hash=?').run(hash);
      onStep('material_cleanup_before_commit'); assertCurrent();
      return receipt;
    }));
  }
  return { previewMaterial, cleanupMaterial, readMaterialReceipt };
}
