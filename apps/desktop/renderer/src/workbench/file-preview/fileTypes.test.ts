import assert from 'node:assert/strict';
import test from 'node:test';

import { basename, defaultModeForKind, detectFileKind, extension, formatJsonForPreview } from './fileTypes.ts';

test('detects previewable file kinds from common extensions', () => {
  assert.equal(detectFileKind('/tmp/readme.md'), 'markdown');
  assert.equal(detectFileKind('/tmp/package.json'), 'json');
  assert.equal(detectFileKind('/tmp/player_controller.gd'), 'code');
  assert.equal(detectFileKind('/tmp/debug.log'), 'text');
  assert.equal(detectFileKind('/tmp/screenshot.png'), 'image');
});

test('uses preview for document-like kinds and source for code-like kinds', () => {
  assert.equal(defaultModeForKind('markdown'), 'preview');
  assert.equal(defaultModeForKind('json'), 'preview');
  assert.equal(defaultModeForKind('code'), 'source');
  assert.equal(defaultModeForKind('unknown'), 'source');
});

test('extracts portable path names and extensions', () => {
  assert.equal(basename('/Users/demo/project/README.md'), 'README.md');
  assert.equal(basename('C:\\repo\\src\\index.ts'), 'index.ts');
  assert.equal(extension('/Users/demo/.gitignore'), '');
  assert.equal(extension('/Users/demo/project/archive.tar.gz'), 'gz');
});

test('formats valid json and keeps invalid json unavailable', () => {
  assert.equal(formatJsonForPreview('{"b":1,"a":[2]}'), '{\n  "b": 1,\n  "a": [\n    2\n  ]\n}');
  assert.equal(formatJsonForPreview('{broken'), null);
});
