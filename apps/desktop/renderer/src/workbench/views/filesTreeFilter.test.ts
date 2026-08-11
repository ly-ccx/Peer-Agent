import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterVisibleEntries, sanitizeNewEntryName } from './filesTreeFilter.ts';

describe('filesTreeFilter', () => {
  it('returns all entries for empty query', () => {
    const entries = [
      { name: 'src', isDir: true, absPath: '/ws/src' },
      { name: 'README.md', isDir: false, absPath: '/ws/README.md' },
    ];
    assert.deepEqual(filterVisibleEntries(entries, '  '), entries);
  });

  it('keeps name hits and ancestor dirs of hits', () => {
    const children = new Map([
      [
        '/ws/src',
        [
          { name: 'app.ts', isDir: false, absPath: '/ws/src/app.ts' },
          { name: 'util.ts', isDir: false, absPath: '/ws/src/util.ts' },
        ],
      ],
    ]);
    const entries = [
      { name: 'src', isDir: true, absPath: '/ws/src' },
      { name: 'docs', isDir: true, absPath: '/ws/docs' },
      { name: 'README.md', isDir: false, absPath: '/ws/README.md' },
    ];

    const filtered = filterVisibleEntries(entries, 'app', (entry) => children.get(entry.absPath));
    assert.deepEqual(
      filtered.map((item) => item.name),
      ['src'],
    );
  });

  it('rejects empty path segments and separators when sanitizing names', () => {
    assert.equal(sanitizeNewEntryName('  '), null);
    assert.equal(sanitizeNewEntryName('.'), null);
    assert.equal(sanitizeNewEntryName('..'), null);
    assert.equal(sanitizeNewEntryName('a/b'), null);
    assert.equal(sanitizeNewEntryName('a\\b'), null);
    assert.equal(sanitizeNewEntryName(' note.md '), 'note.md');
  });
});
