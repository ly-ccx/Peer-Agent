import assert from 'node:assert/strict';
import test from 'node:test';
import { isTopmostOverlay } from './overlayStack.ts';

const drawer = {} as Element;
const imagePreview = {} as Element;

test('only the image preview above a drawer is topmost', () => {
  const overlays = [drawer, imagePreview];

  assert.equal(isTopmostOverlay(drawer, overlays), false);
  assert.equal(isTopmostOverlay(imagePreview, overlays), true);
});

test('the drawer becomes topmost after the image preview is removed', () => {
  assert.equal(isTopmostOverlay(drawer, [drawer]), true);
  assert.equal(isTopmostOverlay(imagePreview, [drawer]), false);
});
