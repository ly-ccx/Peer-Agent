import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createProjectRegistry,
  readRemoteAliases,
} from './project-registry.mjs';

function idFor(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'peer-project-registry-'));
}

test('ensureForPath keeps the same id for the same path', () => {
  let minted = 0;
  const registry = createProjectRegistry({
    createId: () => idFor(++minted),
    now: () => new Date('2026-09-26T01:02:03.000Z'),
  });
  const first = registry.ensureForPath('/repo');
  const second = registry.ensureForPath('/repo/');
  assert.equal(second.workspaceId, first.workspaceId);
  assert.equal(minted, 1);
  assert.equal(first.realPath, '/repo');
  assert.deepEqual(first.previousPaths, []);
});

test('a symlink to the same folder reuses the id', () => {
  const dir = tempDir();
  const real = path.join(dir, 'repo');
  const link = path.join(dir, 'link');
  mkdirSync(real);
  symlinkSync(real, link);
  let minted = 0;
  const registry = createProjectRegistry({
    filePath: path.join(dir, 'registry.json'),
    createId: () => idFor(++minted),
  });
  const fromReal = registry.ensureForPath(real);
  const fromLink = registry.ensureForPath(link);
  assert.equal(fromLink.workspaceId, fromReal.workspaceId);
  assert.equal(minted, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('recordMove and relink keep the id and remember the old path', () => {
  let minted = 0;
  const registry = createProjectRegistry({
    createId: () => idFor(++minted),
  });
  const original = registry.ensureForPath('/repo');
  const moved = registry.recordMove(original.workspaceId, '/repo-next');
  assert.equal(moved.ok, true);
  assert.equal(moved.entry.workspaceId, original.workspaceId);
  assert.equal(moved.entry.path, '/repo-next');
  assert.deepEqual(moved.entry.previousPaths, ['/repo']);
  const relinked = registry.relinkWorkspace(original.workspaceId, '/repo-final');
  assert.equal(relinked.ok, true);
  assert.equal(relinked.entry.workspaceId, original.workspaceId);
  assert.deepEqual(relinked.entry.previousPaths, ['/repo', '/repo-next']);
  const reused = registry.ensureForPath('/repo-final');
  assert.equal(reused.workspaceId, original.workspaceId);
  const atOldPath = registry.ensureForPath('/repo');
  assert.notEqual(atOldPath.workspaceId, original.workspaceId);
  assert.equal(minted, 2);
});

test('a corrupt registry is backed up and rebuilt from the settings cache', () => {
  const dir = tempDir();
  const file = path.join(dir, 'registry.json');
  const id = idFor(7);
  writeFileSync(file, '{');
  const registry = createProjectRegistry({
    filePath: file,
    now: () => new Date('2026-09-26T01:02:03.000Z'),
    createId: () => { throw new Error('minted'); },
  });
  const [entry] = registry.sync([{
    id,
    path: '/repo',
    addedAt: '2026-01-01T00:00:00.000Z',
  }]);
  assert.equal(entry.workspaceId, id);
  assert.equal(entry.path, '/repo');
  assert.equal(
    readdirSync(dir).some((name) => name === 'registry.json.corrupt-2026-09-26T01-02-03.000Z'),
    true,
  );
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects[0].workspaceId, id);
  rmSync(dir, { recursive: true, force: true });
});

test('readRemoteAliases returns the stored alias and ignores a corrupt file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'registry.json');
  const registry = createProjectRegistry({
    filePath: file,
    createId: () => idFor(1),
  });
  const entry = registry.ensureForPath('/repo');
  assert.equal(registry.setRemoteAlias(entry.workspaceId, 'legacy-box').ok, true);
  assert.deepEqual(readRemoteAliases(entry.workspaceId, file), ['legacy-box']);
  writeFileSync(file, '{');
  assert.deepEqual(readRemoteAliases(entry.workspaceId, file), []);
  rmSync(dir, { recursive: true, force: true });
});
