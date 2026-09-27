/**
 * 可丢弃的 FTS5 索引。jsonl 仍是真源；删掉索引文件后可全量重建。
 */
import { createFtsIndex } from '../sqlite/fts-index.mjs';
import { openSqlite } from '../sqlite/open-sqlite.mjs';

export function createMemoryIndex({ file }) {
  const db = openSqlite(file);
  const fts = createFtsIndex({ db, name: 'memory' });

  function row(item) {
    return {
      id: item.id,
      body: item.text ?? item.body ?? '',
      meta: item.meta ?? {
        scope: item.scope ?? null,
        workspaceId: item.workspaceId ?? null,
        kind: item.kind ?? null,
      },
    };
  }

  return {
    upsert(item) {
      const next = row(item);
      fts.upsert(next.id, next.body, next.meta);
    },
    remove(id) {
      fts.remove(id);
    },
    search(query, { limit = 20 } = {}) {
      return fts.search(query, { limit }).map((hit) => ({
        id: hit.id,
        text: hit.body,
        meta: hit.meta,
      }));
    },
    rebuild(items) {
      fts.rebuild([...items].map(row));
    },
    close() {
      db.close();
    },
  };
}
