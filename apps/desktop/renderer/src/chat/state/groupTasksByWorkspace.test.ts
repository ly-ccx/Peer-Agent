import assert from 'node:assert/strict';
import test from 'node:test';
import { groupTasksByWorkspace } from './groupTasksByWorkspace.ts';

test('groups tasks under matching workspace paths and keeps leftovers unassigned', () => {
  const grouped = groupTasksByWorkspace(
    [{ path: '/a' }, { path: '/b' }],
    [
      { id: '1', workspacePath: '/a' },
      { id: '2', workspacePath: '/b' },
      { id: '3', workspacePath: '/a' },
      { id: '4', workspacePath: null },
      { id: '5', workspacePath: '/missing' },
    ],
  );
  assert.deepEqual(grouped.byPath.get('/a')?.map((item) => item.id), ['1', '3']);
  assert.deepEqual(grouped.byPath.get('/b')?.map((item) => item.id), ['2']);
  assert.deepEqual(grouped.unassigned.map((item) => item.id), ['4', '5']);
});
