import { expect, test } from 'bun:test';
import { cardFocusIntent } from './cardFocus.ts';

test('conversation navigation enters cards only through explicit Tab focus', () => {
  for (const name of ['up', 'down', 'left', 'right', 'return', 'enter', 'linefeed']) {
    expect(cardFocusIntent({ name }, false, true)).toBe('none');
  }
  expect(cardFocusIntent({ name: 'tab' }, false, true)).toBe('enter');
  expect(cardFocusIntent({ name: 'tab' }, false, false)).toBe('none');
});
test('focused cards expose navigation and activation while Escape and lost cards return to editing', () => {
  expect(cardFocusIntent({ name: 'up' }, true, true)).toBe('card');
  expect(cardFocusIntent({ name: 'right' }, true, true)).toBe('option');
  for (const name of ['return', 'enter', 'linefeed']) expect(cardFocusIntent({ name }, true, true)).toBe('act');
  expect(cardFocusIntent({ name: 'escape' }, true, true)).toBe('leave');
  expect(cardFocusIntent({ name: 'return' }, true, false)).toBe('leave');
  expect(cardFocusIntent({ name: 'enter', isComposing: true }, true, true)).toBe('none');
  expect(cardFocusIntent({ name: 'enter', eventType: 'repeat' }, true, true)).toBe('none');
  expect(cardFocusIntent({ name: 'enter', eventType: 'release' }, true, true)).toBe('none');
  expect(cardFocusIntent({ name: 'x', sequence: 'X' }, true, true)).toBe('type');
  expect(cardFocusIntent({ name: 'x', ctrl: true }, true, true)).toBe('none');
  expect(cardFocusIntent({ name: 'escape', sequence: '\u001b' }, true, true)).toBe('leave');
});
