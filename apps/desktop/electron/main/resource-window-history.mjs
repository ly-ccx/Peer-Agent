import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeResourceWindowOwner, normalizeResourceWindowRequest } from '@peer-agent/protocol';

const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
export const resourceWindowSourceBinding = scope => digest(['peer-reading-source-v1', scope.owner, scope.root, scope.target]);
const token = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value) && !value.includes('..');
const publicEntry = ({ sourceBinding: _private, ...entry }) => structuredClone(entry);
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['id', 'owner', 'request', 'savedAt', 'sourceBinding'].includes(key))) return null;
  const owner = normalizeResourceWindowOwner(raw.owner), request = normalizeResourceWindowRequest(raw.request);
  if (!token(raw.id) || !owner || !request || request.resource.reference.workspaceId !== owner.workspaceId
    || !isDeepStrictEqual(request.resource.reference.task, owner.task)
    || !/^sha256:[a-f0-9]{64}$/.test(raw.sourceBinding) || typeof raw.savedAt !== 'string' || raw.savedAt.length > 40 || !Number.isFinite(Date.parse(raw.savedAt)) || Buffer.byteLength(JSON.stringify(raw)) > 16 * 1024) return null;
  return { id: raw.id, owner, request, sourceBinding: raw.sourceBinding, savedAt: new Date(raw.savedAt).toISOString() };
}

/** Reading metadata in the existing SettingsStore, never content or an access grant. */
export function createResourceWindowHistory({ read = () => undefined, write = () => {}, createId = randomUUID, now = () => new Date().toISOString() } = {}) {
  function load() {
    const raw = read();
    if (raw === undefined) return [];
    if (!raw || raw.version !== 1 || Object.keys(raw).some(key => !['version', 'entries'].includes(key)) || !Array.isArray(raw.entries) || raw.entries.length > 24 || Buffer.byteLength(JSON.stringify(raw)) > 256 * 1024) throw Error('storage_unavailable');
    const entries = raw.entries.map(normalize);
    if (entries.some(entry => !entry) || new Set(entries.map(entry => entry.id)).size !== entries.length) throw Error('storage_unavailable');
    return entries;
  }
  return {
    list(owner) { try { return { ok: true, status: 'ok', entries: load().filter(entry => entry.owner.workspaceId === owner.workspaceId && entry.owner.conversationId === owner.conversationId).map(publicEntry) }; }
      catch { return { ok: false, status: 'storage_unavailable', entries: [] }; } },
    find(id, owner) {
      try { return load().find(entry => entry.id === id && entry.owner.workspaceId === owner.workspaceId && entry.owner.conversationId === owner.conversationId) ?? null; } catch { return null; }
    },
    save(context, scope, recoveryId) {
      try {
        if (!isDeepStrictEqual(context.owner, scope.owner) || context.resource.reference.path !== scope.target) return null;
        const entry = normalize({ id: recoveryId ?? createId(), owner: context.owner, request: {
          resource: context.resource, ...(context.sourceTabId ? { sourceTabId: context.sourceTabId } : {}), ...(context.navigation ? { navigation: context.navigation } : {}),
        }, sourceBinding: resourceWindowSourceBinding(scope), savedAt: now() });
        if (!entry) return null;
        let entries = [entry, ...load().filter(old => old.id !== entry.id)];
        let owned = 0;
        entries = entries.filter(old => old.owner.workspaceId !== entry.owner.workspaceId || ++owned <= 8).slice(0, 24);
        if (Buffer.byteLength(JSON.stringify({ version: 1, entries })) > 256 * 1024) return null;
        write({ version: 1, entries }); return entry.id;
      } catch { return null; }
    },
    remove(id, owner) {
      try { const entries = load();
        if (!entries.some(entry => entry.id === id && entry.owner.workspaceId === owner.workspaceId && entry.owner.conversationId === owner.conversationId)) return false;
        write({ version: 1, entries: entries.filter(entry => !(entry.id === id && entry.owner.workspaceId === owner.workspaceId && entry.owner.conversationId === owner.conversationId)) }); return true; }
      catch { return false; }
    },
  };
}
