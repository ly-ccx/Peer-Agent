import { describe, expect, test } from 'bun:test';

import {
  conversationMessageRenderId,
  latestUserMessage,
  latestUserMessageIndex,
  resolveContextUserMessageId,
  shouldShowUserContextBar,
  summarizeUserContext,
} from './conversation-scroll.ts';

describe('conversation context bar policy', () => {
  const sample = [
    { id: 'u1', role: 'user', content: 'first' },
    { id: 'a1', role: 'assistant', content: 'ok' },
    { id: 'u2', role: 'user', content: 'second' },
    { id: 'a2', role: 'assistant', content: 'ok2' },
  ] as const;

  test('finds the latest user message', () => {
    expect(latestUserMessageIndex(sample)).toBe(2);
    expect(latestUserMessage(sample)?.id).toBe('u2');
    expect(latestUserMessage([{ id: 'a1', role: 'assistant', content: 'x' }])).toBeNull();
  });

  test('active turn always uses the latest user message', () => {
    expect(resolveContextUserMessageId(['u1', 'u2'], {
      isActiveTurn: true,
      latestUserId: 'u2',
      rowScreenTops: { u1: 0, u2: 100 },
      viewportScreenTop: 0,
      viewportHeight: 40,
    })).toBe('u2');
  });

  test('idle browsing maps to the user row in the upper viewport band', () => {
    expect(resolveContextUserMessageId(['u1', 'u2', 'u3'], {
      isActiveTurn: false,
      latestUserId: 'u3',
      rowScreenTops: { u1: -10, u2: 5, u3: 80 },
      viewportScreenTop: 0,
      viewportHeight: 40,
    })).toBe('u2');
  });

  test('falls back to latest user when geometry is missing', () => {
    expect(resolveContextUserMessageId(['u1', 'u2'], {
      isActiveTurn: false,
      latestUserId: 'u2',
    })).toBe('u2');
  });

  test('summarizes multi-line user text for the fixed bar', () => {
    expect(summarizeUserContext('hello\nworld', null)).toBe('hello world');
    expect(summarizeUserContext('', 'image 1')).toBe('image 1');
    expect(summarizeUserContext('x'.repeat(120), null, 20)).toBe(`${'x'.repeat(19)}…`);
  });

  test('builds a stable renderable id for message rows', () => {
    expect(conversationMessageRenderId('abc')).toBe('chat-msg-abc');
  });

  test('hides sticky context bar while the target user row is still in view', () => {
    expect(shouldShowUserContextBar({
      contextUserId: 'u2',
      rowScreenTops: { u1: -20, u2: 8 },
      viewportScreenTop: 0,
      viewportHeight: 40,
    })).toBe(false);
  });

  test('shows sticky context bar only after the target user row scrolls away', () => {
    expect(shouldShowUserContextBar({
      contextUserId: 'u2',
      rowScreenTops: { u1: -40, u2: -12 },
      viewportScreenTop: 0,
      viewportHeight: 40,
    })).toBe(true);
  });

  test('hides sticky context bar before geometry is measured', () => {
    expect(shouldShowUserContextBar({
      contextUserId: 'u1',
    })).toBe(false);
  });
});
