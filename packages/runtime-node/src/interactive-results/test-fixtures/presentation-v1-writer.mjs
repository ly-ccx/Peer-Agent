// Frozen presentation writer from 518420a4a89fce6be8b62fe1faa7727121094341.
// Original source SHA-256: b47e90c08781b11f2784018b1be70cb96936dbbb4fcaab7189144f441caaff9d
// Only module import locations are adapted; layout policy is frozen separately.
import { normalizeResourceLayout } from './presentation-v1-layout.mjs';
import { randomUUID } from 'node:crypto';
import { interactiveToken, normalizeInteractiveOwner, normalizeInteractiveReference,
  normalizeResourceWindowOwner, normalizeResourceWindowRequest } from '@peer-agent/protocol';
import { decode, encode, jsonDigest, problem } from '../storage.mjs';

const same = (a, b) => encode(a) === encode(b);
const copy = value => structuredClone(value);
const privateEntry = ({ sourceBinding: _binding, ...entry }) => copy(entry);
const bytes = value => Buffer.byteLength(encode(value));
const HISTORY = 'interactive-window-history', LAYOUT = 'mixed-resource-layout';
export function interactiveReadingSourceBinding(rawOwner, rawReference) {
  const owner = normalizeInteractiveOwner(rawOwner), reference = normalizeInteractiveReference(rawReference);
  if (!owner || !reference || !same(owner, reference.owner)) throw problem('interactive_scope_denied');
  return jsonDigest(['peer-interactive-reading-source-1', owner, reference]);
}

/** Versioned presentation metadata. Old Settings writers never receive or rewrite these rows. */
export function createInteractivePresentationStore({ resultStore, assertOwner, now = () => new Date().toISOString() }) {
  const storage = resultStore.storage;
  function current(raw) {
    const owner = normalizeInteractiveOwner(raw);
    if (!owner || typeof assertOwner !== 'function' || assertOwner(owner) !== true) throw problem('interactive_scope_denied');
    return owner;
  }
  function historyEntry(raw) {
    const owner = normalizeResourceWindowOwner(raw?.owner), request = normalizeResourceWindowRequest(raw?.request);
    if (!raw || Object.keys(raw).some(key => !['id', 'owner', 'request', 'savedAt', 'sourceBinding', 'title'].includes(key))
      || !interactiveToken(raw.id) || !owner || owner.task || !request || request.resource.kind !== 'interactive'
      || !same(owner, request.resource.reference.owner) || raw.sourceBinding !== interactiveReadingSourceBinding(owner, request.resource.reference)
      || typeof raw.savedAt !== 'string' || raw.savedAt.length > 40 || !Number.isFinite(Date.parse(raw.savedAt)) || bytes(raw) > 16 * 1024
      || raw.title !== undefined && (typeof raw.title !== 'string' || raw.title.length > 160 || raw.title.includes('\0'))) throw problem('interactive_presentation_corrupt');
    return { id: raw.id, owner, request, sourceBinding: raw.sourceBinding, savedAt: raw.savedAt, ...(raw.title ? { title: raw.title } : {}) };
  }
  function historyRows(owner, context = storage.connect(owner.workspaceId)) {
    const rows = context?.db.prepare('SELECT id,body FROM presentation WHERE category=? AND owner=?').all(HISTORY, encode(owner)) ?? [];
    if (rows.length > 8) throw problem('interactive_presentation_corrupt');
    return rows.map(row => { const entry = historyEntry(decode(row.body));
      if (entry.id !== row.id || !same(owner, entry.owner)) throw problem('interactive_presentation_corrupt'); return entry;
    }).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  function checkedLayout(raw) {
    const layout = normalizeResourceLayout({ order: raw?.order, recent: raw?.recent });
    if (!raw || Object.keys(raw).some(key => !['revision', 'order', 'recent', 'updatedAt'].includes(key)) || !layout
      || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || typeof raw.updatedAt !== 'string' || raw.updatedAt.length > 40
      || !Number.isFinite(Date.parse(raw.updatedAt))) throw problem('interactive_presentation_corrupt');
    return { ...layout, revision: raw.revision, updatedAt: raw.updatedAt };
  }
  function readLayout(rawOwner) {
    const owner = current(rawOwner), context = storage.connect(owner.workspaceId);
    const row = context?.db.prepare('SELECT body FROM presentation WHERE category=? AND id=? AND owner=?').get(LAYOUT, 'current', encode(owner));
    return row ? checkedLayout(decode(row.body)) : null;
  }
  return {
    history: {
      list(rawOwner) {
        try { const owner = current(rawOwner); return { ok: true, status: 'ok', entries: historyRows(owner).map(privateEntry) }; }
        catch (error) { return { ok: false, status: error.code === 'interactive_scope_denied' ? 'scope_denied' : 'storage_unavailable', entries: [] }; }
      },
      find(id, rawOwner) { const owner = current(rawOwner); if (!interactiveToken(id)) return null; return copy(historyRows(owner).find(entry => entry.id === id) ?? null); },
      save(context, scope, recoveryId) {
        const owner = current(context?.owner), request = normalizeResourceWindowRequest({ resource: context.resource,
          ...(context.sourceTabId ? { sourceTabId: context.sourceTabId } : {}), ...(context.navigation ? { navigation: context.navigation } : {}) });
        if (!request || request.resource.kind !== 'interactive' || !same(owner, request.resource.reference.owner) || !same(owner, scope?.owner)
          || !same(scope.resource, context.resource)) throw problem('interactive_scope_denied');
        const fixed = resultStore.getVersion(request.resource.reference);
        const entry = historyEntry({ id: recoveryId ?? `interactive-${randomUUID()}`, owner, request, savedAt: now(),
          title: fixed.content.title,
          sourceBinding: interactiveReadingSourceBinding(owner, request.resource.reference) });
        return storage.transaction(owner.workspaceId, db => {
          current(owner);
          const previous = historyRows(owner, db), old = previous.find(row => row.id === entry.id);
          if (old && !same(old.request.resource, entry.request.resource)) throw problem('interactive_presentation_conflict');
          db.db.prepare('INSERT INTO presentation VALUES(?,?,?,?) ON CONFLICT(category,id,owner) DO UPDATE SET body=excluded.body')
            .run(HISTORY, entry.id, encode(owner), encode(entry));
          const keep = new Set([entry.id, ...previous.filter(row => row.id !== entry.id).slice(0, 7).map(row => row.id)]);
          for (const row of previous) if (!keep.has(row.id)) db.db.prepare('DELETE FROM presentation WHERE category=? AND id=? AND owner=?').run(HISTORY, row.id, encode(owner));
          current(owner); return entry.id;
        });
      },
      remove(id, rawOwner) {
        const owner = current(rawOwner); if (!interactiveToken(id) || !historyRows(owner).some(entry => entry.id === id)) return false;
        return storage.transaction(owner.workspaceId, context => {
          current(owner); const result = context.db.prepare('DELETE FROM presentation WHERE category=? AND id=? AND owner=?').run(HISTORY, id, encode(owner));
          return Number(result.changes) === 1;
        });
      },
    },
    readLayout,
    writeLayout(rawOwner, { expectedRevision, order, recent }) {
      const owner = current(rawOwner), layout = normalizeResourceLayout({ order, recent });
      if (!layout || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw problem('interactive_layout_invalid');
      // A dormant feature must not create a private domain during ordinary file navigation.
      const existing = storage.connect(owner.workspaceId);
      const published = existing?.db.prepare("SELECT v.metadata FROM versions v JOIN operations o ON o.id=json_extract(v.metadata,'$.operationId') WHERE v.owner=? AND v.availability='available' AND o.phase='published' LIMIT 1").get(encode(owner));
      if (!published) throw problem('interactive_presentation_unavailable');
      resultStore.getVersion(decode(published.metadata).reference);
      return storage.transaction(owner.workspaceId, context => {
        current(owner);
        const before = readLayout(owner);
        if ((before?.revision ?? 0) !== expectedRevision) throw problem('interactive_layout_conflict');
        const next = checkedLayout({ ...layout, revision: expectedRevision + 1, updatedAt: now() });
        context.db.prepare('INSERT INTO presentation VALUES(?,?,?,?) ON CONFLICT(category,id,owner) DO UPDATE SET body=excluded.body')
          .run(LAYOUT, 'current', encode(owner), encode(next));
        current(owner); return copy(next);
      });
    },
  };
}
