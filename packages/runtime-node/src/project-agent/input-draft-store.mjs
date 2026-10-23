import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';
import { INPUT_ATTACHMENT_LIMIT, normalizeUserUpload } from './input-attachments.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SURFACES = new Set(['desktop', 'quick_chat', 'tui']);
const MAX_PENDING = 32;
const empty = () => ({ schemaVersion: 1, revision: 0, draft: { text: '', quote: null, attachmentIds: [] }, pending: [], uploads: {} });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, limit = 100_000) {
  if (typeof value !== 'string' || value.length > limit) throw Error('INVALID_DRAFT');
  return value;
}
function atomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); renameSync(tmp, file); }
  finally { rmSync(tmp, { force: true }); }
}

/** Device-local recoverable intent. This store never submits to, or wakes, a runner.
 * @param {{ rootDir?: string | null }} [options]
 */
export function createProjectInputDraftStore({ rootDir = null } = {}) {
  function location(request) {
    if (!ID.test(request?.workspaceId || '') || !SURFACES.has(request?.surface)) throw Error('INVALID_DRAFT');
    const root = path.join(rootDir || pathOf('projectRuntime'), request.workspaceId);
    return { root, file: path.join(root, 'input-drafts', `${request.surface}.json`) };
  }
  function load(file) {
    if (!existsSync(file)) return empty();
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved?.schemaVersion !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0
      || !record(saved.draft) || !Array.isArray(saved.pending) || !record(saved.uploads)) throw Error('DRAFT_UNAVAILABLE');
    return saved;
  }
  /** @param {import('@peer-agent/protocol').ProjectInputDraftReadRequest} request
   * @returns {import('@peer-agent/protocol').ProjectInputDraftReadResult} */
  function read(request) {
    try {
      const { root, file } = location(request), saved = load(file);
      const hydrated = new Map();
      const hydrate = ids => {
        if (!Array.isArray(ids) || ids.length > INPUT_ATTACHMENT_LIMIT) throw Error('DRAFT_UNAVAILABLE');
        return ids.map(id => {
          const digest = saved.uploads[id];
          if (!/^[a-f0-9]{64}$/.test(digest || '')) throw Error('DRAFT_UNAVAILABLE');
          if (hydrated.has(id)) return hydrated.get(id);
          const item = normalizeUserUpload(JSON.parse(readFileSync(path.join(root, 'input-draft-blobs', `${digest}.json`), 'utf8')));
          if (item.id !== id) throw Error('DRAFT_UNAVAILABLE');
          hydrated.set(id, item);
          return item;
        });
      };
      const draft = { text: text(saved.draft.text), quote: quote(saved.draft.quote), attachments: hydrate(saved.draft.attachmentIds) };
      if (saved.pending.length > MAX_PENDING) throw Error('DRAFT_UNAVAILABLE');
      const pending = saved.pending.map(item => ({ ...envelope(item), attachments: hydrate(item.attachmentIds) }));
      return { ok: true, snapshot: { revision: saved.revision, draft, pending } };
    } catch (error) { return { ok: false, code: error?.message === 'INVALID_DRAFT' ? 'INVALID_DRAFT' : 'DRAFT_UNAVAILABLE' }; }
  }
  /** @param {import('@peer-agent/protocol').ProjectInputDraftWriteRequest} request
   * @returns {import('@peer-agent/protocol').ProjectInputDraftWriteResult} */
  function write(request) {
    let lock;
    try {
      const { root, file } = location(request);
      if (!Number.isSafeInteger(request.revision) || request.revision < 0) throw Error('INVALID_DRAFT');
      mkdirSync(path.dirname(file), { recursive: true });
      lock = `${file}.lock`;
      try { mkdirSync(lock); }
      catch {
        let dead = false;
        try {
          const owner = JSON.parse(readFileSync(path.join(lock, 'owner.json'), 'utf8'));
          if (Number.isInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (error) { dead = error?.code === 'ESRCH'; }
          }
        } catch { try { dead = Date.now() - statSync(lock).mtimeMs > 10_000; } catch {} }
        if (!dead) { lock = null; return { ok: false, code: 'DRAFT_BUSY' }; }
        rmSync(lock, { recursive: true, force: true });
        try { mkdirSync(lock); } catch { lock = null; return { ok: false, code: 'DRAFT_BUSY' }; }
      }
      writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
      const before = load(file);
      if (before.revision !== request.revision) return { ok: false, code: 'DRAFT_CONFLICT' };
      const uploads = Object.assign(Object.create(null), before.uploads);
      if (!Array.isArray(request.uploads) || request.uploads.length > INPUT_ATTACHMENT_LIMIT * (MAX_PENDING + 1)) throw Error('INVALID_DRAFT');
      for (const raw of request.uploads) {
        const upload = normalizeUserUpload(raw), body = JSON.stringify(upload);
        const digest = createHash('sha256').update(body).digest('hex');
        // An attachment ID is stable within a recovery record. Do not reinterpret old envelopes.
        if (uploads[upload.id] && uploads[upload.id] !== digest) throw Error('DRAFT_ATTACHMENT_CONFLICT');
        const blob = path.join(root, 'input-draft-blobs', `${digest}.json`);
        if (!existsSync(blob)) atomic(blob, upload);
        uploads[upload.id] = digest;
      }
      const refs = values => {
        if (!Array.isArray(values) || values.length > INPUT_ATTACHMENT_LIMIT || new Set(values).size !== values.length
          || values.some(id => typeof id !== 'string' || !uploads[id])) throw Error('INVALID_DRAFT');
        return [...values];
      };
      const draft = { text: text(request.draft?.text), quote: quote(request.draft?.quote), attachmentIds: refs(request.draft?.attachmentIds) };
      if (!Array.isArray(request.pending) || request.pending.length > MAX_PENDING) throw Error('DRAFT_LIMIT');
      const pending = request.pending.map(item => ({ ...envelope(item), attachmentIds: refs(item.attachmentIds) }));
      if (new Set(pending.map(item => item.inputId)).size !== pending.length) throw Error('INVALID_DRAFT');
      const used = new Set([...draft.attachmentIds, ...pending.flatMap(item => item.attachmentIds)]);
      if ([...used].reduce((bytes, id) => bytes + statSync(path.join(root, 'input-draft-blobs', `${uploads[id]}.json`)).size, 0) > 96 * 1024 * 1024) throw Error('DRAFT_LIMIT');
      atomic(file, { schemaVersion: 1, revision: before.revision + 1, draft, pending,
        uploads: Object.fromEntries([...used].map(id => [id, uploads[id]])) });
      return { ok: true, revision: before.revision + 1 };
    } catch (error) { return { ok: false, code: ['INVALID_DRAFT', 'DRAFT_LIMIT', 'DRAFT_ATTACHMENT_CONFLICT'].includes(error?.message) ? error.message : 'DRAFT_SAVE_FAILED' }; }
    finally { if (lock) rmSync(lock, { recursive: true, force: true }); }
  }
  return { read, write };
}
function quote(value) {
  if (value == null) return null;
  return { messageId: text(value.messageId, 512), text: text(value.text) };
}
function envelope(item) {
  if (!ID.test(item?.inputId || '') || !Number.isFinite(Date.parse(item?.createdAt))) throw Error('INVALID_DRAFT');
  if (!Array.isArray(item.quoteRefs) || item.quoteRefs.length > 64) throw Error('INVALID_DRAFT');
  return { inputId: item.inputId, text: text(item.text), createdAt: item.createdAt,
    quoteRefs: item.quoteRefs.map(ref => text(ref)), ...(item.answerTo ? { answerTo: text(item.answerTo, 512) } : {}) };
}
