import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SegmentGroup, ToolCallLegacy } from './types.ts';
import {
  previewInlineText,
  windowProcessingGroups,
  windowProcessingText,
} from './processingWindow.ts';

function call(id: number): ToolCallLegacy {
  return { tool: `tool-${id}`, args: {} };
}

describe('processing event window', () => {
  it('keeps only the newest processing events', () => {
    const groups: SegmentGroup[] = Array.from({ length: 100 }, (_, index) => ({
      type: 'thinking' as const,
      content: `thinking-${index}`,
    }));

    const window = windowProcessingGroups(groups, 10);

    assert.equal(window.groups.length, 10);
    assert.equal(window.omittedCount, 90);
    assert.equal(window.groups[0]?.type === 'thinking' ? window.groups[0].content : '', 'thinking-90');
  });

  it('clips inside a large tool-call group', () => {
    const groups: SegmentGroup[] = [{
      type: 'tool-call-group',
      calls: Array.from({ length: 80 }, (_, index) => call(index)),
    }];

    const window = windowProcessingGroups(groups, 6);
    const group = window.groups[0];

    assert.equal(group?.type, 'tool-call-group');
    assert.deepEqual(group?.type === 'tool-call-group' ? group.calls.map((item) => item.tool) : [], [
      'tool-74',
      'tool-75',
      'tool-76',
      'tool-77',
      'tool-78',
      'tool-79',
    ]);
    assert.equal(window.omittedCount, 74);
  });

  it('returns all groups when they fit in the limit', () => {
    const groups: SegmentGroup[] = [
      { type: 'thinking', content: 'a' },
      { type: 'tool-call-group', calls: [call(1), call(2)] },
    ];

    const window = windowProcessingGroups(groups, 10);

    assert.deepEqual(window.groups, groups);
    assert.equal(window.omittedCount, 0);
  });

  it('keeps only the newest part of one oversized thinking event', () => {
    const content = `${'older '.repeat(1_500)}LATEST`;
    const window = windowProcessingText(content, 1_000);

    assert.equal(window.content.length, 1_000);
    assert.equal(window.content.endsWith('LATEST'), true);
    assert.equal(window.omittedCharacterCount, content.length - 1_000);
  });

  it('does not split surrogate pairs at the thinking window boundary', () => {
    const window = windowProcessingText(`old🙂new`, 5);

    assert.equal(window.content, '🙂new');
    assert.equal(window.omittedCharacterCount, 3);
  });

  it('bounds and normalizes inline tool labels', () => {
    const preview = previewInlineText('  pnpm   test\n'.repeat(40), 24);

    assert.equal(preview.content.length <= 24, true);
    assert.equal(preview.content.endsWith('…'), true);
    assert.equal(preview.content.includes('\n'), false);
    assert.equal(preview.omittedCharacterCount > 0, true);
  });
});
