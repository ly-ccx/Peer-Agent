import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMemoryFileAnchors } from './file-anchors.mjs';

test('anchor authority hashes actual bounded project files and refuses escapes including symlinks', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-anchor-')), outside = mkdtempSync(path.join(os.tmpdir(), 'memory-outside-'));
  try {
    writeFileSync(path.join(root, 'a.txt'), 'one'); writeFileSync(path.join(outside, 'secret'), 'outside');
    symlinkSync(path.join(outside, 'secret'), path.join(root, 'escape'));
    const anchors = createMemoryFileAnchors({ resolveWorkspacePath: () => root, readHead: () => ({ commit: 'c1' }) });
    const first = anchors.read({ workspaceId: 'w', path: 'a.txt' }); assert.equal(first.contentHash.length, 64); assert.equal(first.commit, 'c1');
    writeFileSync(path.join(root, 'a.txt'), 'two'); assert.notEqual(anchors.read({ workspaceId: 'w', path: 'a.txt' }).contentHash, first.contentHash);
    for (const target of ['../secret', path.join(outside, 'secret'), 'escape', 'missing']) assert.equal(anchors.read({ workspaceId: 'w', path: target }), null);
    writeFileSync(path.join(root, 'large'), Buffer.alloc(1024 * 1024 + 1)); assert.equal(anchors.read({ workspaceId: 'w', path: 'large' }), null);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
