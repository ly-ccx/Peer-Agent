const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function phrase(term) {
  return `"${term.replaceAll('"', '""')}"`;
}

function likePattern(term) {
  return `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function parseMeta(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function createFtsIndex({ db, name }) {
  if (!NAME.test(name)) throw new TypeError('fts index name must be an identifier');
  const doc = `${name}_doc`;
  const fts = `${name}_fts`;
  db.exec(`CREATE TABLE IF NOT EXISTS ${doc} (
    id TEXT PRIMARY KEY, body TEXT NOT NULL, meta TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(id UNINDEXED, body, tokenize='trigram');`);
  const writeDoc = db.prepare(`INSERT INTO ${doc} (id, body, meta, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET body=excluded.body, meta=excluded.meta, updated_at=excluded.updated_at`);
  const deleteFts = db.prepare(`DELETE FROM ${fts} WHERE id = ?`);
  const insertFts = db.prepare(`INSERT INTO ${fts} (id, body) VALUES (?, ?)`);
  const deleteDoc = db.prepare(`DELETE FROM ${doc} WHERE id = ?`);
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM ${doc}`);
  const likeStmt = db.prepare(`SELECT id FROM ${doc} WHERE body LIKE ? ESCAPE '\\'`);
  const matchStmt = db.prepare(`SELECT id FROM ${fts} WHERE ${fts} MATCH ?`);

  function put(id, body, meta, updatedAt) {
    const key = String(id);
    const text = body == null ? '' : String(body);
    writeDoc.run(key, text, typeof meta === 'string' ? meta : JSON.stringify(meta ?? null), updatedAt);
    deleteFts.run(key);
    if (text) insertFts.run(key, text);
  }

  function idsFor(term) {
    if (term.length < 3) return likeStmt.all(likePattern(term)).map((row) => row.id);
    try {
      return matchStmt.all(phrase(term)).map((row) => row.id);
    } catch {
      return [];
    }
  }

  return {
    upsert(id, body, meta) {
      put(id, body, meta, Date.now());
    },
    remove(id) {
      const key = String(id);
      deleteDoc.run(key);
      deleteFts.run(key);
    },
    search(query, { limit = 20 } = {}) {
      const terms = String(query ?? '').trim().split(/\s+/).filter(Boolean);
      const cap = Number(limit);
      if (!terms.length || !(cap > 0)) return [];
      let ids = null;
      for (const term of terms) {
        const found = new Set(idsFor(term));
        ids = ids ? new Set([...ids].filter((id) => found.has(id))) : found;
        if (!ids.size) return [];
      }
      const list = [...ids];
      const rows = db.prepare(
        `SELECT id, body, meta, updated_at AS updatedAt FROM ${doc} WHERE id IN (${list.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT ?`,
      ).all(...list, cap);
      return rows.map((row) => ({ ...row, meta: parseMeta(row.meta) }));
    },
    rebuild(items) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`DELETE FROM ${doc}; DELETE FROM ${fts};`);
        const now = Date.now();
        for (const item of items) put(item.id, item.body, item.meta, now);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    count() {
      return Number(countStmt.get().n);
    },
  };
}
