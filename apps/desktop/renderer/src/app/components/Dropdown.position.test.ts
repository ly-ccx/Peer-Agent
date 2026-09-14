import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectDropdownOccluders,
  collectOpenWorkbenchOccluders,
  collectVisibleWebviewOccluders,
  isVisibleDropdownOccluder,
  placeDropdownMenu,
} from './dropdownPosition.ts';

const trigger = {
  left: 520,
  top: 640,
  right: 640,
  bottom: 668,
  width: 120,
};

const midTrigger = {
  left: 520,
  top: 400,
  right: 640,
  bottom: 428,
  width: 120,
};

test('keeps the trigger-left alignment when the menu already fits', () => {
  const placed = placeDropdownMenu({
    trigger: midTrigger,
    menu: { width: 120, height: 220 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: 'down',
  });
  assert.equal(placed.left, 520);
  assert.equal(placed.top, 432);
  assert.equal(placed.placement, 'down');
});

test('opens upward when there is more room above the trigger', () => {
  const placed = placeDropdownMenu({
    trigger,
    menu: { width: 120, height: 220 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: 'down',
  });
  assert.equal(placed.placement, 'up');
  assert.equal(placed.top, 416);
  assert.equal(placed.left, 520);
});

test('slides left when a content-sized menu would overflow the viewport', () => {
  const placed = placeDropdownMenu({
    trigger: { left: 1100, top: 640, right: 1220, bottom: 668, width: 120 },
    menu: { width: 260, height: 220 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: 'down',
  });
  assert.equal(placed.left, 1012);
  assert.ok(placed.left + 260 <= 1272);
});

test('slides left of a visible webview instead of overlapping it', () => {
  const placed = placeDropdownMenu({
    trigger,
    menu: { width: 260, height: 220 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: 'down',
    occluders: [{ left: 700, top: 0, right: 1280, bottom: 800 }],
  });
  assert.equal(placed.left, 432);
  assert.ok(placed.left + 260 <= 692);
});

test('stays left of a webview even when the menu is wider than the remaining chat column', () => {
  const placed = placeDropdownMenu({
    trigger,
    menu: { width: 700, height: 220 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: 'down',
    occluders: [{ left: 700, top: 0, right: 1280, bottom: 800 }],
  });
  assert.equal(placed.left, -8);
  assert.equal(placed.left + 700, 692);
});

test('ignores hidden or zero-size webviews when collecting occluders', () => {
  assert.equal(
    isVisibleDropdownOccluder({ width: 580, height: 800 }, { visibility: 'hidden', display: 'flex' }),
    false,
  );
  assert.equal(
    isVisibleDropdownOccluder({ width: 0, height: 800 }, { visibility: 'visible', display: 'flex' }),
    false,
  );
  assert.equal(
    isVisibleDropdownOccluder({ width: 580, height: 800 }, { visibility: 'visible', display: 'flex' }),
    true,
  );

  const visible = {
    className: 'browser-webview',
    getBoundingClientRect: () => ({ left: 700, top: 0, right: 1280, bottom: 800, width: 580, height: 800 }),
  };
  const hidden = {
    className: 'browser-webview',
    getBoundingClientRect: () => ({ left: 700, top: 0, right: 1280, bottom: 800, width: 580, height: 800 }),
  };
  const boxes = collectVisibleWebviewOccluders(
    { querySelectorAll: () => [visible, hidden] as unknown as ArrayLike<Element> },
    (el) => (el === hidden
      ? { visibility: 'hidden', display: 'flex' }
      : { visibility: 'visible', display: 'flex' }),
  );
  assert.deepEqual(boxes, [{ left: 700, top: 0, right: 1280, bottom: 800 }]);
});

test('ignores a webview whose workbench view ancestor is hidden', () => {
  const parent = {
    parentElement: null,
  };
  const guest = {
    parentElement: parent,
    getBoundingClientRect: () => ({ left: 700, top: 0, right: 1280, bottom: 800, width: 580, height: 800 }),
  };
  const boxes = collectVisibleWebviewOccluders(
    { querySelectorAll: () => [guest] as unknown as ArrayLike<Element> },
    (el) => (el === parent
      ? { visibility: 'hidden', display: 'flex' }
      : { visibility: 'visible', display: 'flex' }),
  );
  assert.deepEqual(boxes, []);
});

test('slides left of an open Goal workbench panel instead of overlapping it', () => {
  const placed = placeDropdownMenu({
    trigger,
    menu: { width: 260, height: 220 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: 'down',
    occluders: [{ left: 700, top: 0, right: 1280, bottom: 800 }],
  });
  assert.equal(placed.left, 432);
  assert.ok(placed.left + 260 <= 692);
});

test('collects an open workbench panel and ignores a closed zero-width panel', () => {
  const openPanel = {
    className: 'workbench-panel workbench-panel--open',
    getBoundingClientRect: () => ({ left: 700, top: 0, right: 1280, bottom: 800, width: 580, height: 800 }),
  };
  const closedPanel = {
    className: 'workbench-panel',
    getBoundingClientRect: () => ({ left: 1280, top: 0, right: 1280, bottom: 800, width: 0, height: 800 }),
  };
  const visible = { visibility: 'visible', display: 'flex' };
  const collected = collectOpenWorkbenchOccluders(
    {
      querySelectorAll: (selector: string) => {
        assert.equal(selector, '.workbench-panel--open');
        return [openPanel] as unknown as ArrayLike<Element>;
      },
    },
    () => visible,
  );
  assert.deepEqual(collected, [{ left: 700, top: 0, right: 1280, bottom: 800 }]);

  const ignored = collectOpenWorkbenchOccluders(
    { querySelectorAll: () => [closedPanel] as unknown as ArrayLike<Element> },
    () => visible,
  );
  assert.deepEqual(ignored, []);
});

test('dropdown occluders include the open workbench even when no webview is visible', () => {
  const openPanel = {
    getBoundingClientRect: () => ({ left: 700, top: 0, right: 1280, bottom: 800, width: 580, height: 800 }),
  };
  const boxes = collectDropdownOccluders(
    {
      querySelectorAll: (selector: string) => (
        selector === '.workbench-panel--open'
          ? [openPanel] as unknown as ArrayLike<Element>
          : []
      ),
    },
    () => ({ visibility: 'visible', display: 'flex' }),
  );
  assert.deepEqual(boxes, [{ left: 700, top: 0, right: 1280, bottom: 800 }]);
});
