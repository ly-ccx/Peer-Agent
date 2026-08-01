import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getFileVisualKind } from './filesTreePresentation.ts';

describe('getFileVisualKind', () => {
  it('uses the folder visual for directories regardless of their name', () => {
    assert.equal(getFileVisualKind('src.ts', true), 'folder');
  });

  it('classifies common document and source file extensions', () => {
    assert.equal(getFileVisualKind('README.md', false), 'markdown');
    assert.equal(getFileVisualKind('FilesView.tsx', false), 'code');
    assert.equal(getFileVisualKind('workbench.css', false), 'style');
    assert.equal(getFileVisualKind('settings.json', false), 'config');
    assert.equal(getFileVisualKind('preview.png', false), 'image');
    assert.equal(getFileVisualKind('release.tar.gz', false), 'archive');
  });

  it('handles meaningful extensionless and dot file names', () => {
    assert.equal(getFileVisualKind('.gitignore', false), 'git');
    assert.equal(getFileVisualKind('Dockerfile', false), 'config');
    assert.equal(getFileVisualKind('Makefile', false), 'config');
  });

  it('falls back to a neutral file visual', () => {
    assert.equal(getFileVisualKind('LICENSE', false), 'file');
    assert.equal(getFileVisualKind('notes.custom', false), 'file');
  });
});
