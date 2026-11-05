import { randomUUID } from 'node:crypto';
import { INTERACTIVE_PUBLISH_CAPABILITY, INTERACTIVE_RESULT_LIMITS as L, interactiveArtifactRef, interactiveDigest, interactiveToken, normalizeInteractiveOwner, normalizeInteractiveReference, normalizeInteractivePublicationReference } from '@peer-agent/protocol';
import { pathOf } from '../data-store.mjs';
import { createInteractiveStorage, decode, encode, jsonDigest, problem } from './storage.mjs';
import { materialKey, readMaterialRecord, validMaterialOrigin } from './material-record.mjs';
import { createPublicationAttempts } from './publication-attempts.mjs';
import { createOwnerPrivacy, maximumInteractiveDataLevel } from './owner-privacy.mjs';

const clone = value => structuredClone(value);
const same = (a, b) => encode(a) === encode(b);
const operationKey = ref => jsonDigest([ref.owner, ref.conversationId, ref.toolCallId]);
function requireOwner(raw) { const owner = normalizeInteractiveOwner(raw); if (!owner) throw problem('interactive_owner_invalid'); return owner; }
function requireReference(raw) { const ref = normalizeInteractiveReference(raw); if (!ref) throw problem('interactive_reference_invalid'); return ref; }
function requireCall(raw) { const ref = normalizeInteractivePublicationReference(raw); if (!ref) throw problem('interactive_call_invalid'); return ref; }
function requireCurrent(check) { if (typeof check !== 'function' || check() !== true) throw problem('interactive_execution_stale'); }
function storedContent(content) {
  if (content?.schemaVersion !== 1 || typeof content.program !== 'string' || !interactiveDigest(content.specHash) || !interactiveDigest(content.stateSchemaHash)) throw problem('interactive_content_invalid');
  const { tree: _cache, ...body } = content;
  return clone(body);
}
function contentDigest(body) {
  if (body.encoding !== 'peer-interactive-content-1' || !Array.isArray(body.provenance)) throw problem('interactive_content_corrupt');
  // Capture time belongs to the original immutable storage object, not to content
  // identity. An identical revision must not become new content just because it
  // was validated later. Real source observation/version/classification stay pinned.
  const provenance = body.provenance.map(({ capturedAt: _captured, ...record }) => {
    if (record.source.kind === 'model-data') { const { observedAt: _constructed, ...stable } = record; return stable; }
    return record;
  });
  return jsonDigest({ encoding: body.encoding, content: body.content, provenance, dataLevel: body.dataLevel });
}

/** Immutable publication identity and operation/outbox truth; no execution or UI permission authority.
 * @param {{rootDir?: string, now?: () => string, assertCompatibility?: (workspaceId: string) => boolean,
 * onStep?: (step: string) => void, maxBytes?: number, hostEpoch?: string}} [options]
 */
export function createInteractiveResultStore({ rootDir = pathOf('projectRuntime'), now = () => new Date().toISOString(),
  assertCompatibility, onStep = () => {}, maxBytes, hostEpoch } = {}) {
  const storage = createInteractiveStorage({ rootDir, assertCompatibility, maxBytes, hostEpoch });
  const attempts = createPublicationAttempts(storage);
  const privacy = createOwnerPrivacy(storage);
  function operation(context, call) {
    const row = context.db.prepare('SELECT * FROM operations WHERE id=?').get(operationKey(call));
    if (!row) return null;
    if (row.owner !== encode(call.owner) || row.conversation !== call.conversationId || row.toolCallId !== call.toolCallId) throw problem('interactive_operation_conflict');
    return { ...decode(row.receipt), publicationStatus: row.phase, argsDigest: row.argsDigest };
  }
  function versionRecord(context, ref, { allowPending = false } = {}, allowCleaned = false) {
    const row = context.db.prepare('SELECT * FROM versions WHERE id=? AND version=?').get(ref.resultId, ref.contentVersion);
    if (!row) throw problem('interactive_result_unavailable');
    if (row.owner !== encode(ref.owner)) throw problem('interactive_scope_denied');
    const metadata = decode(row.metadata);
    if (row.availability === 'cleaned' && !allowCleaned) throw problem('interactive_content_cleaned');
    if (!['available', 'cleaned'].includes(row.availability)) throw problem('interactive_storage_corrupt');
    if (!same(metadata.reference, ref)) throw problem('interactive_storage_corrupt');
    const status = context.db.prepare('SELECT phase FROM operations WHERE id=?').get(metadata.operationId)?.phase;
    if (!allowPending && status !== 'published') throw problem(status === 'index_pending' ? 'publication_index_pending' : 'publication_unknown');
    return { row, metadata, status };
  }
  function version(context, ref, options) {
    const { row, metadata, status } = versionRecord(context, ref, options);
    const body = storage.readObject(context, row.object);
    if (contentDigest(body) !== ref.contentVersion || metadata.dataLevel !== body.dataLevel) throw problem('interactive_content_corrupt');
    return { ...metadata, content: body.content, provenance: body.provenance, publicationStatus: status };
  }
  function getVersion(rawReference, options = {}) {
    const ref = requireReference(rawReference), context = storage.connect(ref.owner.workspaceId);
    if (!context) throw problem('interactive_result_unavailable');
    return clone(version(context, ref, options));
  }
  function getVersionMetadata(rawReference, { allowCleaned = false } = {}) {
    const ref = requireReference(rawReference), context = storage.connect(ref.owner.workspaceId);
    if (!context) throw problem('interactive_result_unavailable');
    const { metadata, status } = versionRecord(context, ref, undefined, allowCleaned);
    return clone({ ...metadata, publicationStatus: status });
  }
  function getOperation(rawCall) {
    const call = requireCall(rawCall), context = storage.connect(call.owner.workspaceId);
    return context ? clone(operation(context, call)) : null;
  }
  function reconcileStoppedPreparation(rawCall, assertStopped) {
    const callRef = requireCall(rawCall);
    if (!attempts.read(callRef)) return null;
    return storage.transaction(callRef.owner.workspaceId, context => {
      const saved = attempts.read(callRef, context);
      if (saved?.phase !== 'prepared' || operation(context, callRef) || assertStopped?.(saved) !== true) return null;
      return attempts.finishInTransaction(context, callRef, { code: 'publication_interrupted', status: 'cancelled' });
    });
  }
  /** @param {{owner: import('@peer-agent/protocol').InteractiveOwner, source: import('@peer-agent/protocol').InteractivePublishedResult['source'],
   * draft: import('@peer-agent/protocol').InteractiveResultDraft, content: import('@peer-agent/protocol').InteractiveContent,
   * provenance: readonly import('@peer-agent/protocol').InteractiveMaterialProvenance[], dataLevel: import('@peer-agent/protocol').DataLevel,
   * grant: {granted: boolean, toolCallId: string, grantId: string, scope?: import('@peer-agent/protocol').InteractivePublicationPermissionScope, policyRevision?: string},
   * evidenceId?: string, streamId?: string}} input
   * @param {() => boolean} assertCurrent */
  function commitPublication({ owner: rawOwner, source, draft, content, provenance, grant, dataLevel, evidenceId = randomUUID(), streamId }, assertCurrent) {
    const owner = requireOwner(rawOwner);
    if (!source || !['conversationId', 'planId', 'sessionId', 'toolCallId'].every(field => interactiveToken(source[field]))
      || typeof source.executionEpoch !== 'string' || !source.executionEpoch || source.executionEpoch.length > 512
      || !['D0_public', 'D1_internal', 'D2_sensitive', 'D3_private', 'D4_regulated'].includes(dataLevel)
      || grant?.granted !== true || grant.toolCallId !== source.toolCallId || !interactiveToken(grant.grantId)) throw problem('interactive_publication_authority_invalid');
    const callRef = requireCall({ owner, conversationId: source.conversationId, toolCallId: source.toolCallId });
    const argsDigest = jsonDigest(draft), id = operationKey(callRef);
    if (grant.scope?.kind === 'interactive-result' && (!same(grant.scope.owner, owner) || !same(grant.scope.source, source)
      || grant.scope.parameterDigest !== argsDigest || grant.scope.dataLevel !== dataLevel)) throw problem('interactive_publication_authority_invalid');
    const body = { encoding: 'peer-interactive-content-1', content: storedContent(content), provenance: clone(provenance), dataLevel };
    const contentVersion = contentDigest(body);
    requireCurrent(assertCurrent);
    const committed = storage.transaction(owner.workspaceId, context => {
      const previous = operation(context, callRef);
      if (previous) {
        if (previous.argsDigest !== argsDigest) throw problem('publication_parameter_conflict');
        return previous;
      }
      requireCurrent(assertCurrent);
      if (maximumInteractiveDataLevel(privacy.current(owner, dataLevel), dataLevel) !== dataLevel) throw problem('material_classification_changed');
      privacy.remember(context, owner, dataLevel);
      let resultId = randomUUID(), predecessor;
      if (draft.publication.kind === 'revise') {
        predecessor = requireReference(draft.publication.base);
        if (!same(predecessor.owner, owner)) throw problem('interactive_scope_denied');
        const base = version(context, predecessor);
        const head = context.db.prepare('SELECT owner,head FROM results WHERE id=?').get(predecessor.resultId);
        if (!head || head.owner !== encode(owner) || head.head !== predecessor.contentVersion) throw problem('version_conflict');
        resultId = predecessor.resultId;
        if (contentVersion === predecessor.contentVersion) {
          const unchanged = { reference: predecessor, callRef, argsDigest, unchanged: true, evidenceRef: base.evidenceRef, artifactRef: base.artifactRef };
          context.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)').run(id, encode(owner), source.conversationId, source.toolCallId, argsDigest, 'published', encode(unchanged));
          attempts.finishInTransaction(context, callRef);
          return { ...unchanged, publicationStatus: 'published' };
        }
      } else if (draft.publication.kind !== 'create') throw problem('invalid_publication_intent');
      const count = context.db.prepare(`SELECT COUNT(*) AS count FROM results r WHERE r.owner=? AND (
        NOT EXISTS (SELECT 1 FROM versions v WHERE v.id=r.id AND v.version=r.head AND v.owner=r.owner AND v.availability='cleaned')
        OR EXISTS (SELECT 1 FROM versions v WHERE v.id=r.id AND v.availability<>'cleaned'))`).get(encode(owner)).count;
      if (!predecessor && count >= L.resultsPerBot) throw problem('interactive_result_limit');
      const reference = { owner, resultId, contentVersion };
      // Model wire call IDs are not globally unique across worker conversations.
      // The existing opaque artifact ref is the canonical index key; bare tool-result
      // aliases can still be registered by the generic host without rebinding it.
      const artifactRef = interactiveArtifactRef(reference), evidenceRef = artifactRef;
      const createdAt = now();
      const metadata = { reference, source: clone(source), ...(predecessor ? { predecessor } : {}), evidenceRef, artifactRef, dataLevel, createdAt, operationId: id };
      const userArtifact = { kind: 'interactive', ref: artifactRef, label: content.title, reference, specHash: content.specHash };
      const indexEntry = { evidenceRef, planId: source.planId, conversationId: source.conversationId,
        ...(streamId ? { streamId } : {}), toolCallId: source.toolCallId, capabilityId: INTERACTIVE_PUBLISH_CAPABILITY,
        toolName: 'publish_interactive_result', createdAt, artifactRefs: [artifactRef], userArtifacts: [userArtifact] };
      const receipt = { reference, callRef, argsDigest, metadata, indexEntry, evidenceId,
        grantAudit: { grantId: grant.grantId, toolCallId: grant.toolCallId, ...(grant.policyRevision ? { policyRevision: grant.policyRevision } : {}) } };
      const object = storage.putObject(context, body);
      onStep('objects_written'); requireCurrent(assertCurrent);
      if (predecessor) {
        const changed = context.db.prepare('UPDATE results SET head=? WHERE id=? AND owner=? AND head=?').run(contentVersion, resultId, encode(owner), predecessor.contentVersion);
        if (Number(changed.changes) !== 1) throw problem('version_conflict');
      } else context.db.prepare('INSERT INTO results VALUES(?,?,?)').run(resultId, encode(owner), contentVersion);
      context.db.prepare('INSERT INTO versions(id,version,owner,object,metadata) VALUES(?,?,?,?,?)').run(resultId, contentVersion, encode(owner), object, encode(metadata));
      context.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)').run(id, encode(owner), source.conversationId, source.toolCallId, argsDigest, 'index_pending', encode(receipt));
      attempts.finishInTransaction(context, callRef);
      onStep('before_commit'); requireCurrent(assertCurrent);
      return { ...receipt, publicationStatus: 'index_pending' };
    });
    onStep('committed');
    return clone(committed);
  }
  function markIndexed(rawCall, actualIndexRecord, assertCurrent = () => true) {
    const callRef = requireCall(rawCall);
    return storage.transaction(callRef.owner.workspaceId, context => {
      requireCurrent(assertCurrent);
      const saved = operation(context, callRef);
      if (!saved) throw problem('publication_unknown');
      if (saved.unchanged) return saved;
      const expected = saved.indexEntry;
      if (!actualIndexRecord || ['evidenceRef', 'planId', 'conversationId', 'toolCallId', 'capabilityId', 'toolName', 'createdAt']
        .some(field => actualIndexRecord[field] !== expected[field]) || expected.streamId && actualIndexRecord.streamId !== expected.streamId
        || !actualIndexRecord.artifactRefs?.includes(saved.metadata.artifactRef)
        || !actualIndexRecord.userArtifacts?.some(artifact => artifact.kind === 'interactive' && artifact.ref === saved.metadata.artifactRef
          && same(artifact.reference, saved.reference) && artifact.specHash === saved.indexEntry.userArtifacts[0].specHash)) throw problem('publication_index_conflict');
      version(context, saved.reference, { allowPending: true });
      requireCurrent(assertCurrent);
      context.db.prepare("UPDATE operations SET phase='published' WHERE id=?").run(operationKey(callRef));
      return { ...saved, publicationStatus: 'published' };
    });
  }
  function listPending(rawOwner, limit = 32) {
    const owner = requireOwner(rawOwner), context = storage.connect(owner.workspaceId);
    if (!context) return [];
    return context.db.prepare("SELECT receipt FROM operations WHERE owner=? AND phase='index_pending' ORDER BY rowid LIMIT ?")
      .all(encode(owner), Math.min(32, Math.max(1, limit))).map(row => clone(decode(row.receipt)));
  }
  function head(rawReference) {
    const ref = requireReference(rawReference), context = storage.connect(ref.owner.workspaceId);
    const row = context?.db.prepare('SELECT head,owner FROM results WHERE id=?').get(ref.resultId);
    if (!row || row.owner !== encode(ref.owner)) throw problem('interactive_result_unavailable');
    return { ...ref, contentVersion: row.head };
  }
  function readVersions(rawReference, assertCurrent) {
    const reference = requireReference(rawReference);
    requireCurrent(assertCurrent);
    const checkedMetadata = target => {
      const { publicationStatus: _status, ...metadata } = getVersionMetadata(target);
      const original = getOperation({ owner: target.owner, conversationId: metadata.source?.conversationId, toolCallId: metadata.source?.toolCallId });
      if (original?.publicationStatus !== 'published' || original.unchanged || !same(original.reference, target)
        || !same(original.metadata, metadata)) throw problem('interactive_storage_corrupt');
      return metadata;
    };
    const fixed = checkedMetadata(reference), latest = requireReference(head(reference));
    checkedMetadata(latest);
    const predecessor = fixed.predecessor && requireReference(fixed.predecessor);
    if (predecessor) {
      if (!same(predecessor.owner, reference.owner) || predecessor.resultId !== reference.resultId
        || same(predecessor, reference)) throw problem('interactive_storage_corrupt');
      checkedMetadata(predecessor);
    }
    requireCurrent(assertCurrent);
    return clone({ reference, head: latest, ...(predecessor ? { predecessor } : {}) });
  }
  function recordMaterial({ owner: rawOwner, source, value, dataLevel, observedAt, truncated, redacted, evidenceRefs, origin = undefined }, assertCurrent) {
    const owner = requireOwner(rawOwner);
    if (!materialKey(source)
      || !['D0_public', 'D1_internal', 'D2_sensitive', 'D3_private', 'D4_regulated'].includes(dataLevel)
      || !Number.isFinite(Date.parse(observedAt)) || typeof truncated !== 'boolean' || typeof redacted !== 'boolean'
      || !Array.isArray(evidenceRefs) || source.kind === 'tool-result' && !evidenceRefs.length
      || (origin !== undefined && !validMaterialOrigin(source, origin))) throw problem('material_snapshot_unavailable');
    requireCurrent(assertCurrent);
    const contentVersion = jsonDigest(value), id = materialKey({ ...source, expectedContentVersion: contentVersion });
    const metadata = { owner, source: { ...source, expectedContentVersion: contentVersion }, contentVersion, dataLevel, observedAt, truncated, redacted, evidenceRefs };
    return storage.transaction(owner.workspaceId, context => {
      requireCurrent(assertCurrent);
      privacy.remember(context, owner, dataLevel);
      const previous = context.db.prepare('SELECT owner,object,metadata FROM materials WHERE id=?').get(id);
      if (previous) {
        if (previous.owner !== encode(owner)) throw problem('material_identity_conflict');
        const savedSource = decode(previous.metadata)?.source;
        if (!same(savedSource, metadata.source)) throw problem('material_identity_conflict');
        const record = readMaterialRecord(previous, owner, metadata.source);
        if (record?.retired) throw problem('material_snapshot_cleaned');
        const { origin: _originalOrigin, ...actual } = record.metadata;
        if (previous.owner !== encode(owner) || previous.object !== contentVersion || !same(actual, { ...metadata, observedAt: actual.observedAt })) throw problem('material_identity_conflict');
        return clone(actual.source);
      }
      const object = storage.putObject(context, value);
      context.db.prepare('INSERT INTO materials VALUES(?,?,?,?)').run(id, encode(owner), object, encode(origin ? { ...metadata, origin } : metadata));
      return clone(metadata.source);
    });
  }
  function materialRecord(rawOwner, source) {
    const owner = requireOwner(rawOwner), context = storage.connect(owner.workspaceId);
    const id = materialKey(source);
    if (!context || !id) return null;
    const row = context.db.prepare('SELECT owner,object,metadata FROM materials WHERE id=?').get(id);
    const record = readMaterialRecord(row, owner, source);
    if (!record) return null;
    if (record.retired) throw problem('material_snapshot_cleaned');
    return { metadata: record.metadata, context, object: row.object };
  }
  return { commitPublication, getOperation, getVersion, getVersionMetadata, markIndexed, listPending, head, readVersions, recordMaterial,
    readMaterialInfo: (owner, source) => materialRecord(owner, source)?.metadata ?? null,
    readMaterial(owner, source) {
      const record = materialRecord(owner, source);
      return record && { ...record.metadata, value: storage.readObject(record.context, record.object), canonical: true, available: true };
    },
    ownerDataLevel: (rawOwner, minimum) => privacy.current(requireOwner(rawOwner), minimum),
    hasOwnerPrivacy: rawOwner => privacy.has(requireOwner(rawOwner)),
    rememberObservationLevel(rawOwner, dataLevel, assertOwner) {
      const owner = requireOwner(rawOwner);
      requireCurrent(assertOwner);
      // The baseline already dominates ordinary observations; avoid inactive-store writes.
      if (privacy.current(owner, dataLevel) !== dataLevel) return;
      return storage.transaction(owner.workspaceId, context => { requireCurrent(assertOwner); privacy.remember(context, owner, dataLevel); });
    },
    listPrepared: (owner, after) => attempts.listPrepared(requireOwner(owner), after),
    reconcileStoppedPreparation,
    getAttempt: raw => attempts.read(requireCall(raw)),
    beginAttempt: (input, assertCurrent) => attempts.begin({ ...input, callRef: requireCall(input.callRef) }, assertCurrent),
    finishAttempt: (raw, outcome) => attempts.finish(requireCall(raw), outcome),
    storage, close: () => storage.close() };
}
