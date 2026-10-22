import { createRequire } from 'node:module';

const sqliteRequire = createRequire(import.meta.url);
const sqliteIsBun = Boolean(process.versions.bun);
const SqliteEngine = sqliteIsBun ? sqliteRequire('bun:sqlite').Database : sqliteRequire('node:sqlite').DatabaseSync;

function sqliteError(error) {
  if (error && error.errcode === undefined && Number.isInteger(error.errno)) error.errcode = error.errno;
  return error;
}

/** Synchronous connection seam: readonly, incremental rows and SQLite error codes. */
export const DatabaseSync = sqliteIsBun ? class {
  constructor(file, { readOnly = false } = {}) {
    try { this.connection = new SqliteEngine(file, { readonly: readOnly, create: !readOnly, strict: true }); }
    catch (error) { throw sqliteError(error); }
    this.statements = new Set();
  }
  exec(sql) {
    try { return this.connection.exec(sql); } catch (error) { throw sqliteError(error); }
  }
  prepare(sql) {
    const create = () => {
      try { const statement = this.connection.prepare(sql); this.statements.add(statement); return statement; }
      catch (error) { throw sqliteError(error); }
    };
    const release = statement => { this.statements.delete(statement); statement.finalize(); };
    // Bun 1.2 does not finalize uncached prepared statements when closing.
    // Retain only live handles; a long journal must not retain one per row.
    let initial = create();
    const take = () => { const statement = initial || create(); initial = null; return statement; };
    const invoke = (method, args) => {
      const statement = take();
      try { return statement[method](...args); } catch (error) { throw sqliteError(error); }
      finally { release(statement); }
    };
    return {
      run: (...args) => invoke('run', args),
      get: (...args) => invoke('get', args) ?? undefined,
      all: (...args) => invoke('all', args),
      *iterate(...args) {
        const statement = take();
        try { yield* statement.iterate(...args); } catch (error) { throw sqliteError(error); }
        finally { release(statement); }
      },
    };
  }
  close() {
    try {
      for (const statement of this.statements) statement.finalize();
      this.statements.clear(); this.connection.close(true);
    } catch (error) { throw sqliteError(error); }
  }
} : SqliteEngine;
