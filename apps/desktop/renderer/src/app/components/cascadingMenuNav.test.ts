import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstEnabledIndex,
  resolveCascadingSubmenuAnchor,
  resolveKeyboardActiveScrollTarget,
  resolveOpenGroupScrollTarget,
  stepEnabledIndex,
  type CascadingNavItem,
} from './cascadingMenuNav.ts';

const item = (disabled = false): CascadingNavItem => ({ disabled });

describe('firstEnabledIndex', () => {
  it('returns first enabled index', () => {
    assert.equal(firstEnabledIndex([item(true), item(false), item(false)]), 1);
  });
  it('returns 0 when every item is disabled (fallback)', () => {
    assert.equal(firstEnabledIndex([item(true), item(true)]), 0);
  });
  it('returns -1 for empty list', () => {
    assert.equal(firstEnabledIndex([]), -1);
  });
  it('returns 0 when first item already enabled', () => {
    assert.equal(firstEnabledIndex([item(false), item(true)]), 0);
  });
});

describe('stepEnabledIndex', () => {
  it('skips disabled items when moving down', () => {
    // index 0 -> next enabled after 1(disabled) is 2
    assert.equal(stepEnabledIndex([item(false), item(true), item(false)], 0, 1), 2);
  });
  it('skips disabled items when moving up', () => {
    // index 2 -> prev enabled before 1(disabled) is 0
    assert.equal(stepEnabledIndex([item(false), item(true), item(false)], 2, -1), 0);
  });
  it('wraps around to the top when moving down past the end', () => {
    assert.equal(stepEnabledIndex([item(false), item(false)], 1, 1), 0);
  });
  it('wraps around to the bottom when moving up past the start', () => {
    assert.equal(stepEnabledIndex([item(false), item(false)], 0, -1), 1);
  });
  it('wraps over a trailing disabled item', () => {
    // from 0 moving down: 1 disabled, 2 disabled, wrap to 0 (only enabled) -> stays 0
    assert.equal(stepEnabledIndex([item(false), item(true), item(true)], 0, 1), 0);
  });
  it('returns from unchanged when no enabled item exists', () => {
    assert.equal(stepEnabledIndex([item(true), item(true)], 1, 1), 1);
  });
  it('returns -1 for empty list', () => {
    assert.equal(stepEnabledIndex([], 0, 1), -1);
  });
});

describe('resolveOpenGroupScrollTarget', () => {
  it('scrolls to the selected model when opening or switching group', () => {
    // 已选中靠下模型（例如 index 12）时，打开菜单应滚到该项。
    assert.deepEqual(resolveOpenGroupScrollTarget(12), { kind: 'index', index: 12 });
  });
  it('does not force scroll when there is no selected item in the group', () => {
    assert.deepEqual(resolveOpenGroupScrollTarget(-1), { kind: 'none' });
  });
});

describe('resolveKeyboardActiveScrollTarget', () => {
  it('scrolls to active item only for keyboard navigation', () => {
    assert.deepEqual(resolveKeyboardActiveScrollTarget(true, 3), { kind: 'index', index: 3 });
  });
  it('does not scroll when hover changes activeItemIndex', () => {
    // 用户滚上去悬停靠上模型时，绝不能强制 scrollIntoView 回已选项。
    assert.deepEqual(resolveKeyboardActiveScrollTarget(false, 3), { kind: 'none' });
  });
  it('does not scroll when active index is invalid', () => {
    assert.deepEqual(resolveKeyboardActiveScrollTarget(true, -1), { kind: 'none' });
  });
});

describe('resolveCascadingSubmenuAnchor', () => {
  const panelRect = { left: 100, right: 320, top: 80 };
  const base = {
    panelRect,
    submenuWidth: 220,
    submenuHeight: 120,
    viewportWidth: 1200,
    viewportHeight: 900,
    margin: 8,
    gap: 0,
  };

  it('anchors each submenu to its hovered provider row, not the panel top', () => {
    const topRow = resolveCascadingSubmenuAnchor({
      ...base,
      rowRect: { top: 80 },
    });
    const middleRow = resolveCascadingSubmenuAnchor({
      ...base,
      rowRect: { top: 260 },
    });
    const bottomRow = resolveCascadingSubmenuAnchor({
      ...base,
      rowRect: { top: 420 },
    });

    assert.equal(topRow.top, 80);
    assert.equal(middleRow.top, 260);
    assert.equal(bottomRow.top, 420);
    assert.notEqual(middleRow.top, panelRect.top);
    assert.notEqual(bottomRow.top, panelRect.top);
    assert.equal(topRow.left, 320);
    assert.equal(topRow.side, 'right');
  });

  it('does not clamp preferred top back to the primary panel top', () => {
    const anchored = resolveCascadingSubmenuAnchor({
      ...base,
      rowRect: { top: 360 },
    });
    assert.equal(anchored.top, 360);
    assert.ok(anchored.top > panelRect.top);
  });

  it('slides up only when the submenu would overflow the viewport bottom', () => {
    const anchored = resolveCascadingSubmenuAnchor({
      ...base,
      rowRect: { top: 820 },
      submenuHeight: 200,
      viewportHeight: 900,
    });
    // Available height below row is 72, but maxHeight floors at 160 → subH=160.
    // 820 + 160 > 892, so slide up to keep the submenu inside the viewport.
    assert.equal(anchored.top, 900 - 160 - 8);
    assert.ok(anchored.top < 820);
  });
});
