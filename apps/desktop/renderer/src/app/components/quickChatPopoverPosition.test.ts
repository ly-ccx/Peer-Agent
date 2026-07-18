import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveQuickChatPopoverPosition,
  resolveQuickChatPopoverVisualSize,
} from './quickChatPopoverLayout.ts';

const barRect = { x: 0, y: 0, width: 720, height: 104 };
const modelTrigger = { x: 520, y: 72, width: 120, height: 24 };
const workspaceTrigger = { x: 12, y: 8, width: 160, height: 24 };

test('sizes compact popover from content, not full bar width', () => {
  const size = resolveQuickChatPopoverVisualSize({
    kind: 'model',
    selectedValue: 'a',
    items: [
      { value: 'a', label: 'GPT-5.4' },
      { value: 'b', label: 'Claude Sonnet' },
    ],
    anchorRect: barRect,
  });
  assert.equal(size.width < barRect.width, true);
  assert.equal(size.width >= 190, true);
  assert.equal(size.height, 12 + 2 * 34);
});

test('right-aligns model menu to the trigger and flushes under the bar', () => {
  const size = { width: 220, height: 120 };
  const position = resolveQuickChatPopoverPosition({
    kind: 'model',
    anchorRect: modelTrigger,
    containerRect: barRect,
    size,
    viewportWidth: 720,
  });
  assert.equal(position.left, modelTrigger.x + modelTrigger.width - size.width);
  assert.equal(position.top, barRect.y + barRect.height);
});

test('left-aligns workspace menu to the trigger', () => {
  const size = { width: 280, height: 100 };
  const position = resolveQuickChatPopoverPosition({
    kind: 'workspace',
    anchorRect: workspaceTrigger,
    containerRect: barRect,
    size,
    viewportWidth: 720,
  });
  assert.equal(position.left, workspaceTrigger.x);
  assert.equal(position.top, barRect.y + barRect.height);
});

test('clamps right-aligned menus inside the viewport', () => {
  const size = { width: 300, height: 100 };
  const position = resolveQuickChatPopoverPosition({
    kind: 'model',
    anchorRect: { x: 10, y: 72, width: 40, height: 24 },
    containerRect: barRect,
    size,
    viewportWidth: 720,
  });
  assert.equal(position.left, 8);
});
