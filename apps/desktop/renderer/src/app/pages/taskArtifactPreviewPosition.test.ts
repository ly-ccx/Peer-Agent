import assert from 'node:assert/strict';
import test from 'node:test';
import { positionTaskArtifactPreview } from './taskArtifactPreviewPosition.ts';

const preview = { width: 360, height: 240 };
const viewport = { width: 1000, height: 700 };

test('positions below when there is enough room', () => {
  assert.deepEqual(
    positionTaskArtifactPreview({ left: 100, right: 400, top: 100, bottom: 140 }, preview, viewport),
    { left: 100, top: 148, placement: 'below' },
  );
});

test('flips above when the trigger is near the viewport bottom', () => {
  assert.deepEqual(
    positionTaskArtifactPreview({ left: 100, right: 400, top: 620, bottom: 660 }, preview, viewport),
    { left: 100, top: 372, placement: 'above' },
  );
});

test('keeps the same gutter on the left and right viewport edges', () => {
  const leftClamped = positionTaskArtifactPreview(
    { left: -80, right: 100, top: 100, bottom: 140 },
    preview,
    viewport,
  );
  const rightClamped = positionTaskArtifactPreview(
    { left: 900, right: 980, top: 100, bottom: 140 },
    preview,
    viewport,
  );
  assert.equal(leftClamped.left, 12);
  assert.equal(viewport.width - (rightClamped.left + preview.width), 12);
});

test('fits an oversized preview before clamping so both gutters stay equal', () => {
  const oversized = { width: 1200, height: 900 };
  const result = positionTaskArtifactPreview(
    { left: 500, right: 700, top: 300, bottom: 340 },
    oversized,
    viewport,
  );
  assert.equal(result.left, 12);
  assert.equal(result.top, 12);
  assert.equal(viewport.width - (result.left + (viewport.width - 24)), 12);
});
