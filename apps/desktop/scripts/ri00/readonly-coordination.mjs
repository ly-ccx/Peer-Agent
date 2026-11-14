import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolveDestination } from './identity.mjs';
import { fileURLToPath } from 'node:url';

/** Diagnostic child only. Deny source writes before loading any production SQLite consumer. */
export function guardReadOnlySource(root) {
  const protectedRoots = (Array.isArray(root)?root:[root]).map(value=>fs.realpathSync(value));
  const within = value => {
    if (value instanceof URL) value = fileURLToPath(value);
    if (Buffer.isBuffer(value)) value = value.toString('utf8');
    if (typeof value !== 'string') return false;
    const canonical = resolveDestination(value);
    return protectedRoots.some(protectedRoot=>canonical===protectedRoot||canonical.startsWith(protectedRoot+path.sep));
  };
  const sqlite = createRequire(import.meta.url)('node:sqlite'), Native = sqlite.DatabaseSync;
  const restores = [], state = { sourceWritesDenied: 0, sqliteConnections: 0, guardChecks: 0, guardCheckMs: 0 };
  const deny = () => { state.sourceWritesDenied++; throw new Error('ri00_source_write_forbidden'); };
  const ReadOnly = class extends Native {
    constructor(file, options = {}) { super(file, { ...options, readOnly: true }); state.sqliteConnections++; }
  };
  sqlite.DatabaseSync = ReadOnly;
  restores.push(() => { if (sqlite.DatabaseSync !== ReadOnly) throw new Error('sqlite_guard_owner_changed'); sqlite.DatabaseSync = Native; });
  for (const key of ['mkdirSync', 'openSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'copyFileSync', 'linkSync', 'symlinkSync', 'truncateSync', 'chmodSync', 'chownSync', 'utimesSync']) {
    const original = fs[key];
    const wrapped = function (...args) {
      const started = performance.now();
      const pathArguments = ['renameSync','copyFileSync','linkSync','symlinkSync'].includes(key) ? args.slice(0,2) : args.slice(0,1);
      const protectedPath = pathArguments.some(within);
      state.guardChecks++; state.guardCheckMs += performance.now() - started;
      if (protectedPath) {
        if (key === 'mkdirSync' && fs.statSync(args[0]).isDirectory()) return undefined;
        if (key === 'openSync' && (args[1] === 'r' || args[1] === fs.constants.O_RDONLY)) return Reflect.apply(original, this, args);
        return deny();
      }
      return Reflect.apply(original, this, args);
    };
    fs[key] = wrapped;
    restores.push(() => { if (fs[key] !== wrapped) throw new Error('filesystem_guard_owner_changed'); fs[key] = original; });
  }
  syncBuiltinESMExports();
  return { state, constructor: ReadOnly, close() { for (const restore of restores.reverse()) restore(); syncBuiltinESMExports(); } };
}

export async function createReadOnlyCoordination({ moduleRoot, rootDir, workspaceId, guard }) {
  const { pathToFileURL } = await import('node:url');
  const connection = await import(pathToFileURL(path.join(moduleRoot, 'packages/runtime-node/dist/sqlite/connection.mjs')).href);
  if (connection.DatabaseSync !== guard.constructor) throw new Error('readonly_guard_not_installed_before_imports');
  const { createWorkCoordinationStore } = await import(pathToFileURL(path.join(moduleRoot, 'packages/runtime-node/dist/project-agent/work-coordination-store.mjs')).href);
  const store = createWorkCoordinationStore({ rootDir, workspaceId, formatVersion: 2, holdsLease: () => false });
  const port = Object.fromEntries(['read', 'readSnapshot', 'readLifecycleFacts', 'readWork', 'readSessionControl', 'revision', 'readSupervision', 'querySupervision']
    .filter(key => typeof store[key] === 'function').map(key => [key, store[key].bind(store)]));
  return { ...port, assertOwner() { throw new Error('ri00_source_has_no_writer_authority'); }, close: () => store.close() };
}
