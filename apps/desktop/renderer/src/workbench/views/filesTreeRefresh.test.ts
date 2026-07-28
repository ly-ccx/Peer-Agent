import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectDirPathsToRefresh,
  collectWatchDirPaths,
  isDescendantPath,
  mergePendingRefreshPaths,
  pathKey,
  pruneAfterDirReload,
} from './filesTreeRefresh.ts';

describe('filesTreeRefresh path helpers', () => {
  it('normalizes path keys across separators', () => {
    assert.equal(pathKey('/tmp/ws/'), '/tmp/ws');
    assert.equal(pathKey('C:\\a\\b\\'), 'C:/a/b');
  });

  it('detects descendant paths only', () => {
    assert.equal(isDescendantPath('/tmp/ws', '/tmp/ws/a'), true);
    assert.equal(isDescendantPath('/tmp/ws', '/tmp/ws/a/b'), true);
    assert.equal(isDescendantPath('/tmp/ws', '/tmp/ws'), false);
    assert.equal(isDescendantPath('/tmp/ws', '/tmp/other'), false);
    assert.equal(isDescendantPath('/tmp/ws', '/tmp/ws2/a'), false);
  });
});

describe('collectDirPathsToRefresh', () => {
  it('returns empty without root', () => {
    assert.deepEqual(collectDirPathsToRefresh(null, ['/a']), []);
    assert.deepEqual(collectDirPathsToRefresh(undefined, []), []);
  });

  it('includes root and expanded dirs without duplicates', () => {
    const paths = collectDirPathsToRefresh('/tmp/ws/', ['/tmp/ws', '/tmp/ws/src', '/tmp/ws/src/']);
    assert.deepEqual(paths, ['/tmp/ws', '/tmp/ws/src']);
  });

  it('watch paths match refresh paths', () => {
    const expanded = new Set(['/tmp/ws/src']);
    assert.deepEqual(
      collectWatchDirPaths('/tmp/ws', expanded),
      collectDirPathsToRefresh('/tmp/ws', expanded),
    );
  });
});

describe('mergePendingRefreshPaths', () => {
  it('adds event dirs into the pending set', () => {
    const pending = mergePendingRefreshPaths(new Set(['/tmp/ws']), '/tmp/ws/src/');
    assert.deepEqual([...pending].sort(), ['/tmp/ws', '/tmp/ws/src'].sort());
  });
});

describe('pruneAfterDirReload', () => {
  it('drops cache for removed direct child directories and their descendants', () => {
    const state = {
      children: new Map([
        [
          '/tmp/ws',
          [
            { absPath: '/tmp/ws/keep', isDir: true },
            { absPath: '/tmp/ws/gone', isDir: true },
            { absPath: '/tmp/ws/file.txt', isDir: false },
          ],
        ],
        [
          '/tmp/ws/gone',
          [
            { absPath: '/tmp/ws/gone/nested', isDir: true },
            { absPath: '/tmp/ws/gone/a.txt', isDir: false },
          ],
        ],
        ['/tmp/ws/gone/nested', []],
        ['/tmp/ws/keep', [{ absPath: '/tmp/ws/keep/x.ts', isDir: false }]],
      ]),
      expanded: new Set(['/tmp/ws', '/tmp/ws/gone', '/tmp/ws/gone/nested', '/tmp/ws/keep']),
      loading: new Set(['/tmp/ws/gone/nested']),
      selected: '/tmp/ws/gone/nested',
    };

    const nextEntries = [
      { absPath: '/tmp/ws/keep', isDir: true },
      { absPath: '/tmp/ws/file.txt', isDir: false },
      { absPath: '/tmp/ws/new', isDir: true },
    ];

    const next = pruneAfterDirReload('/tmp/ws', nextEntries, state);

    assert.deepEqual(next.children.get('/tmp/ws'), nextEntries);
    assert.equal(next.children.has('/tmp/ws/gone'), false);
    assert.equal(next.children.has('/tmp/ws/gone/nested'), false);
    assert.equal(next.children.has('/tmp/ws/keep'), true);
    assert.equal(next.expanded.has('/tmp/ws/gone'), false);
    assert.equal(next.expanded.has('/tmp/ws/gone/nested'), false);
    assert.equal(next.expanded.has('/tmp/ws/keep'), true);
    assert.equal(next.loading.has('/tmp/ws/gone/nested'), false);
    assert.equal(next.selected, null);
  });

  it('keeps selection when it is still under a surviving child', () => {
    const state = {
      children: new Map([
        [
          '/tmp/ws',
          [
            { absPath: '/tmp/ws/a', isDir: true },
            { absPath: '/tmp/ws/b', isDir: true },
          ],
        ],
        ['/tmp/ws/a', [{ absPath: '/tmp/ws/a/x', isDir: false }]],
      ]),
      expanded: new Set(['/tmp/ws', '/tmp/ws/a']),
      loading: new Set<string>(),
      selected: '/tmp/ws/a',
    };
    const next = pruneAfterDirReload(
      '/tmp/ws',
      [
        { absPath: '/tmp/ws/a', isDir: true },
        { absPath: '/tmp/ws/c', isDir: true },
      ],
      state,
    );
    assert.equal(next.selected, '/tmp/ws/a');
    assert.equal(next.children.has('/tmp/ws/a'), true);
    assert.equal(next.children.has('/tmp/ws/b'), false);
  });
});
