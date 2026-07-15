import { describe, expect, test } from 'bun:test';

import { createTuiConversationPersistence } from './conversation-persistence.ts';
import type { ChatSnapshot } from './chat-controller.ts';

function createStoreRecorder() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let sequence = 0;
  return {
    calls,
    store: {
      listConversations() { return []; },
      getConversation() { return null; },
      createConversation(input?: unknown) {
        calls.push({ method: 'createConversation', args: [input] });
        return { id: `conversation-${++sequence}` };
      },
      appendMessage(...args: unknown[]) { calls.push({ method: 'appendMessage', args }); },
      updateMode(...args: unknown[]) { calls.push({ method: 'updateMode', args }); },
      updateModelEffort(...args: unknown[]) { calls.push({ method: 'updateModelEffort', args }); },
      addUsage(...args: unknown[]) { calls.push({ method: 'addUsage', args }); },
    },
  };
}

const selection = { providerId: 'provider-a', modelId: 'model-a', reasoningEffort: 'high' } as const;

function snapshot(input: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    status: 'idle',
    mode: 'chat',
    messages: [],
    ...input,
  };
}

describe('TUI conversation persistence', () => {
  test('creates lazily and persists stable messages, model, mode, and usage once', () => {
    const recorder = createStoreRecorder();
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      store: recorder.store,
      now: () => 123,
    });

    persistence.syncSnapshot(snapshot());
    expect(recorder.calls).toHaveLength(0);

    const completed = snapshot({
      messages: [
        { id: 'user-1', role: 'user', content: 'hello' },
        { id: 'assistant-1', role: 'assistant', content: 'world' },
      ],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
    persistence.syncSnapshot(completed);
    persistence.syncSnapshot(completed);

    expect(recorder.calls.filter((call) => call.method === 'createConversation')).toHaveLength(1);
    expect(recorder.calls.filter((call) => call.method === 'appendMessage')).toHaveLength(2);
    expect(recorder.calls.filter((call) => call.method === 'addUsage')).toHaveLength(1);
    expect(recorder.calls.find((call) => call.method === 'createConversation')?.args[0]).toEqual({
      workspacePath: '/workspace',
      mode: 'chat',
    });
    expect(recorder.calls.find((call) => call.method === 'updateModelEffort')?.args[1]).toEqual({
      effort: 'high',
      modelProviderId: 'provider-a::model-a',
    });
  });

  test('lists, loads, and resumes a stored conversation without duplicating its history', () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const stored = {
      id: 'stored-1',
      title: 'Previous session',
      mode: 'goal',
      updatedAt: '2026-07-15T10:00:00.000Z',
      messageCount: 2,
      modelProviderId: 'provider-b::model-b',
      effort: 'low',
      messages: [
        { id: 'old-user', role: 'user', content: 'remember this' },
        { id: 'old-assistant', role: 'assistant', content: 'remembered' },
      ],
    };
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      now: () => 456,
      store: {
        listConversations() {
          return [stored, { ...stored, id: 'empty', messageCount: 0 }];
        },
        getConversation(id: string) {
          return id === stored.id ? stored : null;
        },
        createConversation() {
          throw new Error('resume must not create another conversation');
        },
        appendMessage(...args: unknown[]) { calls.push({ method: 'appendMessage', args }); },
        updateMode(...args: unknown[]) { calls.push({ method: 'updateMode', args }); },
        updateModelEffort(...args: unknown[]) { calls.push({ method: 'updateModelEffort', args }); },
        addUsage(...args: unknown[]) { calls.push({ method: 'addUsage', args }); },
      },
    });

    expect(persistence.listResumable()).toEqual([{
      id: 'stored-1',
      title: 'Previous session',
      updatedAt: '2026-07-15T10:00:00.000Z',
      messageCount: 2,
    }]);
    const restored = persistence.loadConversation('stored-1');
    expect(restored).toEqual({
      id: 'stored-1',
      mode: 'goal',
      messages: [
        { id: 'old-user', role: 'user', content: 'remember this' },
        { id: 'old-assistant', role: 'assistant', content: 'remembered' },
      ],
      modelSelection: { providerId: 'provider-b', modelId: 'model-b', reasoningEffort: 'low' },
    });
    persistence.resumeConversation(restored!);
    persistence.syncSnapshot(snapshot({
      mode: 'goal',
      messages: [
        ...restored!.messages,
        { id: 'new-user', role: 'user', content: 'continue' },
      ],
    }));

    expect(persistence.getConversationId()).toBe('stored-1');
    expect(calls.filter((call) => call.method === 'appendMessage')).toEqual([{
      method: 'appendMessage',
      args: ['stored-1', { id: 'new-user', role: 'user', content: 'continue', timestamp: 456 }],
    }]);
  });

  test('filters the active conversation and ignores missing or corrupt stored sessions', () => {
    const errors: unknown[] = [];
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      store: {
        listConversations() {
          return [{ id: 'active', title: 'Active', messageCount: 1 }];
        },
        getConversation(id: string) {
          if (id === 'active') return {
            id,
            mode: 'chat',
            messages: [{ id: 'one', role: 'user', content: 'hello' }],
          };
          if (id === 'corrupt') throw new Error('corrupt session');
          return null;
        },
        createConversation() { return { id: 'unused' }; },
        appendMessage() {},
        updateMode() {},
        updateModelEffort() {},
        addUsage() {},
      },
      onError: (error) => errors.push(error),
    });

    const active = persistence.loadConversation('active');
    persistence.resumeConversation(active!);
    expect(persistence.listResumable()).toEqual([]);
    expect(persistence.loadConversation('missing')).toBeNull();
    expect(persistence.loadConversation('corrupt')).toBeNull();
    expect(errors).toHaveLength(1);
  });

  test('reports storage failures without breaking the chat lifecycle', () => {
    const errors: unknown[] = [];
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: { providerId: 'provider-a', modelId: 'model-a', reasoningEffort: 'default' },
      store: {
        listConversations() { throw new Error('disk unavailable'); },
        getConversation() { throw new Error('disk unavailable'); },
        createConversation() { throw new Error('disk unavailable'); },
        appendMessage() {},
        updateMode() {},
        updateModelEffort() {},
        addUsage() {},
      },
      onError: (error) => errors.push(error),
    });

    expect(() => persistence.syncSnapshot(snapshot({
      messages: [{ id: 'user-1', role: 'user', content: 'hello' }],
    }))).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(persistence.getConversationId()).toBeUndefined();
  });

  test('does not persist pending assistant content and starts a fresh conversation after clear', () => {
    const recorder = createStoreRecorder();
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      store: recorder.store,
    });

    persistence.syncSnapshot(snapshot({
      status: 'running',
      messages: [
        { id: 'user-1', role: 'user', content: 'first' },
        { id: 'assistant-1', role: 'assistant', content: 'partial', pending: true },
      ],
    }));
    expect(recorder.calls.filter((call) => call.method === 'appendMessage')).toHaveLength(1);

    persistence.startNewConversation('plan');
    persistence.syncSnapshot(snapshot({
      mode: 'plan',
      messages: [{ id: 'user-2', role: 'user', content: 'second' }],
    }));

    expect(recorder.calls.filter((call) => call.method === 'createConversation')).toHaveLength(2);
    expect(persistence.getConversationId()).toBe('conversation-2');
  });
});
