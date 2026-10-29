import assert from 'node:assert/strict';
import test from 'node:test';
import { adapterModeUnavailable, documentAdapter, documentAdapterNotice } from './documentAdapterState.ts';

test('HTML/SVG and unsupported document formats have truthful static fallback, including restored preview', () => {
  for (const path of ['index.html', 'page.htm', 'diagram.svg', 'file.pdf', 'file.docx']) {
    assert.equal(documentAdapter(path), 'source');
    assert.equal(adapterModeUnavailable(path, 'preview'), true);
    assert.ok(documentAdapterNotice(path, false));
  }
  assert.match(documentAdapterNotice('diagram.svg', false)!, /not executed or loaded/);
  assert.match(documentAdapterNotice('file.pdf', false)!, /No document adapter/);
  assert.equal(documentAdapter('readme.md'), 'markdown');
  assert.equal(documentAdapter('config.json'), 'json');
  assert.equal(documentAdapter('photo.png'), 'raster');
  assert.equal(adapterModeUnavailable('photo.png', 'source'), true);
  assert.equal(adapterModeUnavailable('readme.md', 'preview'), false);
  assert.equal(documentAdapterNotice('code.ts', false), null);
});
