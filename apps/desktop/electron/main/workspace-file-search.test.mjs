import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isFinderPlaceholderName,
  rankWorkspaceFiles,
  scoreWorkspaceFile,
  searchWorkspaceFiles,
  shouldSkipDirName,
  shouldSkipFileName,
} from './workspace-file-search.mjs';

test('skips hidden and build directories', () => {
  assert.equal(shouldSkipDirName('node_modules'), true);
  assert.equal(shouldSkipDirName('.git'), true);
  assert.equal(shouldSkipDirName('src'), false);
});

test('skips hidden dotfiles', () => {
  assert.equal(shouldSkipFileName('.DS_Store'), true);
  assert.equal(shouldSkipFileName('.gitignore'), true);
  assert.equal(shouldSkipFileName('AGENTS.md'), false);
});

test('skips Finder placeholder names', () => {
  assert.equal(isFinderPlaceholderName('新建文件'), true);
  assert.equal(isFinderPlaceholderName('Untitled Folder'), true);
  assert.equal(shouldSkipFileName('新建文件'), true);
  assert.equal(shouldSkipFileName('src'), false);
});

test('ranks exact file names above path substring matches', () => {
  const ranked = rankWorkspaceFiles([
    { relPath: 'apps/desktop/renderer/src/chat/components/ComposerDraftControls.tsx', kind: 'file' },
    { relPath: 'docs/notes.md', kind: 'file' },
    { relPath: 'apps/desktop/renderer/src/chat/state/composerPersistence.ts', kind: 'file' },
  ], 'ComposerDraftControls');
  assert.equal(ranked[0].name, 'ComposerDraftControls.tsx');
  assert.equal(ranked.some((hit) => hit.name === 'notes.md'), false);
});

test('empty query still returns shallow files and ignores deep noise', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-workspace-search-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'src', 'deep', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'README.md'), 'hi');
    fs.writeFileSync(path.join(root, '新建文件'), '');
    fs.writeFileSync(path.join(root, '.DS_Store'), 'junk');
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}');
    fs.writeFileSync(path.join(root, 'src', 'deep', 'nested', 'secret.ts'), 'nope');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'skip');

    const result = searchWorkspaceFiles(root, { query: '', limit: 20 });
    assert.equal(result.ok, true);
    const rels = result.files.map((hit) => hit.relPath);
    assert.ok(rels.includes('README.md'));
    assert.ok(rels.includes('src/index.ts'));
    assert.ok(result.files.some((hit) => hit.relPath === 'src' && hit.kind === 'directory'));
    assert.equal(rels.includes('新建文件'), false);
    assert.equal(rels.includes('.DS_Store'), false);
    assert.equal(rels.includes('src/deep/nested/secret.ts'), false);
    assert.equal(rels.some((rel) => rel.includes('node_modules')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('query search stays inside the workspace root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-workspace-search-'));
  try {
    fs.mkdirSync(path.join(root, 'apps', 'desktop'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps', 'desktop', 'ComposerDraftControls.tsx'), 'x');
    fs.writeFileSync(path.join(root, 'outside.txt'), 'no');
    const result = searchWorkspaceFiles(root, { query: 'Composer', limit: 8 });
    assert.equal(result.ok, true);
    assert.equal(result.files[0].relPath, 'apps/desktop/ComposerDraftControls.tsx');
    assert.equal(scoreWorkspaceFile(result.files[0].relPath, 'Composer') > 0, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
