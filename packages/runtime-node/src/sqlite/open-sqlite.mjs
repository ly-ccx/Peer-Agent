import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function quarantine(file) {
  const dest = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(file, dest);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(file + suffix)) renameSync(file + suffix, dest + suffix);
  }
}

function connect(file, readonly) {
  const db = new DatabaseSync(file, { readOnly: readonly });
  db.exec('PRAGMA busy_timeout=3000');
  if (!readonly) db.exec('PRAGMA journal_mode=WAL');
  const row = db.prepare('PRAGMA quick_check').get();
  if (row?.quick_check !== 'ok') {
    db.close();
    throw new Error('sqlite quick_check failed');
  }
  return db;
}

/** Open a SQLite file. A corrupt database is renamed aside and replaced. */
export function openSqlite(file, { readonly = false } = {}) {
  if (!readonly) mkdirSync(path.dirname(file), { recursive: true });
  try {
    return connect(file, readonly);
  } catch (error) {
    if (readonly || !existsSync(file)) throw error;
    quarantine(file);
    return connect(file, false);
  }
}
