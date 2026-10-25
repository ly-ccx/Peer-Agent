import { botResourceReferences } from '@peer-agent/protocol';
import { DatabaseSync } from './sqlite-runtime.generated.mjs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, statSync, existsSync, openSync, closeSync, readSync, readFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { INTERACTION_WORKER_SOURCE } from './interaction-worker-source.generated.mjs';

const fail = code => Object.assign(new Error(code), { code });
const corruptIndex = error => [11, 26].includes(Number(error.errcode) & 255);
const version = file => { try { const s = statSync(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; } catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; } };
const visible = new Set(['user_input', 'agent_reply', 'system_card', 'agent_activity']);
const dispositionTools = new Set(['spawn_session', 'message_session', 'cancel_session']);
const object = value => { if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return null; } } return value && typeof value === 'object' ? value : null; };
const pick = (value, keys) => value ? Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])) : null;

function project(message) {
  const { rounds, segments, resourceReferences, ...row } = message;
  if (row.kind === 'agent_activity' && ['verifying', 'verified'].includes(row.agentActivity?.state)) return null;
  if (row.kind === 'system_card' && Array.isArray(row.cards) && row.cards.some(card => card?.kind === 'verdict')) {
    row.cards = row.cards.filter(card => card?.kind !== 'verdict');
    if (!row.cards.length) return null;
  }
  if (row.kind === 'agent_turn') return { id: row.id, role: row.role, kind: row.kind, turnId: row.turnId, turnKind: row.turnKind,
    content: '', createdAt: row.createdAt, replyTo: row.replyTo, userInputs: row.userInputs?.map(input => ({ inputId: input.inputId })),
    publicUpdates: row.publicUpdates, resourceReferences: botResourceReferences(rounds), meta: pick(row.meta, ['workId', 'replyTo']), dispositionCalls: (rounds || []).flatMap(round => (round.toolCalls || []).flatMap(call => {
      if (!dispositionTools.has(call.name)) return [];
      const input = object(call.input), result = object(call.result), output = object(result?.output);
      return [{ name: call.name, input: pick(input, ['sessionId', 'intent', 'reason', 'supersedes', 'dependsOn', 'title']),
        result: pick(output && !result?.sessionId ? output : result, ['ok', 'error', 'sessionId', 'status', 'queued']) }];
    })) };
  if (visible.has(row.kind) || !row.kind && ['user', 'assistant'].includes(row.role)) return row;
  return null;
}

function connect(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
  db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  db.exec('CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY,value TEXT);'
    + 'CREATE TABLE IF NOT EXISTS identities (id TEXT PRIMARY KEY,seq INTEGER);'
    + 'CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY,seq INTEGER,start INTEGER,end INTEGER,kind TEXT,turnId TEXT);'
    + 'CREATE INDEX IF NOT EXISTS record_turn ON records(turnId,seq);'
    + 'CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY,id TEXT,kind TEXT,body TEXT);'
    + 'CREATE INDEX IF NOT EXISTS message_kind ON messages(kind,seq);'
    + 'CREATE TABLE IF NOT EXISTS links (anchor TEXT,seq INTEGER,PRIMARY KEY(anchor,seq));');
  return db;
  } catch (error) { db.close(); throw error; }
}
const meta = (db, key) => db.prepare('SELECT value FROM meta WHERE id=?').get(key)?.value;
const put = (db, key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, String(value));
function prefix(file, size) {
  if (!size) return '';
  const fd = openSync(file, 'r'), hash = createHash('sha256');
  try { for (const offset of [0, Math.max(0, size - 192)]) { const b = Buffer.alloc(Math.min(192, size)); if (readSync(fd, b, 0, b.length, offset) !== b.length) throw fail('BACKGROUND_VERSION_CHANGED'); hash.update(b); } return hash.digest('hex'); }
  finally { closeSync(fd); }
}

function rebuild({ file, target, expected, appendOnly = false }) {
  const db = connect(target), actual = version(file);
  try {
    if (actual !== expected) throw fail('BACKGROUND_VERSION_CHANGED');
    const size = existsSync(file) ? statSync(file).size : 0, oldSize = Number(meta(db, 'size') || 0), previous = meta(db, 'source');
    const append = meta(db, 'schema') === '4' && meta(db, 'terminated') === 'true' && previous && size > oldSize && previous.split(':').slice(0, 2).join(':') === actual.split(':').slice(0, 2).join(':') && prefix(file, oldSize) === meta(db, 'anchor');
    if (appendOnly && (!append || size - oldSize > 128 * 1024)) throw fail('BACKGROUND_VERSION_CHANGED');
    db.exec('BEGIN IMMEDIATE');
    if (!append) db.exec('DELETE FROM messages; DELETE FROM identities; DELETE FROM links; DELETE FROM records;');
    let seq = append ? Number(meta(db, 'seq') || 0) : 0, terminated = true;
    if (size) {
      const fd = openSync(file, 'r'), chunk = Buffer.alloc(64 * 1024); let offset = append ? oldSize : 0, pending = Buffer.alloc(0), lineStart = offset;
      const consume = (line, terminated) => {
        const start = lineStart; lineStart += line.length + (terminated ? 1 : 0);
        if (!line.length) return;
        let raw; try { raw = JSON.parse(line.toString('utf8')); } catch { throw fail('BACKGROUND_HISTORY_CORRUPT'); }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('BACKGROUND_HISTORY_CORRUPT');
        seq++; if (!raw.id) return;
        db.prepare('INSERT OR REPLACE INTO identities VALUES (?,?)').run(raw.id, seq);
        db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?)').run(raw.id, seq, start, lineStart, raw.kind || '', raw.turnId || '');
        const row = project(raw); if (!row) return;
        const kind = row.kind || (row.role === 'user' ? 'user_input' : 'agent_reply');
        db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run(seq, row.id, kind, JSON.stringify(row));
        if (kind === 'agent_turn') for (const input of row.userInputs || []) db.prepare('INSERT OR IGNORE INTO links VALUES (?,?)').run(`input-${input.inputId}`, seq);
      };
      try {
        while (offset < size) {
          const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset); if (!count) throw fail('BACKGROUND_VERSION_CHANGED'); offset += count;
          const body = pending.length ? Buffer.concat([pending, chunk.subarray(0, count)]) : chunk.subarray(0, count);
          let from = 0, at; while ((at = body.indexOf(10, from)) >= 0) { consume(body.subarray(from, at), true); from = at + 1; }
          pending = Buffer.from(body.subarray(from)); if (pending.length > 64 * 1024 * 1024) throw fail('BACKGROUND_RECORD_TOO_LARGE');
        }
        if (pending.length) { consume(pending, false); terminated = false; }
      } finally { closeSync(fd); }
    }
    if (version(file) !== actual) throw fail('BACKGROUND_VERSION_CHANGED');
    put(db, 'terminated', terminated); put(db, 'schema', 4); put(db, 'source', actual); put(db, 'size', size); put(db, 'seq', seq); put(db, 'anchor', prefix(file, size)); db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

/** Public interaction reads never invoke the full history/child transcript readers. */
export function createInteractionReader({ storeDir, readMeta }) {
  const flights = new Map();
  async function read(id, params = {}) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id)) throw fail('INVALID_CONVERSATION');
    const description = readMeta(id); if (!description) return null;
    const file = path.join(storeDir, `${id}.jsonl`), sidecarFile = path.join(storeDir, `${id}.stream.json`);
    const namespace = createHash('sha256').update(path.resolve(storeDir)).digest('hex').slice(0, 16);
    const target = path.join(path.dirname(storeDir), 'cache', 'read-models', 'interactions', namespace, `${id}.sqlite`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const expected = version(file), sidecarVersion = version(sidecarFile);
      if (expected === 'missing' && Number(description.contentRevision) > 0) throw fail('BACKGROUND_HISTORY_MISSING');
      let db;
      try { db = connect(target); }
      catch (error) {
        if (!corruptIndex(error) || !existsSync(target)) throw error;
        const backup = `${target}.corrupt-${Date.now()}`;
        renameSync(target, backup);
        for (const suffix of ['-wal', '-shm']) if (existsSync(target + suffix)) renameSync(target + suffix, backup + suffix);
        db = connect(target);
      }
      if (meta(db, 'schema') !== '4' || meta(db, 'source') !== expected) {
        const oldSize = Number(meta(db, 'size') || 0), previous = meta(db, 'source');
        const size = expected === 'missing' ? 0 : statSync(file).size;
        const smallTail = !flights.has(id) && meta(db, 'schema') === '4' && meta(db, 'terminated') === 'true' && previous
          && size > oldSize && size - oldSize <= 128 * 1024 && previous.split(':').slice(0, 2).join(':') === expected.split(':').slice(0, 2).join(':')
          && prefix(file, oldSize) === meta(db, 'anchor');
        db.close();
        if (smallTail) {
          // Catch up only a verified, bounded suffix. Cold/replaced/large sources
          // stay on the worker; no synchronous full-history fallback exists.
          try { rebuild({ file, target, expected, appendOnly: true }); }
          catch (error) { if (error.code === 'BACKGROUND_VERSION_CHANGED' && attempt < 2) continue; throw error; }
          db = connect(target);
        } else {
        let flight = flights.get(id);
        if (!flight) {
          flight = new Promise((resolve, reject) => {
            const worker = new Worker(INTERACTION_WORKER_SOURCE, { eval: true, ...(!process.versions.bun ? { resourceLimits: { maxOldGenerationSizeMb: 192 } } : {}), workerData: { interactionRebuild: { file, target, expected } } });
            let settled = false;
            const finish = error => { if (settled) return; settled = true; clearTimeout(timer); if (error) { void worker.terminate(); reject(error); } else resolve(); };
            const timer = setTimeout(() => finish(fail('BACKGROUND_READ_TIMEOUT')), 120000);
            worker.once('message', result => finish(result.ok ? null : fail(result.code || 'BACKGROUND_READ_FAILED')));
            worker.once('error', finish); worker.once('exit', () => finish(fail('BACKGROUND_READ_FAILED')));
          }).finally(() => { flights.delete(id); }); flights.set(id, flight);
        }
        try { await flight; } catch (error) { if (error.code === 'BACKGROUND_VERSION_CHANGED' && attempt < 2) continue; throw error; }
        db = connect(target);
        }
      }
      try {
        if (meta(db, 'source') !== expected || version(file) !== expected) continue;
        let excluded = null, upper = Number.MAX_SAFE_INTEGER;
        if (sidecarVersion !== 'missing') {
          let marker; try { marker = JSON.parse(readFileSync(sidecarFile, 'utf8')); } catch { throw fail('BACKGROUND_STREAM_STATE_INVALID'); }
          if (marker.version !== 1 || marker.conversationId !== id || !marker.messageId || !marker.patch || typeof marker.patch !== 'object' || Array.isArray(marker.patch)) throw fail('BACKGROUND_STREAM_STATE_INVALID');
          const found = db.prepare('SELECT seq FROM identities WHERE id=?').get(marker.messageId); if (!found) throw fail('BACKGROUND_STREAM_TARGET_MISSING');
          upper = found.seq; excluded = marker.messageId;
        }
        if (params.before) {
          const cursor = db.prepare('SELECT seq FROM identities WHERE id=?').get(params.before);
          if (!cursor) throw fail('INTERACTION_CURSOR_STALE'); upper = Math.min(upper, cursor.seq);
        }
        if (params.process) {
          const { messageId, turnId } = params.process;
          // A live turn ID remains a valid detail address after its public reply
          // commits. Prefer that reply so the detail retains its current anchor.
          const target = db.prepare("SELECT * FROM records WHERE id=? AND kind != 'agent_turn' AND seq < ?").get(messageId || '', upper)
            || db.prepare("SELECT * FROM records WHERE turnId=? AND kind != 'agent_turn' AND seq < ? ORDER BY seq DESC LIMIT 1").get(turnId || messageId || '', upper)
            || db.prepare('SELECT * FROM records WHERE id=? AND seq < ?').get(messageId || turnId || '', upper);
          const records = new Map();
          if (target) {
            records.set(target.seq, target);
            const turn = target.turnId ? db.prepare("SELECT * FROM records WHERE id=? AND kind='agent_turn' AND seq < ?").get(target.turnId, upper)
              : target.kind === 'agent_reply' ? db.prepare("SELECT * FROM records WHERE seq < ? AND kind IN ('user_input','agent_turn') ORDER BY seq DESC LIMIT 1").get(target.seq) : null;
            if (turn?.kind === 'agent_turn') records.set(turn.seq, turn);
          }
          const fd = openSync(file, 'r'); let messages;
          try { messages = [...records].sort((a, b) => a[0] - b[0]).map(([, record]) => {
            const size = record.end - record.start;
            if (size > 64 * 1024 * 1024) throw fail('BACKGROUND_RECORD_TOO_LARGE');
            const bytes = Buffer.alloc(size); if (readSync(fd, bytes, 0, size, record.start) !== size) throw fail('BACKGROUND_VERSION_CHANGED');
            return JSON.parse(bytes.toString('utf8'));
          }); } finally { closeSync(fd); }
          if (version(file) !== expected || version(sidecarFile) !== sidecarVersion) continue;
          return { conversationId: id, sourceVersion: expected, messages, nextCursor: null };
        }
        const context = params.context === true;
        const limit = context ? Number.MAX_SAFE_INTEGER - 1 : Math.min(100, Math.max(1, params.limit || 50));
        const selected = db.prepare(`SELECT * FROM messages WHERE seq < ? AND ${context ? "kind IN ('user_input','agent_reply')" : "(kind != 'agent_turn' OR json_array_length(json_extract(body,'$.publicUpdates')) > 0)"} ORDER BY seq DESC LIMIT ?`).all(upper, limit + 1);
        const hasOlder = selected.length > limit, page = selected.slice(0, limit).reverse();
        const rows = new Map(page.map(row => [row.seq, row]));
        if (!context) for (const row of page) if (row.kind === 'user_input') for (const linked of db.prepare('SELECT messages.* FROM links JOIN messages USING(seq) WHERE anchor=? AND messages.seq < ?').all(row.id, upper)) rows.set(linked.seq, linked);
        if (!context) for (const row of page) {
          const turnId = JSON.parse(row.body).turnId;
          if (!turnId) continue;
          const linked = db.prepare("SELECT * FROM messages WHERE id=? AND kind='agent_turn' AND seq < ?").get(turnId, upper);
          if (linked) rows.set(linked.seq, linked);
        }
        if (version(file) !== expected || version(sidecarFile) !== sidecarVersion) continue;
        const projected = [...rows].sort((a, b) => a[0] - b[0]).map(([, row]) => JSON.parse(row.body));
        const turnReferences = new Map(projected.filter(row => row.kind === 'agent_turn').map(row => [row.id, row.resourceReferences]));
        const messages = projected.map(row => {
          const refs = row.kind === 'agent_reply' && typeof row.turnId === 'string' ? turnReferences.get(row.turnId) : null;
          return refs?.length ? { ...row, resourceReferences: refs } : row;
        });
        return { conversationId: id, contentRevision: readMeta(id)?.contentRevision ?? description.contentRevision,
          sourceVersion: expected, messages,
          nextCursor: hasOlder ? page[0]?.id ?? null : null, excludedFromMessageId: excluded, requiresRuntimeCheck: true };
      } finally { db.close(); }
    }
    throw fail('BACKGROUND_VERSION_CHANGED');
  }
  return { readPage: (id, params) => read(id, params), readContext: id => read(id, { context: true }), readProcess: (id, params) => read(id, { process: params }) };
}

if (!isMainThread && workerData?.interactionRebuild) {
  try { rebuild(workerData.interactionRebuild); parentPort.postMessage({ ok: true }); }
  catch (error) { parentPort.postMessage({ ok: false, code: error.code, message: error.message }); }
}
