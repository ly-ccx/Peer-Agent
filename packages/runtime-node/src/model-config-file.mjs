// Shared configuration ownership; no credential, model or execution authority.
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;
export const MODEL_OAUTH_HINT_FIELDS = Object.freeze(['oauthConfigured', 'oauthExpires', 'oauthAccountId']);
export function modelConfigBinding(value) {
  const operational = { ...value };
  for (const field of MODEL_OAUTH_HINT_FIELDS) delete operational[field];
  // Retain all other ordering, including case-overlapping custom HTTP headers.
  return JSON.stringify(operational);
}
const owners = new Map();
const pause = new Int32Array(new SharedArrayBuffer(4));
/** @param {string} code @returns {never} */
function fail(code) { throw new Error(code); }
const stamp = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const identity = file => {
  try {
    const s = lstatSync(file, { bigint: true });
    if (!s.isFile() && !s.isDirectory()) fail('model_config_file_invalid');
    return stamp(s);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const revision = (id, bytes) => `${createHash('sha256').update(id === null ? 'missing\n' : `${id}\n`).digest('hex')}:${createHash('sha256').update(bytes).digest('hex')}`;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const canonicalFile = file => path.join(realpathSync(path.dirname(file)), path.basename(file));
function checkJsonBudget(content) {
  // Count source values before JSON.parse, including overwritten duplicate
  // members, matching Rust's bounded decoder rather than only the final tree.
  const tokens = /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]]/g;
  let nodes=0,depth=0;
  for (const token of content.matchAll(tokens)) {
    const text=token[0];
    if (text==='}' || text===']') { depth--; continue; }
    if (text.startsWith('"') && /^\s*:/.test(content.slice(token.index + text.length))) continue;
    if (++nodes>16384 || depth>32) fail('model_config_limit');
    if (text==='{' || text==='[') depth++;
  }
}
function validate(value) {
  let nodes = 0;
  const visit = (v, depth) => {
    if (++nodes > 16384 || depth > 32) fail('model_config_limit');
    if (v && typeof v === 'object') for (const child of Object.values(v)) visit(child, depth + 1);
  };
  visit(value, 0);
  if (record(value) && value.version !== undefined && value.version !== 2) fail('model_config_version_unsupported');
  const arrays = Array.isArray(value) ? [value]
    : record(value) && Array.isArray(value.channels) && Array.isArray(value.models) ? [value.channels, value.models]
    : record(value) && value.version === undefined && Array.isArray(value.providers) ? [value.providers] : null;
  if (!arrays || arrays.some(rows => rows.some(row => !record(row)))) fail('model_config_invalid');
  return value;
}
export function readModelConfigFile(file) {
  const id = identity(file);
  if (id === null) return { value: { version: 2, channels: [], models: [] }, revision: revision(null, ''), content: null };
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    if (stamp(stat) !== id) fail('model_config_changed');
    if (!stat.isFile()) fail('model_config_file_invalid');
    if (stat.size > BigInt(MAX_BYTES)) fail('model_config_limit');
    // Bound the read even if an uncooperative writer grows this open file.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const count = readFileBounded(fd, bytes);
    if (count > MAX_BYTES) fail('model_config_limit');
    if (identity(file) !== id) fail('model_config_changed');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count)); }
    catch { fail('model_config_invalid'); }
    checkJsonBudget(content);
    let value;
    try { value = JSON.parse(content); } catch { fail('model_config_invalid'); }
    return { value: validate(value), revision: revision(id, bytes.subarray(0, count)), content };
  } finally { if (fd !== undefined) closeSync(fd); }
}
// readFileSync(fd) is unbounded if the file grows after stat.
function readFileBounded(fd, bytes) {
  let used = 0;
  while (used < bytes.length) {
    const count = readSync(fd, bytes, used, bytes.length - used, null);
    if (!count) break;
    used += count;
  }
  return used;
}
export function withModelConfigLock(file, action, { timeoutMs = 1000 } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const canonical = canonicalFile(file);
  const lock = `${canonical}.lock`;
  const existing = owners.get(canonical);
  const ownershipError = owner => fail(owner.committed ? 'model_config_commit_unknown' : 'model_config_lock_changed');
  const check = owner => {
    let current;
    try { current=identity(lock); } catch { ownershipError(owner); }
    if (current !== owner.id) ownershipError(owner);
  };
  if (existing) { check(existing); return action(); }
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (performance.now() >= deadline) fail('model_config_lock_busy');
      let current;
      try { current=lstatSync(lock); }
      catch (inspectError) {
        if (inspectError.code==='ENOENT') continue; // Owner released after mkdir.
        throw inspectError;
      }
      if (!current.isDirectory() || current.isSymbolicLink()) fail('model_config_lock_invalid');
      Atomics.wait(pause, 0, 0, Math.min(5, Math.max(0, deadline - performance.now())));
    }
  }
  const owner = {id: identity(lock), committed: false};
  if (owner.id===null) fail('model_config_lock_changed');
  owners.set(canonical, owner);
  try {
    const result = action();
    if (result && typeof result.then === 'function') fail('model_config_async_transaction');
    check(owner);
    return result;
  } finally {
    owners.delete(canonical);
    check(owner); // Never remove a replacement owner or an unknown lock body.
    try { rmdirSync(lock); } catch { ownershipError(owner); }
  }
}
export function replaceModelConfigFile(file, expected, value) {
  return withModelConfigLock(file, () => {
    validate(value);
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    if (bytes.length > MAX_BYTES) fail('model_config_limit');
    if (readModelConfigFile(file).revision !== expected) fail('model_config_changed');
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    let fd, renamed = false;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      if (readModelConfigFile(file).revision !== expected) fail('model_config_changed');
      renameSync(temporary, file); renamed = true;
      owners.get(canonicalFile(file)).committed = true;
      fd = openSync(path.dirname(file), 'r'); fsyncSync(fd); closeSync(fd); fd = undefined;
      return readModelConfigFile(file);
    } catch (error) { if (renamed) fail('model_config_commit_unknown'); throw error; }
    finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  });
}
