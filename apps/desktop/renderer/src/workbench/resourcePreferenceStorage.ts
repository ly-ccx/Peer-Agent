import { normalizeResourcePreferences, type ResourceWorkspacePreferences } from './resourceWorkspaceState.ts';
import { normalizeResourceRecentReference } from '@peer-agent/protocol';
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
const key = (owner: string) => `peer.resource-workspace.v1:${owner}`;
const empty = () => normalizeResourcePreferences(null);
const size = (body: string) => new TextEncoder().encode(body).byteLength <= 256 * 1024;
function compatible(raw: unknown): raw is ResourceWorkspacePreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (Object.keys(raw).some(field => !['order', 'recent'].includes(field))) return false;
  const value = raw as Record<string, unknown>;
  const list = (items: unknown, limit: number, recent = false) => items === undefined || Array.isArray(items) && items.length <= limit && items.every(item => {
    if (typeof item !== 'string' || item.length >= 8192 || item.startsWith('interactive:')) return false;
    if (/^(document|browser|conversation):/.test(item) || item === 'comparison:workspace' || item === 'launcher') return true;
    if (!recent) return false;
    try { const descriptor = normalizeResourceRecentReference(JSON.parse(item)); return !!descriptor && descriptor.kind !== 'interactive'; } catch { return false; }
  });
  return list(value.order, 200) && list(value.recent, 16, true) && size(JSON.stringify(raw));
}

/** Legacy layout adapter. New result references never enter an old writer's record. */
export function readLegacyResourcePreferences(owner: string | null, storage: StoragePort = localStorage) {
  if (!owner) return { value: empty(), valid: true };
  try {
    const body = storage.getItem(key(owner)); if (body === null) return { value: empty(), valid: true };
    if (!size(body)) return { value: empty(), valid: false };
    const raw = JSON.parse(body), valid = compatible(raw);
    return { value: valid ? normalizeResourcePreferences(raw) : empty(), valid };
  } catch { return { value: empty(), valid: false }; }
}
export function writeLegacyResourcePreferences(owner: string, value: ResourceWorkspacePreferences, storage: StoragePort = localStorage) {
  try {
    if (!readLegacyResourcePreferences(owner, storage).valid || !compatible(value)) return false;
    const body = JSON.stringify(normalizeResourcePreferences(value));
    storage.setItem(key(owner), body); return true;
  } catch { return false; }
}
