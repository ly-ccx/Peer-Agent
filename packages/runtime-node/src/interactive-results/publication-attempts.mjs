import { decode, encode, jsonDigest, problem } from './storage.mjs';
import { INTERACTIVE_RESULT_LIMITS as L, interactiveDigest, interactiveToken } from '@peer-agent/protocol';

const key = ref => jsonDigest([ref.owner, ref.conversationId, ref.toolCallId]);

/** Durable preparation identities and a work-scoped content repair budget.
 * These rows describe attempts, never a publication or an execution grant.
 */
export function createPublicationAttempts(storage) {
  function savedAttempt(body, callRef) {
    const saved = decode(body);
    if (encode(saved.callRef) !== encode(callRef) || !interactiveDigest(saved.argsDigest) || !interactiveDigest(saved.candidateId)
      || !['prepared', 'failed', 'committed'].includes(saved.phase) || saved.source?.conversationId !== callRef.conversationId
      || saved.source?.toolCallId !== callRef.toolCallId || !['planId', 'sessionId'].every(field => interactiveToken(saved.source?.[field]))
      || saved.phase === 'failed' && (typeof saved.code !== 'string' || !['failed', 'denied', 'cancelled', 'timeout'].includes(saved.status))) throw problem('interactive_storage_corrupt');
    return saved;
  }
  function read(callRef, context = storage.connect(callRef.owner.workspaceId)) {
    const row = context?.db.prepare('SELECT body FROM attempts WHERE id=?').get(key(callRef));
    return row ? savedAttempt(row.body, callRef) : null;
  }
  function listPrepared(owner, after = '') {
    const context = storage.connect(owner.workspaceId);
    if (!context) return [];
    return context.db.prepare(`SELECT id,body FROM attempts WHERE id>? AND json_extract(body,'$.phase')='prepared'
      AND json_extract(body,'$.callRef.owner.workspaceId')=? AND json_extract(body,'$.callRef.owner.conversationId')=?
      ORDER BY id LIMIT 32`).all(after, owner.workspaceId, owner.conversationId).map(row => {
      const ref = decode(row.body).callRef;
      if (key(ref) !== row.id || encode(ref.owner) !== encode(owner)) throw problem('interactive_storage_corrupt');
      return { ...savedAttempt(row.body, ref), cursor: row.id };
    });
  }
  function begin({ callRef, source, draft }, assertCurrent) {
    const argsDigest = jsonDigest(draft), id = key(callRef);
    const candidateId = jsonDigest([callRef.owner, source.conversationId, source.planId, source.sessionId,
      source.executionEpoch, source.generation ?? null, source.goalRevision ?? null,
      draft.publication.kind, draft.publication.base?.resultId ?? null]);
    return storage.transaction(callRef.owner.workspaceId, context => {
      if (assertCurrent() !== true) throw problem('interactive_execution_stale');
      const row = context.db.prepare('SELECT body FROM attempts WHERE id=?').get(id);
      if (row) {
        const saved = savedAttempt(row.body, callRef);
        if (saved.argsDigest !== argsDigest || encode(saved.source) !== encode(source)) throw problem('publication_parameter_conflict');
        if (saved.phase === 'failed') throw Object.assign(problem(saved.code), { status: saved.status });
        throw problem('publication_unknown');
      }
      const candidate = context.db.prepare('SELECT failures,active FROM publication_candidates WHERE id=?').get(candidateId);
      if (candidate && (!Number.isSafeInteger(candidate.failures) || candidate.failures < 0 || candidate.failures > L.contentRepairs + 1
        || candidate.active !== null && !interactiveDigest(candidate.active))) throw problem('interactive_storage_corrupt');
      if (candidate?.active) throw problem('publication_preparation_pending');
      if (candidate?.failures >= L.contentRepairs + 1) throw problem('interactive_repair_limit');
      if (candidate) context.db.prepare('UPDATE publication_candidates SET active=? WHERE id=?').run(id, candidateId);
      else context.db.prepare('INSERT INTO publication_candidates VALUES(?,?,?)').run(candidateId, 0, id);
      const saved = { callRef, source, argsDigest, candidateId, phase: 'prepared' };
      context.db.prepare('INSERT INTO attempts VALUES(?,?)').run(id, encode(saved));
      return saved;
    });
  }
  function finishInTransaction(context, callRef, { code, status = 'failed', contentFailure = false } = {}) {
    const id = key(callRef);
    const row = context.db.prepare('SELECT body FROM attempts WHERE id=?').get(id);
    if (!row) return null;
    const saved = savedAttempt(row.body, callRef);
    if (saved.phase !== 'prepared') return saved;
    const ended = { ...saved, phase: code ? 'failed' : 'committed', ...(code ? { code: String(code).slice(0, 100), status } : {}) };
    context.db.prepare('UPDATE attempts SET body=? WHERE id=?').run(encode(ended), id);
    const candidate = context.db.prepare('SELECT failures FROM publication_candidates WHERE id=?').get(saved.candidateId);
    if (!Number.isSafeInteger(candidate?.failures) || candidate.failures < 0 || candidate.failures > L.contentRepairs) {
      throw problem('interactive_storage_corrupt');
    }
    const failures = code ? candidate.failures + Number(contentFailure) : 0;
    const update = context.db.prepare('UPDATE publication_candidates SET active=NULL,failures=? WHERE id=? AND active=?')
      .run(failures, saved.candidateId, id);
    if (Number(update.changes) !== 1) throw problem('interactive_storage_corrupt');
    return contentFailure && code
      ? { ...ended, remainingRepairs: Math.max(0, L.contentRepairs + 1 - failures) } : ended;
  }
  function finish(callRef, outcome) {
    return storage.transaction(callRef.owner.workspaceId, context => finishInTransaction(context, callRef, outcome));
  }
  return { read, listPrepared, begin, finish, finishInTransaction };
}
