import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from './connection.mjs';

test('SQLite connection retains transaction rollback and incremental statement iteration', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE facts (id INTEGER PRIMARY KEY, body TEXT); BEGIN IMMEDIATE;');
    db.prepare('INSERT INTO facts VALUES (?,?)').run(1, 'durable');
    db.exec('COMMIT; BEGIN IMMEDIATE;');
    db.prepare('INSERT INTO facts VALUES (?,?)').run(2, 'rolled back');
    db.exec('ROLLBACK');
    const statement = db.prepare('SELECT * FROM facts ORDER BY id');
    const rows = statement.iterate();
    assert.equal(typeof rows.next, 'function');
    assert.equal(rows.next().value.body, 'durable');
    const parallel = db.prepare('SELECT * FROM facts ORDER BY id').iterate();
    assert.equal(parallel.next().value.body, 'durable');
    assert.equal(rows.next().done, true);
    assert.equal(parallel.next().done, true);
    assert.equal(db.prepare('SELECT body FROM facts WHERE id=?').get(2), undefined);
    assert.equal(statement.all().length, 1);
  } finally { db.close(); }
});

test('SQLite readonly and corruption errors retain distinct numeric SQLite codes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-sqlite-connection-'));
  try {
    const file = path.join(root, 'facts.sqlite');
    const writable = new DatabaseSync(file);
    writable.exec('CREATE TABLE facts (id INTEGER); INSERT INTO facts VALUES (1);'); writable.close();
    const readonly = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(readonly.prepare('SELECT id FROM facts').get().id, 1);
      assert.throws(() => readonly.exec('DELETE FROM facts'), error => (error.errcode & 255) === 8);
      assert.throws(() => readonly.exec('SELECT * FROM absent'), error => (error.errcode & 255) === 1);
    } finally { readonly.close(); }
    const invalid = path.join(root, 'invalid.sqlite'); writeFileSync(invalid, 'invalid sqlite content');
    assert.throws(() => {
      let db;
      try { db = new DatabaseSync(invalid); db.exec('PRAGMA quick_check'); }
      finally { db?.close(); }
    }, error => [11, 26].includes(error.errcode & 255));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
