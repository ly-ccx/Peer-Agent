import type { BotDocumentReference } from '@peer-agent/protocol';
/** Reading metadata only. Paths never grant access; the host re-resolves every source. */
export interface DirectoryReading {
  readonly task?: BotDocumentReference['task'];
  readonly root: string;
  readonly expanded: readonly string[];
  readonly selected: string | null;
  readonly filter: string;
  readonly top: number;
  readonly left: number;
}
export interface DirectorySession {
  readonly invalidSource?: true;
  readonly relativeTo?: string;
  readonly task?: BotDocumentReference['task'];
  readonly source: string;
  readonly readings: readonly DirectoryReading[];
}
export type DirectorySessionMap = Record<string, DirectorySession>;
export const EMPTY_DIRECTORY_SESSION: DirectorySession = { source: '.', readings: [] };
const MAX_BRANCHES = 64;
const MAX_DEPTH = 16;
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
}
export function directoryRelativePath(value: unknown): string | null {
  if (value === '.') return '.';
  if (!text(value, 4096) || value.includes('\\') || value.startsWith('/')) return null;
  const parts = value.split('/');
  return parts.length <= MAX_DEPTH && parts.every(p => p && p !== '.' && p !== '..' && !p.includes(':')) ? value : null;
}
export function directoryRelative(root: string, path: string): string | null {
  const base = root.replace(/\\/g, '/').replace(/\/$/, '');
  const target = path.replace(/\\/g, '/').replace(/\/$/, '');
  return target === base ? '.' : target.startsWith(`${base}/`) ? directoryRelativePath(target.slice(base.length + 1)) : null;
}
export function directoryAbsolute(root: string, path: string): string {
  return path === '.' ? root : `${root.replace(/[/\\]$/, '')}/${path}`;
}
export function normalizeDirectoryTask(raw: unknown): BotDocumentReference['task'] {
  if (!raw || typeof raw !== 'object') return;
  const v = raw as Record<string, unknown>;
  if (text(v.sessionId, 512) && text(v.planId, 512)) return { sessionId: v.sessionId, planId: v.planId };
}
export function directoryReadingKey(reading: Pick<DirectoryReading, 'root' | 'task'>): string {
  return JSON.stringify([reading.root, reading.task?.sessionId, reading.task?.planId]);
}
function coordinate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(10_000_000, Math.max(0, value)) : 0;
}
export function normalizeDirectoryReading(raw: unknown): DirectoryReading | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (!text(v.root, 4096) || v.task !== undefined && !normalizeDirectoryTask(v.task)) return null;
  const expanded = [...new Set((Array.isArray(v.expanded) ? v.expanded : []).slice(0, MAX_BRANCHES).map(directoryRelativePath).filter((p): p is string => p !== null))];
  return { root: v.root, ...(normalizeDirectoryTask(v.task) ? { task: normalizeDirectoryTask(v.task) } : {}), expanded, selected: directoryRelativePath(v.selected),
    filter: typeof v.filter === 'string' ? v.filter.slice(0, 256) : '', top: coordinate(v.top), left: coordinate(v.left) };
}
export function normalizeDirectorySession(raw: unknown): DirectorySession {
  if (!raw || typeof raw !== 'object') return EMPTY_DIRECTORY_SESSION;
  const v = raw as Record<string, unknown>;
  const readings = (Array.isArray(v.readings) ? v.readings : []).slice(-12).map(normalizeDirectoryReading).filter((r): r is DirectoryReading => r !== null);
  return { source: text(v.source, 4096) ? v.source : '.',
    ...(v.invalidSource === true || v.task !== undefined && !normalizeDirectoryTask(v.task)
      || v.relativeTo !== undefined && !text(v.relativeTo, 8192) ? { invalidSource: true as const } : {}),
    ...(normalizeDirectoryTask(v.task) ? { task: normalizeDirectoryTask(v.task) } : {}),
    ...(text(v.relativeTo, 8192) ? { relativeTo: v.relativeTo } : {}),
    readings: [...new Map(readings.map(r => [directoryReadingKey(r), r])).values()] };
}
export function normalizeDirectorySessionMap(raw: unknown): DirectorySessionMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([key]) => text(key, 512) && !['__proto__', 'constructor', 'prototype'].includes(key))
    .map(([key, value]) => [key, normalizeDirectorySession(value)]));
}
export function rememberDirectoryReading(session: DirectorySession, reading: DirectoryReading): DirectorySession {
  const normalized = normalizeDirectoryReading(reading);
  if (!normalized) return session;
  return { ...session, readings: [...session.readings.filter(r => directoryReadingKey(r) !== directoryReadingKey(normalized)), normalized].slice(-12) };
}
export class DirectoryRecoveryError extends Error {}
interface Entry { readonly absPath: string; readonly isDir: boolean }
/** Only walk saved expanded branches that a freshly read parent actually contains. */
export async function restoreDirectoryTree(root: string, reading: DirectoryReading | undefined,
  read: (path: string) => Promise<readonly Entry[]>, current: () => boolean) {
  if (!current()) return null;
  const requested = new Set(reading?.root === root ? reading.expanded.slice(0, MAX_BRANCHES) : []);
  const expanded = new Set([root]);
  const reachable = new Map<string, boolean>([['.', true]]);
  const queue = [root];
  for (let count = 0; queue.length && count <= MAX_BRANCHES && current(); count++) {
    const path = queue.shift()!;
    let entries: readonly Entry[];
    try { entries = await read(path); } catch { return null; }
    if (!current()) return null;
    for (const entry of entries) {
      const relative = directoryRelative(root, entry.absPath);
      // A malformed or escaped child must not become a restoration target.
      const parent = entry.absPath.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
      if (!relative || parent !== path.replace(/\\/g, '/').replace(/\/$/, '')) continue;
      reachable.set(relative, entry.isDir);
      if (entry.isDir && requested.has(relative) && expanded.size <= MAX_BRANCHES) {
        expanded.add(entry.absPath); queue.push(entry.absPath);
      }
    }
  }
  if (!current()) return null;
  const selected = reading?.root === root && reading.selected && reachable.has(reading.selected) ? reading.selected : null;
  return { expanded, selected: selected ? directoryAbsolute(root, selected) : null, selectedIsDir: selected ? reachable.get(selected) === true : false };
}
