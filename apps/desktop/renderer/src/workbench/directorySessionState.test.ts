import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_DIRECTORY_SESSION, directoryAbsolute, directoryRelative, normalizeDirectorySession, normalizeDirectorySessionMap,
  rememberDirectoryReading, restoreDirectoryTree, type DirectoryReading } from './directorySessionState.ts';
const reading = (patch: Partial<DirectoryReading> = {}): DirectoryReading => ({ root: '/project', expanded: ['.', 'src', 'src/ui'],
  selected: 'src/ui/view.ts', filter: 'view', top: 240, left: 8, ...patch });

test('legacy directory settings remain empty and Bots and roots have independent reading metadata', () => {
  assert.deepEqual(normalizeDirectorySession(undefined), EMPTY_DIRECTORY_SESSION);
  const A = rememberDirectoryReading(EMPTY_DIRECTORY_SESSION, reading());
  const B = rememberDirectoryReading(EMPTY_DIRECTORY_SESSION, reading({ root: '/other', filter: '' }));
  const restored = normalizeDirectorySessionMap(JSON.parse(JSON.stringify({ A, B })));
  assert.equal(restored.A.readings[0].filter, 'view'); assert.equal(restored.B.readings[0].root, '/other');
  assert.equal(rememberDirectoryReading(A, reading({ root: '/knowledge' })).readings.length, 2);
});

test('restoration metadata is bounded and rejects traversal, coordinates and runtime facts', () => {
  const raw = { source: 'Peer-Knowledge', readings: [reading({ expanded: ['../escape', '/abs', 'x/../y', 'C:/escape', 'safe', 'a\\b'],
    selected: '../private', top: Infinity, left: -3, filter: 'a'.repeat(300) }), { root: '\0bad' }], permissionGrant: true, entries: ['secret'] };
  const normalized = normalizeDirectorySession(raw);
  assert.deepEqual(normalized.readings[0].expanded, ['safe']); assert.equal(normalized.readings[0].selected, null);
  assert.equal(normalized.readings[0].filter.length, 256); assert.equal(normalized.readings[0].top, 0); assert.equal(normalized.readings[0].left, 0);
  assert.equal('permissionGrant' in normalized, false); assert.equal('entries' in normalized, false);
  assert.equal(normalizeDirectorySession({ readings: Array.from({ length: 25 }, (_, i) => reading({ root: `/p${i}` })) }).readings.length, 12);
  assert.equal(normalizeDirectorySession({ readings: [reading({ expanded: Array.from({ length: 100 }, (_, i) => `d${i}`) })] }).readings[0].expanded.length, 64);
  assert.equal(directoryRelative('/project', '/project-other/secret'), null);
  assert.equal(directoryRelative('/project', '/project/../secret'), null);
  assert.equal(directoryAbsolute('/project', 'src'), '/project/src');
});

test('only freshly confirmed reachable directory branches are restored, without opening selected files', async () => {
  const calls: string[] = [];
  const dirs: Record<string, readonly { absPath: string; isDir: boolean }[]> = {
    '/project': [{ absPath: '/project/src', isDir: true }, { absPath: '/project/not-a-folder', isDir: false }, { absPath: '/other/escape', isDir: true }],
    '/project/src': [{ absPath: '/project/src/ui', isDir: true }],
    '/project/src/ui': [{ absPath: '/project/src/ui/view.ts', isDir: false }],
  };
  const result = await restoreDirectoryTree('/project', reading({ expanded: ['src', 'src/ui', 'deleted', 'not-a-folder', '../escape'] }),
    async path => { calls.push(path); return dirs[path] ?? []; }, () => true);
  assert.deepEqual(calls, ['/project', '/project/src', '/project/src/ui']);
  assert.equal(result?.selected, '/project/src/ui/view.ts'); assert.equal(result?.selectedIsDir, false);
  assert.deepEqual([...result!.expanded], calls);
});

test('root relocation, missing branches, failure and late results do not invent a successful recovery', async () => {
  let calls = 0;
  const relocated = await restoreDirectoryTree('/relocated', reading(), async () => { calls++; return []; }, () => true);
  assert.equal(calls, 1); assert.equal(relocated?.selected, null); assert.equal(relocated?.expanded.size, 1);
  assert.equal(await restoreDirectoryTree('/project', reading(), async () => { throw Error('permission_denied'); }, () => true), null);
  assert.equal(await restoreDirectoryTree('/project', reading(), async () => { throw Error('must not read'); }, () => false), null);
  let current = true;
  assert.equal(await restoreDirectoryTree('/project', reading(), async () => { current = false; return []; }, () => current), null);
});

test('collapsed ancestors do not trigger descendant scans and expansion has a read budget', async () => {
  const calls: string[] = [];
  await restoreDirectoryTree('/project', reading({ expanded: ['hidden/child'] }), async path => { calls.push(path); return [{ absPath: '/project/hidden', isDir: true }]; }, () => true);
  assert.deepEqual(calls, ['/project']);
  let count = 0;
  const expanded = Array.from({ length: 100 }, (_, i) => `d${i}`);
  await restoreDirectoryTree('/project', reading({ expanded }), async path => {
    count++; return path === '/project' ? expanded.map(p => ({ absPath: `/project/${p}`, isDir: true })) : [];
  }, () => true);
  assert.equal(count <= 65, true);
});

test('task directory metadata keeps the exact plan binding and malformed task references cannot fall back to Bot scope', () => {
  const task = { sessionId: 'work', planId: 'plan' };
  const session = normalizeDirectorySession({ source: '/isolate', task, readings: [reading({ task })] });
  assert.deepEqual(session.task, task); assert.deepEqual(session.readings[0].task, task);
  const mixed = rememberDirectoryReading(rememberDirectoryReading(EMPTY_DIRECTORY_SESSION, reading()), reading({ task }));
  assert.equal(mixed.readings.length, 2);
  const invalid = normalizeDirectorySession({ source: '/isolate', task: { sessionId: 'work' }, readings: [reading({ task: {} as any })] });
  assert.equal(normalizeDirectorySession({ source: 'images', relativeTo: 42 }).invalidSource, true);
  assert.equal(normalizeDirectorySession({ source: 'images', relativeTo: '/synthetic/docs/guide.md' }).relativeTo, '/synthetic/docs/guide.md');
  assert.equal(invalid.invalidSource, true); assert.equal(invalid.readings.length, 0); assert.equal(invalid.task, undefined);
});
