import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAT_INNER_RADIUS,
  CAT_SILHOUETTE_SEGMENTS,
  CAT_SILHOUETTE_START,
  buildCatSilhouettePath,
  buildCutoutOverlayPath,
  computeRevealTargetScale,
  sampleRevealFrame,
} from './brandStartupReveal.ts';

test('cat silhouette path is horizontally symmetric and closes at forehead center', () => {
  assert.equal(CAT_SILHOUETTE_START.x, 0);
  assert.equal(CAT_SILHOUETTE_SEGMENTS.length, 12);
  const last = CAT_SILHOUETTE_SEGMENTS.at(-1)!;
  assert.equal(last.x, CAT_SILHOUETTE_START.x);
  assert.equal(last.y, CAT_SILHOUETTE_START.y);

  // Every right-side segment pairs with an exact left-side mirror (reversed path order).
  for (let i = 0; i < 6; i += 1) {
    const right = CAT_SILHOUETTE_SEGMENTS[i]!;
    const left = CAT_SILHOUETTE_SEGMENTS[11 - i]!;
    const rightStart = i === 0 ? CAT_SILHOUETTE_START : CAT_SILHOUETTE_SEGMENTS[i - 1]!;
    assert.equal(left.cp1x, -right.cp2x === 0 ? 0 : -right.cp2x);
    assert.equal(left.cp1y, right.cp2y);
    assert.equal(left.cp2x, -right.cp1x === 0 ? 0 : -right.cp1x);
    assert.equal(left.cp2y, right.cp1y);
    assert.equal(left.x, -rightStart.x === 0 ? 0 : -rightStart.x);
    assert.equal(left.y, rightStart.y);
  }

  const path = buildCatSilhouettePath();
  assert.match(path, /^M 0 -47 /);
  assert.match(path, / Z$/);
});

test('cutout overlay path combines outer backdrop rect with inner cat silhouette', () => {
  const path = buildCutoutOverlayPath({
    width: 1280,
    height: 860,
    cx: 640,
    cy: 442,
    scaleX: 2,
    scaleY: 2,
  });
  assert.match(path, /^M -64 -64 h 1408 v 988 h -1408 Z M /);
  assert.match(path, / Z$/);
});

test('target scale guarantees inner cutout clears all corners on standard and 4K viewports', () => {
  for (const [width, height] of [
    [760, 860],
    [1280, 860],
    [3840, 2160],
  ]) {
    const baseScale = 160 / 200;
    const cx = width / 2;
    const cy = height / 2 + 12;
    const scale = computeRevealTargetScale({ width, height, cx, cy, baseScale });
    const clearedRadius = CAT_INNER_RADIUS * baseScale * scale;
    const farthestCorner = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));
    assert.ok(clearedRadius > farthestCorner, `${width}x${height} must clear corner distance`);
  }
});

test('reveal timeline starts solid, opens translucent portal mid-flight, and clears at end', () => {
  const target = 36;
  const start = sampleRevealFrame(0, target);
  assert.equal(start.scaleX, 1);
  assert.equal(start.scaleY, 1);
  assert.equal(start.solidOpacity, 1);
  assert.equal(start.scrimOpacity, 1);

  const pullback = sampleRevealFrame(0.15, target);
  assert.ok(pullback.scaleX < 1 && pullback.scaleY < 1, 'anticipation squashes inward before zoom');
  assert.equal(pullback.solidOpacity, 1);

  const midPortal = sampleRevealFrame(0.45, target);
  assert.ok(midPortal.scaleX > 2 && midPortal.scaleX < target, 'cat head expands over app content');
  assert.equal(midPortal.solidOpacity, 0, 'solid fill dissolves so live UI shines through silhouette');
  assert.equal(midPortal.scrimOpacity, 1, 'outer backdrop remains opaque around cutout');
  assert.ok(midPortal.rimOpacity > 0, 'subtle rim defines cutout during expansion');

  const end = sampleRevealFrame(1, target);
  assert.equal(end.scaleX, target);
  assert.equal(end.scaleY, target);
  assert.equal(end.solidOpacity, 0);
  assert.equal(end.veilOpacity, 0);
  assert.equal(end.rimOpacity, 0);
  assert.equal(end.scrimOpacity, 0);
});
