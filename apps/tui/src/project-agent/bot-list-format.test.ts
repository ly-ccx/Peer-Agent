import { describe, expect, test } from 'bun:test';
import { clipBotLine, formatBotWhen } from './bot-list-format.ts';

describe('bot list lines', () => {
  test('keeps the clock off the preview and shortens an instant', () => {
    expect(formatBotWhen('2026-11-05T12:36:10.000Z')).toBe('11-05 12:36');
    expect(clipBotLine('查完了。之前没查分支、标签和 worktree，所以只在当前检出里搜', 15)).toBe('查完了。之前没查分支、标签和…');
  });
});
