/** ADR25/131: one recoverable Store commit, shared with the native writer. */
import { constants as C, openSync, closeSync, readSync, writeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { withFileLock } from './conversation-file-lock.mjs';

import { USAGE_LEDGER_CONTRACT } from './usage-ledger-contract.generated.mjs';
export const USAGE_LEDGER_LIMITS = USAGE_LEDGER_CONTRACT.limits;
const amounts = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const fail = code => { throw Object.assign(Error(code), { code }); };
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const integer = value => {
  if (value == null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) fail('USAGE_LEDGER_INVALID');
  return value;
};
const sum = values => values.reduce((a, b) => integer(a + integer(b)), 0);
function validateJson(value) {
  const pending = [[value, 0]]; let nodes = 0;
  while (pending.length) {
    const [v, depth] = pending.pop();
    if (++nodes > 65536 || depth > 64) fail('USAGE_LEDGER_LIMIT');
    if (typeof v === 'string' && !v.isWellFormed()) fail('USAGE_LEDGER_INVALID');
    if (v && typeof v === 'object') for (const [key, child] of Object.entries(v)) {
      if (!key.isWellFormed()) fail('USAGE_LEDGER_INVALID'); pending.push([child, depth + 1]);
    }
  }
  return value;
}
function parse(bytes) {
  try { return validateJson(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))); }
  catch (e) { if (e.code?.startsWith('USAGE_LEDGER_')) throw e; fail('USAGE_LEDGER_INVALID'); }
}
function encode(value, max) {
  validateJson(value); const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > max) fail('USAGE_LEDGER_LIMIT');
  return bytes;
}
const version = st => [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':');
function stat(file) {
  try { const st = lstatSync(file); if (!st.isFile()) fail('USAGE_LEDGER_INVALID'); return st; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function read(file, max) {
  const before = stat(file); if (!before) return null;
  if (before.size > max) fail('USAGE_LEDGER_LIMIT');
  const fd = openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    if (version(fstatSync(fd)) !== version(before)) fail('USAGE_LEDGER_CONFLICT');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) fail('USAGE_LEDGER_CONFLICT'); offset += n; }
    if (version(stat(file) ?? {}) !== version(before)) fail('USAGE_LEDGER_CONFLICT');
    return bytes;
  } finally { closeSync(fd); }
}
function syncDirectory(file) { const fd = openSync(path.dirname(file), C.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function writeAll(fd, bytes) { let offset = 0; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (!n) fail('USAGE_LEDGER_COMMIT_UNCERTAIN'); offset += n; } }
function replace(file, bytes) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, C.O_WRONLY | C.O_CREAT | C.O_EXCL, 0o600);
  const owned=fstatSync(fd);
  try {
    try { writeAll(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    stat(file); renameSync(temporary, file); syncDirectory(file);
  } finally {
    // Failed preparation is disposable, unlike the durable intent/originals.
    // Never unlink a replacement at our temporary path.
    try { const current=stat(temporary); if (current?.dev===owned.dev && current?.ino===owned.ino) unlinkSync(temporary); } catch {}
  }
}

/** No lifetime-sized array. Keep one bounded line and the matching identity. */
export function scanUsageLedger(file, conversationId, id, prefixBytes = 0) {
  const before = stat(file), hash = createHash('sha256'), prefix = createHash('sha256');
  let found = null, length = 0, tail = Buffer.alloc(0), lastComplete = 0;
  if (before) {
    const fd = openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      if (version(fstatSync(fd)) !== version(before)) fail('USAGE_LEDGER_CONFLICT');
      const block = Buffer.alloc(65536);
      while (true) {
        const n = readSync(fd, block, 0, block.length, length); if (!n) break;
        const bytes = block.subarray(0, n); hash.update(bytes);
        prefix.update(bytes.subarray(0, Math.max(0, Math.min(n, prefixBytes - length))));
        length += n;
        let start = 0;
        for (let i = 0; i < n; i++) if (bytes[i] === 10) {
          const line = Buffer.concat([tail, bytes.subarray(start, i)]);
          if (line.length > USAGE_LEDGER_LIMITS.rowBytes) fail('USAGE_LEDGER_LIMIT');
          if (line.length && !line.every(byte => byte === 32 || byte >= 9 && byte <= 13)) {
            const row = parse(line); if (!row || Array.isArray(row) || typeof row !== 'object') fail('USAGE_LEDGER_INVALID');
            if (row.conversationId === conversationId && row.id === id) {
              if (found) fail('USAGE_LEDGER_CONFLICT'); found = row;
            }
          }
          tail = Buffer.alloc(0); start = i + 1; lastComplete = length - n + start;
        }
        tail = Buffer.concat([tail, bytes.subarray(start)]);
        if (tail.length > USAGE_LEDGER_LIMITS.rowBytes) fail('USAGE_LEDGER_LIMIT');
      }
      if (length !== before.size || version(stat(file) ?? {}) !== version(before)) fail('USAGE_LEDGER_CONFLICT');
    } finally { closeSync(fd); }
  }
  return { found, length, tail, lastComplete, sha256: hash.digest('hex'), prefixSha256: prefix.digest('hex'), version: before ? version(before) : null };
}
function append(file, bytes, expected) {
  const before = stat(file);
  if ((before ? version(before) : null) !== expected) fail('USAGE_LEDGER_CONFLICT');
  const fd = openSync(file, C.O_WRONLY | C.O_APPEND | C.O_NOFOLLOW | C.O_NONBLOCK | (expected === null ? C.O_CREAT | C.O_EXCL : 0), 0o600);
  try { const opened = fstatSync(fd); if (!opened.isFile() || expected !== null && version(opened) !== expected) fail('USAGE_LEDGER_CONFLICT'); writeAll(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncDirectory(file);
}
const counters = meta => ({ lifetimeUsage: meta.lifetimeUsage ?? null, runtimeTurnCount: meta.runtimeTurnCount ?? null });
function lifetime(meta) {
  const u = meta.lifetimeUsage ?? {};
  return { ...u, usageScope: 'conversation_lifetime', runtimeTurnCount: integer(meta.runtimeTurnCount),
    ...Object.fromEntries(amounts.map(k => [k, integer(u[k])])), totalTokens: sum(amounts.map(k => u[k])) };
}
function indexRows(file) {
  const bytes = read(file, USAGE_LEDGER_LIMITS.indexBytes);
  if (!bytes) return [];
  if (bytes.length && bytes.at(-1) !== 10) fail('USAGE_LEDGER_INVALID');
  // Decode before splitting so malformed UTF-8 can never be rewritten as U+FFFD.
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('USAGE_LEDGER_INVALID'); }
  const rows = content.split('\n').filter(s => s.trim()).map(s => parse(Buffer.from(s)));
  if (rows.length > USAGE_LEDGER_LIMITS.indexRows || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail('USAGE_LEDGER_LIMIT');
  return rows;
}

/** Existing auxiliary log writers share the append lock without owning lifetime. */
export function appendAuxiliaryUsageRecord(file, row) {
  const line = Buffer.concat([encode(row, USAGE_LEDGER_LIMITS.rowBytes - 1), Buffer.from('\n')]);
  mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(file, () => {
    const before = stat(file);
    if (before?.size) {
      const fd = openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        if (version(fstatSync(fd)) !== version(before)) fail('USAGE_LEDGER_CONFLICT');
        const last = Buffer.alloc(1); if (readSync(fd, last, 0, 1, before.size - 1) !== 1 || last[0] !== 10) fail('USAGE_LEDGER_INVALID');
      } finally { closeSync(fd); }
    }
    append(file, line, before ? version(before) : null);
    return row;
  });
}
function findMeta(rows, id) {
  const found = rows.filter(row => row.id === id);
  if (found.length > 1) fail('USAGE_LEDGER_CONFLICT');
  return found[0];
}
function validateRow(row) {
  if (!row || row.usageScope !== 'runtime_turn' || !text(row.id) || !text(row.conversationId) || integer(row.providerRequestCount) < 1) fail('USAGE_LEDGER_INVALID');
  if (row.totalTokens !== sum(amounts.map(k => row[k]))) fail('USAGE_LEDGER_INVALID');
  if (row.estimatedCostUsd != null && (typeof row.estimatedCostUsd !== 'number' || !Number.isFinite(row.estimatedCostUsd) || row.estimatedCostUsd < 0)) fail('USAGE_LEDGER_INVALID');
  encode(row, USAGE_LEDGER_LIMITS.rowBytes - 1);
}
function makeRow(id, usage, attribution) {
  if (usage?.usageScope !== 'runtime_turn') throw Object.assign(new TypeError('recordRuntimeTurnUsage requires usageScope=runtime_turn'), { code: 'USAGE_LEDGER_INVALID' });
  if (integer(usage.providerRequestCount) < 1) fail('USAGE_LEDGER_INVALID');
  const tokens = Object.fromEntries(amounts.map(k => [k, integer(usage[k])]));
  const provider = text(attribution.modelProviderId);
  const cost = attribution.estimatedCostUsd;
  if (cost != null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) fail('USAGE_LEDGER_INVALID');
  return { id: text(attribution.id) ?? `runtime_turn_${Date.now()}_${randomUUID()}`, at: text(attribution.at) ?? new Date().toISOString(), conversationId: id,
    streamId: text(attribution.streamId), modelProviderId: provider,
    groupId: text(attribution.groupId) ?? (provider?.includes('::') ? text(provider.split('::')[0]) : null),
    model: text(attribution.model), providerName: text(attribution.providerName), usageScope: 'runtime_turn', providerRequestCount: usage.providerRequestCount,
    ...tokens, totalTokens: sum(Object.values(tokens)), estimatedCostUsd: cost ?? null, pricingSource: text(attribution.pricingSource),
    ...(text(attribution.role) ? { role: text(attribution.role) } : {}), ...(text(attribution.workspaceId) ? { workspaceId: text(attribution.workspaceId) } : {}) };
}
function nextCounters(meta, row) {
  const previous = meta.lifetimeUsage ?? {}, key = row.modelProviderId ?? 'unknown';
  if (typeof previous !== 'object' || Array.isArray(previous) || previous.byModel != null && (typeof previous.byModel !== 'object' || Array.isArray(previous.byModel))) fail('USAGE_LEDGER_INVALID');
  const byModel = previous.byModel ?? {}, old = Object.hasOwn(byModel, key) ? byModel[key] : {};
  if (typeof old !== 'object' || Array.isArray(old)) fail('USAGE_LEDGER_INVALID');
  const tokens = Object.fromEntries(amounts.map(k => [k, sum([old[k], row[k]])]));
  const oldCost = old.estimatedCostUsd ?? 0;
  if (typeof oldCost !== 'number' || !Number.isFinite(oldCost) || oldCost < 0 || !Number.isFinite(oldCost + (row.estimatedCostUsd ?? 0))) fail('USAGE_LEDGER_INVALID');
  return { runtimeTurnCount: sum([meta.runtimeTurnCount, 1]), lifetimeUsage: { ...previous,
    ...Object.fromEntries(amounts.map(k => [k, sum([previous[k], row[k]])])), byModel: { ...byModel,
      [key]: { ...old, modelProviderId: key, ...(row.model || old.model ? { model: row.model || old.model } : {}),
        ...(row.providerName || old.providerName ? { providerName: row.providerName || old.providerName } : {}),
        ...tokens, totalTokens: sum(Object.values(tokens)), estimatedCostUsd: oldCost + (row.estimatedCostUsd ?? 0), requestCount: sum([old.requestCount, 1]) } } } };
}

/** Caller already owns index.jsonl.lock. Never read an intent-selected path. */
export function recordRuntimeTurnUsage({ storeDir, usageLogFile, conversationId, usage, attribution = {}, onIndexChanged = () => {} }) {
  const row = makeRow(conversationId, usage, attribution); validateRow(row);
  const transaction = path.join(storeDir, '.usage-ledger-transaction'), indexFile = path.join(storeDir, 'index.jsonl');
  mkdirSync(path.dirname(usageLogFile), { recursive: true });
  const relative = path.relative(storeDir, usageLogFile).split(path.sep).join('/');
  return withFileLock(transaction, () => withFileLock(usageLogFile, () => {
    let rows = indexRows(indexFile);
    const recover = intent => {
      if (intent.schemaVersion !== 1 || intent.ledgerRelative !== relative || !text(intent.conversationId)
        || !intent.before || !intent.after || !Number.isSafeInteger(intent.prefixBytes) || intent.prefixBytes < 0
        || !/^[a-f0-9]{64}$/.test(intent.prefixSha256) || intent.ledgerRow?.conversationId !== intent.conversationId) fail('USAGE_LEDGER_INVALID');
      validateRow(intent.ledgerRow);
      const meta = findMeta(rows, intent.conversationId); if (!meta) fail('USAGE_LEDGER_CONFLICT');
      const current = counters(meta);
      if (!isDeepStrictEqual(current, intent.before) && !isDeepStrictEqual(current, intent.after)) fail('USAGE_LEDGER_CONFLICT');
      // The saved after-image must be derived from exactly this before-image.
      if (!isDeepStrictEqual(nextCounters(intent.before, intent.ledgerRow), intent.after)) fail('USAGE_LEDGER_INVALID');
      let scan = scanUsageLedger(usageLogFile, intent.conversationId, intent.ledgerRow.id, intent.prefixBytes);
      if (scan.length < intent.prefixBytes || scan.prefixSha256 !== intent.prefixSha256) fail('USAGE_LEDGER_CONFLICT');
      if (typeof intent.ledgerLine !== 'string') fail('USAGE_LEDGER_INVALID');
      const line = Buffer.from(intent.ledgerLine);
      if (line.length > USAGE_LEDGER_LIMITS.rowBytes || line.at(-1) !== 10 || line.subarray(0, -1).includes(10)
        || !isDeepStrictEqual(parse(line.subarray(0, -1)), intent.ledgerRow)) fail('USAGE_LEDGER_INVALID');
      if (scan.found && !isDeepStrictEqual(scan.found, intent.ledgerRow)) fail('USAGE_LEDGER_CONFLICT');
      if (scan.tail.length && (scan.found || scan.lastComplete !== intent.prefixBytes || !scan.tail.equals(line.subarray(0, scan.tail.length)))) fail('USAGE_LEDGER_CONFLICT');
      if (!isDeepStrictEqual(current, intent.after)) {
        Object.assign(meta, intent.after); meta.updatedAt = new Date().toISOString();
        const body = Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
        if (body.length > USAGE_LEDGER_LIMITS.indexBytes) fail('USAGE_LEDGER_LIMIT');
        onIndexChanged(); replace(indexFile, body);
      }
      if (!scan.found) {
        if (!scan.tail.length && scan.length !== intent.prefixBytes) {
          intent.prefixBytes = scan.length; intent.prefixSha256 = scan.sha256;
          replace(transaction, encode(intent, USAGE_LEDGER_LIMITS.intentBytes));
        }
        append(usageLogFile, line.subarray(scan.tail.length), scan.version);
      }
      unlinkSync(transaction); syncDirectory(transaction);
    };
    const pending = read(transaction, USAGE_LEDGER_LIMITS.intentBytes);
    if (pending) { try { recover(parse(pending)); } catch (e) { if (e.code?.startsWith('USAGE_LEDGER_')) throw e; fail('USAGE_LEDGER_COMMIT_UNCERTAIN'); } rows = indexRows(indexFile); }
    const scan = scanUsageLedger(usageLogFile, conversationId, row.id);
    if (scan.tail.length) fail('USAGE_LEDGER_INVALID');
    const meta = findMeta(rows, conversationId); if (!meta) return null;
    if (scan.found) {
      // Existing retry callers may omit attribution. Never erase the original
      // attribution, and reject contradictory amounts or provided metadata.
      for (const key of ['id', 'conversationId', 'usageScope', 'providerRequestCount', ...amounts, 'totalTokens']) {
        if (!isDeepStrictEqual(scan.found[key], row[key])) fail('USAGE_LEDGER_CONFLICT');
      }
      for (const key of ['streamId', 'modelProviderId', 'groupId', 'model', 'providerName', 'estimatedCostUsd', 'pricingSource', 'role', 'workspaceId']) {
        if (row[key] != null && !isDeepStrictEqual(scan.found[key], row[key])) fail('USAGE_LEDGER_CONFLICT');
      }
      return { lifetimeUsage: lifetime(meta), ledgerRow: scan.found };
    }
    const intent = { schemaVersion: 1, ledgerRelative: relative, conversationId, before: counters(meta), after: nextCounters(meta, row), ledgerRow: row,
      ledgerLine: JSON.stringify(row) + '\n', prefixBytes: scan.length, prefixSha256: scan.sha256 };
    replace(transaction, encode(intent, USAGE_LEDGER_LIMITS.intentBytes));
    try { recover(intent); } catch (e) { if (e.code?.startsWith('USAGE_LEDGER_')) throw e; fail('USAGE_LEDGER_COMMIT_UNCERTAIN'); }
    return { lifetimeUsage: lifetime(meta), ledgerRow: row };
  }));
}
