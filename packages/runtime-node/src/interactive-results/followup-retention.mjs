import { interactiveDigest, interactiveToken, normalizeInteractiveOwner } from '@peer-agent/protocol';
import { decode, encode, jsonDigest, problem } from './storage.mjs';
import { RETIRED_FOLLOWUP, readFollowupRecord } from './followup-record.mjs';
import { interactiveProcessAlive, readLiveInteractiveViewPins } from './view-pins.mjs';

const RETIRED_LIMIT = 256;
function target(raw) {
  const owner = normalizeInteractiveOwner(raw?.owner);
  if (!owner || !interactiveToken(raw.followupId)) throw problem('interactive_followup_invalid');
  return { owner, followupId: raw.followupId };
}

/** Separate retirement of user-confirmed snapshots, under the same six roots. */
export function createFollowupRetention({ resultStore, current, roots, now, onStep }) {
  const { storage } = resultStore;
  function read(context, { owner, followupId }) {
    const row = context?.db.prepare('SELECT owner,argsDigest,snapshot FROM followups WHERE id=?').get(followupId);
    return { row, ...readFollowupRecord(row, owner, followupId) };
  }

  function inspect(context, selection, record, guarded, assertCurrent) {
    assertCurrent();
    const { snapshot } = record, { owner, followupId } = selection, reference = snapshot.result;
    resultStore.getVersionMetadata(reference, { allowCleaned: true });
    const key = encode(reference);
    const views = readLiveInteractiveViewPins(context, owner).filter(pin => encode(pin.reference) === key);
    const row = context.db.prepare('SELECT writer FROM states WHERE id=? AND version=?').get(reference.resultId, reference.contentVersion);
    const writer = row?.writer == null ? null : decode(row.writer);
    if (row?.writer != null && (!writer || !Number.isSafeInteger(writer.pid) || writer.pid <= 0
      || !['token', 'hostEpoch', 'viewId', 'windowId', 'viewGeneration', 'generation'].every(field => interactiveToken(writer[field]))))
      throw problem('interactive_storage_corrupt');
    const blockers = new Set(guarded.pins.filter(pin => encode(pin.reference) === key).map(pin => pin.source));
    if (guarded.followupIds.includes(followupId)) blockers.add('followup');
    if (views.length) blockers.add('views');
    if (writer && interactiveProcessAlive(writer.pid)) blockers.add('writer');
    const cleanupDigest = jsonDigest({ selection, row: record.row, guarded, views, writer, blockers: [...blockers].sort() });
    assertCurrent();
    return { ...selection, reference, cleanupDigest, blockers: [...blockers].sort() };
  }

  function previewFollowup(raw) {
    const selection = target(raw);
    return roots(selection.owner, (guarded, assertCurrent) => {
      const context = storage.connect(selection.owner.workspaceId);
      if (!context) throw problem('interactive_followup_unavailable');
      context.db.exec('BEGIN');
      try {
        const record = read(context, selection);
        if (record.retired) throw problem('interactive_followup_cleaned');
        const preview = inspect(context, selection, record, guarded, assertCurrent);
        context.assertFile(); context.db.exec('COMMIT'); return preview;
      } catch (error) { try { context.db.exec('ROLLBACK'); } catch {} throw error; }
    });
  }

  function readFollowupReceipt(raw) {
    const selection = target(raw);
    current(selection.owner);
    const record = read(storage.connect(selection.owner.workspaceId), selection);
    current(selection.owner);
    return record.retired ?? null;
  }

  function cleanupFollowup(raw) {
    const selection = target(raw), { owner, followupId } = selection, { expectedDigest, requestId } = raw;
    if (!interactiveDigest(expectedDigest) || !interactiveToken(requestId)) throw problem('interactive_cleanup_invalid');
    const sameRequest = previous => {
      if (previous.requestId !== requestId || previous.expectedDigest !== expectedDigest) throw problem('interactive_cleanup_parameter_conflict');
      return previous;
    };
    const existing = readFollowupReceipt(selection);
    if (existing) return sameRequest(existing);
    return roots(owner, (guarded, assertCurrent) => storage.transaction(owner.workspaceId, context => {
      const record = read(context, selection);
      if (record.retired) return sameRequest(record.retired);
      const preview = inspect(context, selection, record, guarded, assertCurrent);
      if (preview.cleanupDigest !== expectedDigest) throw problem('interactive_retention_stale');
      if (preview.blockers.length) throw problem('interactive_cleanup_blocked');
      const count = context.db.prepare("SELECT COUNT(*) AS n FROM followups WHERE owner=? AND json_extract(snapshot,'$.kind')=?")
        .get(encode(owner), RETIRED_FOLLOWUP).n;
      if (Number(count) >= RETIRED_LIMIT) throw problem('interactive_cleanup_limit');
      const body = { schemaVersion: 1, kind: RETIRED_FOLLOWUP, recipient: owner, followupId, argsDigest: record.row.argsDigest,
        requestId, expectedDigest, cleanedAt: now() };
      if (!Number.isFinite(Date.parse(body.cleanedAt))) throw problem('interactive_cleanup_invalid');
      const receipt = { ...body, receiptDigest: jsonDigest(body) };
      context.db.prepare('UPDATE followups SET snapshot=? WHERE id=? AND owner=?').run(encode(receipt), followupId, encode(owner));
      onStep('followup_cleanup_before_commit'); assertCurrent();
      return receipt;
    }));
  }
  return { previewFollowup, cleanupFollowup, readFollowupReceipt };
}
