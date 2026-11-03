import { randomUUID } from 'node:crypto';
import { interactiveToken, normalizeInteractiveOwner, normalizeInteractiveReference, normalizeInteractiveFollowup, interactiveFeedbackFromFollowup } from '@peer-agent/protocol';
import { validateState, projectStateText } from '@peer-agent/interactive-content/state';
import { decode, encode, jsonDigest, problem } from './storage.mjs';

const clone = value => structuredClone(value);
const same = (a, b) => encode(a) === encode(b);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const numericDraft = raw => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()) && Number.isFinite(Number(raw));
function reference(raw) { const value = normalizeInteractiveReference(raw); if (!value) throw problem('interactive_reference_invalid'); return value; }
function view(raw) {
  if (!raw || !['viewId', 'windowId', 'generation'].every(key => interactiveToken(raw[key])) || Object.keys(raw).some(key => !['viewId', 'windowId', 'generation'].includes(key))) throw problem('interactive_view_invalid');
  return clone(raw);
}

/** Device-local user state. Canonical writer generations/CAS live in SQLite, never in Renderer state. */
export function createInteractiveStateStore({ resultStore, now = () => new Date().toISOString() }) {
  const storage = resultStore.storage, touched = new Set();
  let disposed = false;
  function requireView(check) { if (disposed || typeof check !== 'function' || check() !== true) throw problem('interactive_view_stale'); }
  function defaults(ref, published) {
    const values = clone(published.content.initialValues), inputDrafts = {};
    return { result: ref, specHash: published.content.specHash, stateSchemaHash: published.content.stateSchemaHash,
      stateRevision: 0, values, inputDrafts, stateDigest: jsonDigest({ values, inputDrafts }), updatedAt: published.createdAt, requestId: 'initial' };
  }
  function load(context, ref, published) {
    const row = context?.db.prepare('SELECT snapshot,writer FROM states WHERE id=? AND version=?').get(ref.resultId, ref.contentVersion);
    if (!row) return { snapshot: defaults(ref, published), writer: null, present: false };
    const snapshot = decode(row.snapshot), writer = row.writer ? decode(row.writer) : null;
    checkedSnapshot(snapshot, ref, published);
    return { snapshot, writer, present: true };
  }
  function checkedSnapshot(snapshot, ref, published) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Object.keys(snapshot).length !== 9 || Object.keys(snapshot).some(key => !['result', 'specHash', 'stateSchemaHash', 'stateRevision', 'values', 'inputDrafts', 'stateDigest', 'updatedAt', 'requestId'].includes(key))
      || !interactiveToken(snapshot.requestId) || !Number.isFinite(Date.parse(snapshot.updatedAt))
      || !same(snapshot.result, ref) || snapshot.specHash !== published.content.specHash || snapshot.stateSchemaHash !== published.content.stateSchemaHash
      || !Number.isSafeInteger(snapshot.stateRevision) || snapshot.stateRevision < 0
      || jsonDigest({ values: snapshot.values, inputDrafts: snapshot.inputDrafts }) !== snapshot.stateDigest) throw problem('interactive_state_corrupt');
    validateState(snapshot.values, published.content.stateSchema, snapshot.inputDrafts);
    return snapshot;
  }
  function writeRow(context, ref, snapshot, writer) {
    context.db.prepare('INSERT INTO states VALUES(?,?,?,?) ON CONFLICT(id,version) DO UPDATE SET snapshot=excluded.snapshot,writer=excluded.writer')
      .run(ref.resultId, ref.contentVersion, encode(snapshot), writer ? encode(writer) : null);
    touched.add(ref.owner.workspaceId);
  }
  function requireWriter(actual, supplied, identity) {
    if (!actual || !supplied || actual.hostEpoch !== storage.hostEpoch || actual.pid !== process.pid || actual.token !== supplied.token
      || actual.viewId !== identity.viewId || actual.windowId !== identity.windowId || actual.viewGeneration !== identity.generation
      || actual.generation !== supplied.generation || supplied.viewId !== identity.viewId) throw problem('interactive_writer_stale');
  }
  function read(rawReference, assertView) {
    const ref = reference(rawReference); requireView(assertView);
    const published = resultStore.getVersion(ref), context = storage.connect(ref.owner.workspaceId);
    return clone(load(context, ref, published).snapshot);
  }
  function acquire({ reference: rawReference, identity: rawIdentity, expectedRevision, takeover = false }, assertView) {
    const ref = reference(rawReference), identity = view(rawIdentity); requireView(assertView);
    return storage.transaction(ref.owner.workspaceId, context => {
      requireView(assertView);
      const published = resultStore.getVersion(ref), state = load(context, ref, published);
      if (state.snapshot.stateRevision !== expectedRevision) throw problem('interactive_state_conflict');
      const old = state.writer;
      if (old && old.hostEpoch === storage.hostEpoch && old.viewId === identity.viewId && old.windowId === identity.windowId && old.viewGeneration === identity.generation) {
        return { viewId: old.viewId, generation: old.generation, token: old.token };
      }
      if (old && alive(old.pid) && !takeover) throw problem('interactive_writer_busy');
      const writer = { viewId: identity.viewId, windowId: identity.windowId, viewGeneration: identity.generation,
        generation: randomUUID(), token: randomUUID(), hostEpoch: storage.hostEpoch, pid: process.pid };
      writeRow(context, ref, state.snapshot, writer);
      return { viewId: writer.viewId, generation: writer.generation, token: writer.token };
    });
  }
  function saveOutcome({ reference: rawReference, identity: rawIdentity, writer, expectedRevision, requestId, values, inputDrafts }, assertView) {
    const ref = reference(rawReference), identity = view(rawIdentity); requireView(assertView);
    if (!interactiveToken(requestId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw problem('interactive_save_invalid');
    return storage.transaction(ref.owner.workspaceId, context => {
      requireView(assertView);
      const published = resultStore.getVersion(ref), state = load(context, ref, published);
      const normalized = validateState(values, published.content.stateSchema, inputDrafts);
      const argsDigest = jsonDigest({ identity, writer, expectedRevision, ...normalized });
      const previous = context.db.prepare('SELECT argsDigest,receipt FROM saves WHERE id=? AND version=? AND requestId=?').get(ref.resultId, ref.contentVersion, requestId);
      if (previous) {
        if (previous.argsDigest !== argsDigest) throw problem('interactive_save_parameter_conflict');
        const receipt = checkedSnapshot(decode(previous.receipt), ref, published);
        if (receipt.requestId !== requestId || receipt.stateRevision !== expectedRevision + 1
          || !same({ values: receipt.values, inputDrafts: receipt.inputDrafts }, normalized)) throw problem('interactive_save_receipt_corrupt');
        let writerCurrent = true;
        try { requireWriter(state.writer, writer, identity); } catch { writerCurrent = false; }
        return { state: clone(receipt), writerCurrent };
      }
      try { requireWriter(state.writer, writer, identity); }
      catch (error) { throw Object.assign(error, { saveStatus: 'not_committed' }); }
      if (state.snapshot.stateRevision !== expectedRevision) throw Object.assign(problem('interactive_state_conflict'),
        state.snapshot.stateRevision > expectedRevision ? { saveStatus: 'not_committed' } : {});
      const snapshot = { ...state.snapshot, ...normalized, stateRevision: expectedRevision + 1, stateDigest: jsonDigest(normalized), updatedAt: now(), requestId };
      writeRow(context, ref, snapshot, state.writer);
      context.db.prepare('INSERT INTO saves VALUES(?,?,?,?,?)').run(ref.resultId, ref.contentVersion, requestId, argsDigest, encode(snapshot));
      return { state: clone(snapshot), writerCurrent: true };
    });
  }
  /** Compatibility for domain callers that consume only the immutable snapshot.
   * @param {Parameters<typeof saveOutcome>[0]} value
   * @param {Parameters<typeof saveOutcome>[1]} assertView */
  function save(value, assertView) { return saveOutcome(value, assertView).state; }
  function release({ reference: rawReference, identity: rawIdentity, writer }, assertView) {
    const ref = reference(rawReference), identity = view(rawIdentity); requireView(assertView);
    return storage.transaction(ref.owner.workspaceId, context => {
      requireView(assertView);
      const published = resultStore.getVersion(ref), state = load(context, ref, published);
      if (!state.writer) return true;
      requireWriter(state.writer, writer, identity);
      writeRow(context, ref, state.snapshot, null); return true;
    });
  }
  function prepareFollowup({ reference: rawReference, identity: rawIdentity, writer, stateRevision, stateDigest, fields, requestId }, assertView) {
    const ref = reference(rawReference), identity = view(rawIdentity); requireView(assertView);
    if (!interactiveToken(requestId) || !Array.isArray(fields) || !fields.length || fields.length > 64 || fields.some(key => typeof key !== 'string')
      || new Set(fields).size !== fields.length) throw problem('interactive_followup_invalid');
    return storage.transaction(ref.owner.workspaceId, context => {
      requireView(assertView);
      const published = resultStore.getVersion(ref), state = load(context, ref, published);
      requireWriter(state.writer, writer, identity);
      const argsDigest = jsonDigest({ reference: ref, stateRevision, stateDigest, fields: [...fields].sort() });
      const previous = context.db.prepare('SELECT owner,argsDigest,snapshot FROM followups WHERE id=?').get(requestId);
      if (previous) {
        if (previous.owner !== encode(ref.owner) || previous.argsDigest !== argsDigest) throw problem('interactive_followup_parameter_conflict');
        return checkedFollowup(decode(previous.snapshot));
      }
      if (state.snapshot.stateRevision !== stateRevision || state.snapshot.stateDigest !== stateDigest) throw problem('state_revision_unavailable');
      if (fields.some(key => !Object.hasOwn(published.content.stateSchema, key))) throw problem('interactive_followup_invalid');
      for (const key of fields) {
        const raw = state.snapshot.inputDrafts[key], value = state.snapshot.values[key];
        if (raw !== undefined && (typeof value === 'number' ? !numericDraft(raw) || Number(raw) !== value : raw !== value)) throw problem('followup_input_incomplete');
      }
      const values = Object.fromEntries(fields.map(key => [key, state.snapshot.values[key]]));
      const excerpt = `${published.content.title}\n${projectStateText(published.content, { values }, { fields })}`;
      if (Buffer.byteLength(excerpt, 'utf8') > 8192) throw problem('interactive_followup_limit');
      const body = { followupId: requestId, recipient: ref.owner, result: ref, specHash: published.content.specHash,
        stateRevision, stateDigest, values, dataLevel: resultStore.ownerDataLevel(ref.owner, published.dataLevel), capturedAt: now(), excerpt };
      const snapshot = { ...body, selectionDigest: jsonDigest(body) };
      if (!interactiveFeedbackFromFollowup(snapshot)) throw problem('interactive_followup_limit');
      context.db.prepare('INSERT INTO followups VALUES(?,?,?,?)').run(requestId, encode(ref.owner), argsDigest, encode(snapshot));
      touched.add(ref.owner.workspaceId);
      return clone(snapshot);
    });
  }
  function checkedFollowup(snapshot) {
    const { selectionDigest, ...body } = snapshot;
    if (!normalizeInteractiveFollowup(snapshot) || jsonDigest(body) !== selectionDigest) throw problem('interactive_followup_corrupt');
    return clone(snapshot);
  }
  function readFollowup(rawOwner, id) {
    const owner = normalizeInteractiveOwner(rawOwner);
    if (!owner || !interactiveToken(id)) throw problem('interactive_followup_invalid');
    const context = storage.connect(owner.workspaceId);
    const row = context?.db.prepare('SELECT owner,snapshot FROM followups WHERE id=?').get(id);
    if (!row || row.owner !== encode(owner)) throw problem('interactive_followup_unavailable');
    return checkedFollowup(decode(row.snapshot));
  }
  function close() {
    if (disposed) return;
    disposed = true;
    for (const workspace of touched) {
      try {
        storage.transaction(workspace, context => {
          for (const row of context.db.prepare('SELECT id,version,writer FROM states WHERE writer IS NOT NULL').all()) {
            if (decode(row.writer).hostEpoch === storage.hostEpoch) context.db.prepare('UPDATE states SET writer=NULL WHERE id=? AND version=?').run(row.id, row.version);
          }
        });
      } catch { /* An unconfirmed release is safe: only explicit takeover can replace a live writer. */ }
    }
  }
  return { read, acquire, save, saveOutcome, release, prepareFollowup, readFollowup, close };
}
