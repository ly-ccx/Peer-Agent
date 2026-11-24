import assert from 'node:assert/strict';
import test from 'node:test';
import { positionProviderMenu } from './providerMenuPosition.ts';

test('opens downward aligned to panel top when there is room below and to the left', () => {
  const placement = positionProviderMenu(
    { left: 500, top: 120, bottom: 260, height: 140 },
    { width: 220, height: 210 },
    { width: 1280, height: 800 },
  );
  assert.deepEqual(placement, {
    below: false,
    alignBottom: false,
    top: 6,
    maxHeight: 280,
  });
});

test('shifts upward flush with panel bottom when opening near the bottom composer', () => {
  const panel = { left: 540, top: 620, bottom: 735, height: 115 };
  const menu = { width: 220, height: 216 };
  const viewport = { width: 1280, height: 820 };
  const placement = positionProviderMenu(panel, menu, viewport);

  assert.equal(placement.below, false);
  assert.equal(placement.alignBottom, true);
  assert.equal(panel.top + (placement.top ?? 0) + menu.height, panel.bottom);
  assert.ok(panel.top + (placement.top ?? 0) >= 12);
  assert.ok(panel.top + (placement.top ?? 0) + menu.height <= viewport.height - 12);
});

test('clamps inside short viewports when aligning to panel bottom would overflow top', () => {
  const panel = { left: 400, top: 120, bottom: 220, height: 100 };
  const menu = { width: 220, height: 260 };
  const viewport = { width: 1280, height: 360 };
  const placement = positionProviderMenu(panel, menu, viewport);

  assert.equal(placement.below, false);
  assert.equal(placement.alignBottom, true);
  const topInViewport = panel.top + (placement.top ?? 0);
  assert.ok(topInViewport >= 12);
  assert.ok(topInViewport + menu.height <= viewport.height - 12);
});

test('falls back from left placement when horizontal space is narrower than menu width plus margin', () => {
  const placement = positionProviderMenu(
    { left: 210, top: 120, bottom: 240, height: 120 },
    { width: 220, height: 200 },
    { width: 800, height: 700 },
  );
  assert.equal(placement.below, true);
  assert.equal(placement.alignBottom, false);
  assert.equal(placement.top, 44);
});

test('flips above panel when narrow left space coincides with bottom viewport edge', () => {
  const panel = { left: 100, top: 620, bottom: 735, height: 115 };
  const menu = { width: 220, height: 210 };
  const viewport = { width: 800, height: 800 };
  const placement = positionProviderMenu(panel, menu, viewport);

  assert.equal(placement.below, true);
  assert.equal(placement.alignBottom, true);
  assert.ok(panel.top + (placement.top ?? 0) >= 12);
  assert.ok(panel.top + (placement.top ?? 0) + menu.height <= panel.top);
});

test('keeps embedded panels on their container-relative below layout', () => {
  const placement = positionProviderMenu(
    { left: 500, top: 600, bottom: 720, height: 120 },
    { width: 220, height: 220 },
    { width: 1280, height: 800 },
    { embedded: true },
  );
  assert.deepEqual(placement, { below: true, alignBottom: false });
});
