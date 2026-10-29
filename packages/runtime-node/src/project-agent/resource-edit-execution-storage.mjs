import { createHash } from 'node:crypto';
import {
  normalizeResourceEditExecutionRecord, normalizeResourceEditPostlude, resourceEditExecutionMatches, resourceFileReplaceArgumentPayload,
  RESOURCE_EDIT_EXECUTION_BYTES, RESOURCE_EDIT_POSTLUDE_BYTES, RESOURCE_EDIT_EXECUTION_TOTAL_BYTES,
} from '@peer-agent/protocol';
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const fail = code => ({ ok: false, code });
const problem = code => Object.assign(Error(code), { code });
const bytes = value => Buffer.byteLength(value);
const operations = manifest => [...manifest.operations, ...manifest.retiredOperations];
const SLOT = RESOURCE_EDIT_EXECUTION_BYTES + RESOURCE_EDIT_POSTLUDE_BYTES;
export function createResourceEditExecutionTables(db) {
  db.exec(`CREATE TABLE execution_results(requestId TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(length(CAST(value AS BLOB))<=${RESOURCE_EDIT_EXECUTION_BYTES}), digest TEXT NOT NULL,
    postlude TEXT CHECK(postlude IS NULL OR length(CAST(postlude AS BLOB))<=${RESOURCE_EDIT_POSTLUDE_BYTES}), postludeDigest TEXT, CHECK((postlude IS NULL)=(postludeDigest IS NULL)));`);
}
function rows(context) {
  const size = context.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(value AS BLOB))+COALESCE(length(CAST(postlude AS BLOB)),0)),0) AS bytes FROM execution_results').get();
  if (Number(size.count) > 1088 || Number(size.bytes) > RESOURCE_EDIT_EXECUTION_TOTAL_BYTES) throw problem('RESOURCE_EDIT_EXECUTION_LIMIT');
  return { size: Number(size.bytes), rows: context.db.prepare('SELECT requestId,digest,postludeDigest,length(CAST(value AS BLOB)) AS valueBytes,COALESCE(length(CAST(postlude AS BLOB)),0) AS postludeBytes,(postlude IS NOT NULL) AS hasPostlude FROM execution_results').all() };
}
function decode(row, operation) {
  if (!operation || typeof row.value !== 'string' || bytes(row.value) > RESOURCE_EDIT_EXECUTION_BYTES || digest(row.value) !== row.digest) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
  const record = normalizeResourceEditExecutionRecord(JSON.parse(row.value));
  if (!record || record.requestId !== row.requestId || !resourceEditExecutionMatches(record, operation)) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
  let postlude = null;
  if (row.postlude !== null) {
    if (typeof row.postlude !== 'string' || bytes(row.postlude) > RESOURCE_EDIT_POSTLUDE_BYTES || digest(row.postlude) !== row.postludeDigest) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
    postlude = normalizeResourceEditPostlude(JSON.parse(row.postlude));
    if (!postlude || postlude.requestId !== record.requestId || postlude.payloadHash !== record.payloadHash) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
  } else if (row.postludeDigest !== null) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
  return { record, postlude };
}
/** Called inside the shared transaction. Reserved slots cannot be consumed by another intent. */
export function ensureResourceEditExecutionBudget(context, manifest) {
  const saved = rows(context), recorded = new Set(saved.rows.map(row => row.requestId));
  const reserve = manifest.operations.filter(op => op.phase !== 'settled' && !recorded.has(op.requestId)).length * SLOT
    + saved.rows.filter(row => !row.hasPostlude).length * RESOURCE_EDIT_POSTLUDE_BYTES;
  if (saved.size + reserve > RESOURCE_EDIT_EXECUTION_TOTAL_BYTES) throw problem('RESOURCE_EDIT_EXECUTION_LIMIT');
}
export function validateResourceEditExecutions(context, manifest) {
  const saved = rows(context), all = operations(manifest);
  const cache = context.executionValidationCache ??= new Map(), present = new Set();
  for (const row of saved.rows) {
    present.add(row.requestId);
    const op = all.find(op => op.requestId === row.requestId), signature = JSON.stringify([row.digest, row.postludeDigest, row.valueBytes, row.postludeBytes]);
    let cached = cache.get(row.requestId);
    if (!cached || cached.signature !== signature) {
      const actual = context.db.prepare('SELECT requestId,value,digest,postlude,postludeDigest FROM execution_results WHERE requestId=?').get(row.requestId);
      cached = { signature, ...decode(actual, op) }; cache.set(row.requestId, cached);
    }
    if (!op || !resourceEditExecutionMatches(cached.record, op)) throw problem('RESOURCE_EDIT_STORAGE_UNAVAILABLE');
  }
  for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
  // This cache is an index optimization only. executionResult re-reads and hashes the actual stored result before settlement.
  ensureResourceEditExecutionBudget(context, manifest);
}
/** Durable actual runtime observations. No project file, Provider, permission or task execution port. */
export function createResourceEditExecutionStorage({ transaction, readBlob }) {
  return {
    recordExecution(workspaceId, raw) {
      const record = normalizeResourceEditExecutionRecord(raw);
      if (!record || record.workspaceId !== workspaceId) return fail('RESOURCE_EDIT_INVALID_EXECUTION');
      return transaction(workspaceId, (context, manifest) => {
        const operation = manifest && operations(manifest).find(op => op.requestId === record.requestId);
        if (!operation || !resourceEditExecutionMatches(record, operation)) return fail('RESOURCE_EDIT_EXECUTION_MISMATCH');
        const existing = context.db.prepare('SELECT requestId,value,digest,postlude,postludeDigest FROM execution_results WHERE requestId=?').get(record.requestId), value = JSON.stringify(record);
        if (existing) { const old = decode(existing, operation); return JSON.stringify(old.record) === value ? { ok: true, ...old, repeated: true } : fail('RESOURCE_EDIT_EXECUTION_CONFLICT'); }
        if (!['running', 'uncertain'].includes(operation.phase)) return fail('RESOURCE_EDIT_NOT_STARTED');
        const body = context.db.prepare('SELECT proposedBlob FROM operation_bodies WHERE requestId=?').get(record.requestId);
        if (!body) return fail('RESOURCE_EDIT_BODY_CLEANED');
        const input = { requestId: operation.requestId, target: operation.target, content: readBlob(context, body.proposedBlob), proposedVersion: operation.proposedVersion };
        if (digest(resourceFileReplaceArgumentPayload(input)) !== record.call.argumentsDigest) return fail('RESOURCE_EDIT_EXECUTION_MISMATCH');
        context.db.prepare('INSERT INTO execution_results(requestId,value,digest) VALUES(?,?,?)').run(record.requestId, value, digest(value));
        ensureResourceEditExecutionBudget(context, manifest);
        return { ok: true, record, postlude: null, repeated: false };
      }, { claim: true });
    },
    recordExecutionPostlude(workspaceId, raw) {
      const postlude = normalizeResourceEditPostlude(raw); if (!postlude) return fail('RESOURCE_EDIT_INVALID_POSTLUDE');
      return transaction(workspaceId, (context, manifest) => {
        const operation = manifest && operations(manifest).find(op => op.requestId === postlude.requestId);
        const row = context?.db.prepare('SELECT requestId,value,digest,postlude,postludeDigest FROM execution_results WHERE requestId=?').get(postlude.requestId);
        if (!row || !operation) return fail('RESOURCE_EDIT_EXECUTION_MISSING');
        const saved = decode(row, operation); if (postlude.payloadHash !== saved.record.payloadHash) return fail('RESOURCE_EDIT_EXECUTION_MISMATCH');
        const value = JSON.stringify(postlude);
        if (saved.postlude && JSON.stringify(saved.postlude) === value) return { ok: true, ...saved, repeated: true };
        if (saved.postlude && !(saved.postlude.status === 'unconfirmed' && postlude.status === 'recorded')) return fail('RESOURCE_EDIT_EXECUTION_CONFLICT');
        context.db.prepare('UPDATE execution_results SET postlude=?,postludeDigest=? WHERE requestId=?').run(value, digest(value), postlude.requestId);
        ensureResourceEditExecutionBudget(context, manifest); return { ok: true, record: saved.record, postlude, repeated: false };
      }, { claim: true });
    },
    executionResult(workspaceId, requestId) {
      return transaction(workspaceId, (context, manifest) => {
        const operation = manifest && operations(manifest).find(op => op.requestId === requestId);
        const row = context?.db.prepare('SELECT requestId,value,digest,postlude,postludeDigest FROM execution_results WHERE requestId=?').get(requestId);
        return row && operation ? { ok: true, ...decode(row, operation) } : fail('RESOURCE_EDIT_EXECUTION_MISSING');
      });
    },
  };
}
