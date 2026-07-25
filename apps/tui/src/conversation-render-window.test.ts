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
    expect(projection.window.reason).toBe('full-session');
    expect(projection.window.hiddenBefore).toBe(0);
  });

  test('shows a long uncompacted session in full instead of applying fallback caps', () => {
    const messages = [
      message('u1', 'user'),
      message('a1'),
      message('u2', 'user'),
      message('a2'),
      message('u3', 'user'),
      message('tool3', 'tool'),
      message('a3'),
    ];
    // Keep emergency high so this asserts fallback removal, not emergency truncation.
    const projection = projectConversationRenderWindow(messages, undefined, {
      ...SMALL_POLICY,
      emergencyMaxMessages: 100,
      emergencyMaxChars: 10_000,
    });
    expect(projection.messages.map((item) => item.id)).toEqual([
      'u1', 'a1', 'u2', 'a2', 'u3', 'tool3', 'a3',
    ]);
    expect(projection.window.reason).toBe('full-session');
    expect(projection.window.hiddenBefore).toBe(0);
    expect(projection.window.emergencyTruncated).toBe(false);
  });

  test('keeps oversized uncompacted messages visible without fallback character truncation', () => {
    const messages = [
      message('u1', 'user', 'x'.repeat(80)),
      message('a1', 'assistant', 'x'.repeat(80)),
      message('u2', 'user', 'x'.repeat(80)),
      message('a2', 'assistant', 'x'.repeat(120)),
    ];
    const projection = projectConversationRenderWindow(messages, undefined, {
      ...SMALL_POLICY,
      emergencyMaxMessages: 100,
      emergencyMaxChars: 10_000,
    });
    expect(projection.messages.map((item) => item.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(projection.window.reason).toBe('full-session');
    expect(projection.window.hiddenBefore).toBe(0);
    expect(projection.window.emergencyTruncated).toBe(false);
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
    // Latest is now the full continuous session (no fallback tail).
    const latest = createConversationRenderWindowState();
    const latestProjection = projectConversationRenderWindow(messages, latest, {
      ...SMALL_POLICY,
      emergencyMaxMessages: 100,
      emergencyMaxChars: 10_000,
    });
    expect(latestProjection.window.reason).toBe('full-session');
    expect(latestProjection.messages.map((item) => item.id)).toEqual(
      messages.map((item) => item.id),
    );

    const earlier = navigateConversationHistory(messages, latest, 'earlier', SMALL_POLICY);
    const earlierProjection = projectConversationRenderWindow(messages, earlier, SMALL_POLICY);
    expect(earlierProjection.window.mode).toBe('history');
    expect(earlierProjection.messages.length).toBeLessThan(messages.length);
    expect(earlierProjection.window.hiddenAfter).toBeGreaterThan(0);

    const earlierAgain = navigateConversationHistory(messages, earlier, 'earlier', SMALL_POLICY);
    const earlierAgainProjection = projectConversationRenderWindow(messages, earlierAgain, SMALL_POLICY);
    expect(earlierAgainProjection.messages.length).toBeLessThan(messages.length);
    expect(earlierAgainProjection.window.startIndex).toBeLessThanOrEqual(
      earlierProjection.window.startIndex,
    );

    const later = navigateConversationHistory(messages, earlierAgain, 'later', SMALL_POLICY);
    const laterProjection = projectConversationRenderWindow(messages, later, SMALL_POLICY);
    expect(laterProjection.window.mode === 'history' || laterProjection.window.mode === 'latest').toBe(true);

    const backToLatest = navigateConversationHistory(messages, later, 'latest', SMALL_POLICY);
    const latestAgain = projectConversationRenderWindow(messages, backToLatest, {
      ...SMALL_POLICY,
      emergencyMaxMessages: 100,
      emergencyMaxChars: 10_000,
    });
    expect(latestAgain.window.mode).toBe('latest');
    expect(latestAgain.messages.map((item) => item.id)).toEqual(messages.map((item) => item.id));
  });

  test('keeps earlier paging moving when the current page is a single oversized message', () => {
    const policy: ConversationRenderWindowPolicy = {
      fallbackMaxMessages: 4,
      fallbackMaxChars: 50,
      historyPageMessages: 4,
      historyPageMaxChars: 50,
      emergencyMaxMessages: 5,
      emergencyMaxChars: 200,
    };
    const messages = [
      ...Array.from({ length: 6 }, (_, index) => [
        message(`u${index}`, 'user', `q${index}`),
        message(`a${index}`, 'assistant', `a${index}`),
      ]).flat(),
      message('huge', 'assistant', 'H'.repeat(10_000)),
      message('u_end', 'user', '需要'),
      message('a_end', 'assistant', 'reply'),
    ];

    let state = createConversationRenderWindowState();
    let projection = projectConversationRenderWindow(messages, state, policy);
    expect(projection.messages.map((item) => item.id)).toEqual(['u_end', 'a_end']);
    expect(projection.window.hiddenBefore).toBeGreaterThan(0);

    // First earlier must leave the latest tail. A huge predecessor may pull its
    // whole turn into the page via start alignment; subsequent earlier must still
    // advance instead of re-anchoring to the same window.
    const firstEarlier = navigateConversationHistory(messages, state, 'earlier', policy);
    const firstProjection = projectConversationRenderWindow(messages, firstEarlier, policy);
    expect(firstProjection.window.mode).toBe('history');
    expect(firstProjection.messages.some((item) => item.id === 'u_end')).toBe(false);
    expect(firstProjection.messages.some((item) => item.id === 'a_end')).toBe(false);
    expect(firstProjection.window.startIndex).toBeLessThan(projection.window.startIndex);
    expect(firstProjection.window.canLoadEarlier).toBe(true);
    expect(firstProjection.window.hiddenBefore).toBeGreaterThan(0);

    const secondEarlier = navigateConversationHistory(messages, firstEarlier, 'earlier', policy);
    const secondProjection = projectConversationRenderWindow(messages, secondEarlier, policy);
    expect(secondProjection.window.mode).toBe('history');
    expect(secondProjection.window.hiddenBefore).toBeLessThan(firstProjection.window.hiddenBefore);
    expect(secondProjection.window.startIndex).toBeLessThan(firstProjection.window.startIndex);

    // Exact screenshot stuck page: only "需要", with the newer reply hidden.
    // earlier must leave that singleton instead of re-selecting it forever.
    const singletonStuck = {
      mode: 'history' as const,
      startMessageId: 'u_end',
      endMessageId: 'u_end',
    };
    const fromSingleton = navigateConversationHistory(messages, singletonStuck, 'earlier', policy);
    const fromSingletonProjection = projectConversationRenderWindow(messages, fromSingleton, policy);
    expect(fromSingletonProjection.window.mode).toBe('history');
    expect(fromSingletonProjection.messages.some((item) => item.id === 'u_end')).toBe(false);
    expect(fromSingletonProjection.window.startIndex).toBeLessThan(
      projectConversationRenderWindow(messages, singletonStuck, policy).window.startIndex,
    );
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
    expect(projection.window.reason).toBe('full-session');
    expect(projection.messages.map((item) => item.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
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

  test('keeps a large uncompacted session fully visible unless emergency caps apply', () => {
    const messages = Array.from({ length: 80 }, (_, index) => [
      message(`u${index}`, 'user', `question ${index}`),
      message(`a${index}`, 'assistant', `answer ${index}`),
    ]).flat();
    const full = projectConversationRenderWindow(messages, createConversationRenderWindowState(), {
      ...SMALL_POLICY,
      emergencyMaxMessages: 10_000,
      emergencyMaxChars: 10_000_000,
    });
    expect(full.window.reason).toBe('full-session');
    expect(full.window.hiddenBefore).toBe(0);
    expect(full.messages).toHaveLength(messages.length);

    const emergency = projectConversationRenderWindow(messages, createConversationRenderWindowState(), {
      ...SMALL_POLICY,
      emergencyMaxMessages: 6,
      emergencyMaxChars: 10_000_000,
    });
    expect(emergency.window.emergencyTruncated).toBe(true);
    expect(emergency.window.hiddenBefore).toBeGreaterThan(0);
    expect(emergency.messages.length).toBeLessThan(messages.length);
  });

  test('projects a large transcript within the pure-function budget', () => {
    const messages = Array.from({ length: 5_000 }, (_, index) => [
      message(`u${index}`, 'user', `question ${index}`),
      message(`a${index}`, 'assistant', `answer ${index}`),
    ]).flat();
    const state = createConversationRenderWindowState();
    const policy = {
      ...SMALL_POLICY,
      emergencyMaxMessages: 120,
      emergencyMaxChars: 10_000_000,
    };

    // Warm the runtime before collecting a small deterministic p95 sample.
    projectConversationRenderWindow(messages, state, policy);
    projectConversationRenderWindow(messages, state, policy);
    const durations = Array.from({ length: 20 }, () => {
      const startedAt = performance.now();
      const projection = projectConversationRenderWindow(messages, state, policy);
      const elapsed = performance.now() - startedAt;
      expect(projection.messages.length).toBeLessThanOrEqual(121);
      return elapsed;
    }).sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    expect(p95).toBeLessThanOrEqual(10);
  });
});
