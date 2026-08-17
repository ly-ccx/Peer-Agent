import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EDITOR_BRAND_SVGS,
  resolveEditorIconDataUrl,
} from './editorBrandIcons.ts';

describe('editorBrandIcons', () => {
  it('covers the official VS Code / Cursor / Zed brand marks', () => {
    assert.match(EDITOR_BRAND_SVGS.vscode, /visualstudiocode|Visual Studio Code/i);
    assert.ok(EDITOR_BRAND_SVGS.cursor);
    assert.ok(EDITOR_BRAND_SVGS.zed);
  });

  it('prefers a local app icon over the brand fallback', () => {
    assert.equal(
      resolveEditorIconDataUrl('vscode', 'data:image/png;base64,local'),
      'data:image/png;base64,local',
    );
  });

  it('falls back to the official brand SVG when the local icon is missing', () => {
    const fallback = resolveEditorIconDataUrl('vscode', null);
    assert.ok(fallback);
    assert.match(fallback, /^data:image\/svg\+xml/);
    assert.match(fallback, /007ACC|Visual Studio Code/i);
  });
});
