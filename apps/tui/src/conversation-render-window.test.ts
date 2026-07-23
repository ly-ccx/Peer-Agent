import { describe, expect, test } from 'bun:test';

import type { ChatMessage } from './chat-controller.ts';
import {
  createConversationRenderWindowState,
  estimateMessageChars,
  navigateConversationHistory,
  projectConversationRenderWindow,
  type ConversationRenderWindowPolicy,
} from './conversation-render-window.ts';

function message(
  id: string,
  role: ChatMessage['role'] = 'assistant',
  content = id,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, content, ...extra };
}

const SMALL_POLICY: ConversationRenderWindowPolicy = {
  fallbackMaxMessages: 4,
  fallbackMaxChars: 100,
  historyPageMessages: 3,
  historyPageMaxChars: 100,
  emergencyMaxMessages: 5,
  emergencyMaxChars: 200,
};

describe('conversation render window', () => {
  test('projects an empty conversation', () => {
    const projection = projectConversationRenderWindow([]);
    expect(projection.messages).toEqual([]);
    expect(projection.window).toMatchObject({
      reason: 'empty',
      hiddenBefore: 0,
      hiddenAfter: 0,
    });
  });

  test('renders a small conversation in full without compaction', () => {
    const messages = [
      message('u1', 'user'),
      message('a1'),
      message('u2', 'user'),
      message('a2'),
    ];
    const projection = projectConversationRenderWindow(messages, undefined, SMALL_POLICY);
    expect(projection.messages).toEqual(messages);
    expect(projection.window.reason).toBe('fallback-tail');
  });

  test('bounds an uncompacted tail by message count and keeps the turn whole', () => {
    const messages = [
      message('u1', 'user'),
      message('a1'),
      message('u2', 'user'),
      message('a2'),
      message('u3', 'user'),
      message('tool3', 'tool'),
      message('a3'),
    ];
    const projection = projectConversationRenderWindow(messages, undefined, SMALL_POLICY);
    expect(projection.messages.map((item) => item.id)).toEqual(['u2', 'a2', 'u3', 'tool3', 'a3']);
    expect(projection.window.hiddenBefore).toBe(2);
  });

  test('bounds an uncompacted tail by estimated characters without splitting a message', () => {
    const messages = [
      message('u1', 'user', 'x'.repeat(80)),
      message('a1', 'assistant', 'x'.repeat(80)),
      message('u2', 'user', 'x'.repeat(80)),
      message('a2', 'assistant', 'x'.repeat(120)),
    ];
    const projection = projectConversationRenderWindow(messages, undefined, SMALL_POLICY);
    expect(projection.messages.map((item) => item.id)).toEqual(['u2', 'a2']);
    expect(projection.window.estimatedRenderedChars).toBe(200);
  });

  test('estimates thinking, tool segments, and image placeholders', () => {
    const cost = estimateMessageChars(message('a1', 'assistant', 'text', {
      thinkingContent: 'think',
      images: [{ url: 'data:image/png;base64,a' }],
      segments: [
        { type: 'text', content: 'segment' },
        {
          type: 'tool-call',
          tool: {
            capabilityId: 'test',
            toolName: 'test',
            argumentSummary: 'arg',
            status: 'completed',
            detail: 'done',
            detailLines: ['done'],
          },
        },
      ],
    }));
    expect(cost).toBeGreaterThan('text'.length + 'think'.length + 'segment'.length + 256);
  });

  test('starts at the latest valid completed compaction and includes it', () => {
    const messages = [
      message('u1', 'user'),
      message('c1', 'system', 'done', { compact: { phase: 'done' } }),
      message('u2', 'user'),
      message('a2'),
      message('c-progress', 'system', 'working', {
        pending: true,
        compact: { phase: 'progress', percent: 50 },
      }),
      message('u3', 'user'),
      message('a3'),
    ];
    const projection = projectConversationRenderWindow(messages, undefined, {
      ...SMALL_POLICY,
      emergencyMaxMessages: 20,
    });
    expect(projection.messages.map((item) => item.id)).toEqual([
      'c1',
      'u2',
      'a2',
      'c-progress',
      'u3',
      'a3',
    ]);
    expect(projection.window).toMatchObject({
      reason: 'latest-compaction',
      compactionMessageId: 'c1',
    });
  });

  test('chooses the last completed compaction', () => {
    const messages = [
      message('c1', 'system', 'done', { compact: { phase: 'done' } }),
      message('u1', 'user'),
      message('a1'),
      message('c2', 'system', 'done', { compact: { phase: 'done' } }),
      message('u2', 'user'),
      message('a2'),
    ];
    const projection = projectConversationRenderWindow(messages, undefined, SMALL_POLICY);
    expect(projection.messages.map((item) => item.id)).toEqual(['c2', 'u2', 'a2']);
  });

  test('applies an emergency cap to an abnormally long post-compaction tail', () => {
    const messages = [
      message('c1', 'system', 'done', { compact: { phase: 'done' } }),
      ...Array.from({ length: 4 }, (_, index) => [
        message(`u${index}`, 'user'),
        message(`a${index}`),
      ]).flat(),
    ];
    const projection = projectConversationRenderWindow(messages, undefined, {
      ...SMALL_POLICY,
      emergencyMaxMessages: 3,
    });
    expect(projection.window.emergencyTruncated).toBe(true);
    expect(projection.messages.map((item) => item.id)).toEqual(['u2', 'a2', 'u3', 'a3']);
  });

  test('moves through bounded earlier and later pages without accumulating the full transcript', () => {
    const messages = Array.from({ length: 8 }, (_, index) => [
      message(`u${index}`, 'user'),
      message(`a${index}`),
    ]).flat();
    const latest = createConversationRenderWindowState();
    const latestProjection = projectConversationRenderWindow(messages, latest, SMALL_POLICY);
    expect(latestProjection.messages.map((item) => item.id)).toEqual(['u6', 'a6', 'u7', 'a7']);

    const earlier = navigateConversationHistory(messages, latest, 'earlier', SMALL_POLICY);
    const earlierProjection = projectConversationRenderWindow(messages, earlier, SMALL_POLICY);
    expect(earlierProjection.window.mode).toBe('history');
    expect(earlierProjection.messages.map((item) => item.id)).toEqual(['u5', 'a5', 'u6', 'a6']);
    expect(earlierProjection.window.hiddenAfter).toBeGreaterThan(0);

    const earlierAgain = navigateConversationHistory(messages, earlier, 'earlier', SMALL_POLICY);
    const earlierAgainProjection = projectConversationRenderWindow(messages, earlierAgain, SMALL_POLICY);
    expect(earlierAgainProjection.messages.length).toBeLessThan(messages.length);
    expect(earlierAgainProjection.messages.map((item) => item.id)).toEqual(['u4', 'a4', 'u5', 'a5']);

    const later = navigateConversationHistory(messages, earlierAgain, 'later', SMALL_POLICY);
    expect(projectConversationRenderWindow(messages, later, SMALL_POLICY).messages.map((item) => item.id))
      .toEqual(['u5', 'a5', 'u6', 'a6']);
  });

  test('keeps a history page stable when new messages append', () => {
    const messages = Array.from({ length: 6 }, (_, index) => [
      message(`u${index}`, 'user'),
      message(`a${index}`),
    ]).flat();
    const history = navigateConversationHistory(
      messages,
      createConversationRenderWindowState(),
      'earlier',
      SMALL_POLICY,
    );
    const before = projectConversationRenderWindow(messages, history, SMALL_POLICY);
    const appended = [...messages, message('u6', 'user'), message('a6')];
    const after = projectConversationRenderWindow(appended, history, SMALL_POLICY);
    expect(after.messages.map((item) => item.id)).toEqual(before.messages.map((item) => item.id));
    expect(after.window.hiddenAfter).toBe(before.window.hiddenAfter + 2);
  });

  test('falls back to the latest window when a saved history anchor disappears', () => {
    const messages = [
      message('u1', 'user'),
      message('a1'),
      message('u2', 'user'),
      message('a2'),
      message('u3', 'user'),
      message('a3'),
    ];
    const projection = projectConversationRenderWindow(messages, {
      mode: 'history',
      startMessageId: 'missing',
      endMessageId: 'a1',
    }, SMALL_POLICY);
    expect(projection.window.mode).toBe('latest');
    expect(projection.messages.map((item) => item.id)).toEqual(['u2', 'a2', 'u3', 'a3']);
  });

  test('does not modify the input array', () => {
    const messages = [
      message('u1', 'user'),
      message('a1'),
      message('u2', 'user'),
      message('a2'),
      message('u3', 'user'),
      message('a3'),
    ];
    const before = [...messages];
    projectConversationRenderWindow(messages, undefined, SMALL_POLICY);
    expect(messages).toEqual(before);
  });

  test('selects a bounded tail from 10k messages within the pure-function budget', () => {
    const messages = Array.from({ length: 5_000 }, (_, index) => [
      message(`u${index}`, 'user', `question ${index}`),
      message(`a${index}`, 'assistant', `answer ${index}`),
    ]).flat();
    const state = createConversationRenderWindowState();

    // Warm the runtime before collecting a small deterministic p95 sample.
    projectConversationRenderWindow(messages, state);
    projectConversationRenderWindow(messages, state);
    const durations = Array.from({ length: 20 }, () => {
      const startedAt = performance.now();
      const projection = projectConversationRenderWindow(messages, state);
      const elapsed = performance.now() - startedAt;
      expect(projection.messages.length).toBeLessThanOrEqual(121);
      return elapsed;
    }).sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    expect(p95).toBeLessThanOrEqual(10);
  });
});
