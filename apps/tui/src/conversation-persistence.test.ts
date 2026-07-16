import { describe, expect, test } from 'bun:test';

import {
  createTuiConversationPersistence,
  resumeTuiConversation,
} from './conversation-persistence.ts';
import {
  createChatController,
  createDemoChatModel,
  type ChatSnapshot,
} from './chat-controller.ts';
import type { TuiHost } from './tui-host.ts';

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

function inertHost(): TuiHost {
  return {
    workspaceRoot: '/workspace',
    capabilities: [],
    toolDefinitions: [],
    getAccessLevel: () => 'ask_before_local',
    setAccessLevel: () => 'ask_before_local',
    execute: async () => { throw new Error('not used'); },
    executeRead: async () => { throw new Error('not used'); },
    executeShell: async () => { throw new Error('not used'); },
    subscribe: () => () => {},
    subscribeApproval: () => () => {},
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
    expect(recorder.calls.filter((call) => call.method === 'appendMessage').at(-1)?.args[1]).toEqual({
      id: 'assistant-1',
      role: 'assistant',
      content: 'world',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      timestamp: 123,
    });
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
      usage: { inputTokens: 27, totalTokens: 27 },
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

  test('restores context usage before publishing without creating a duplicate conversation', () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const stored = {
      id: 'stored-ctx',
      title: 'Context session',
      mode: 'chat',
      messageCount: 2,
      messages: [
        { id: 'old-user', role: 'user', content: 'remember this context' },
        {
          id: 'old-assistant',
          role: 'assistant',
          content: 'context remembered',
          usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 },
        },
      ],
    };
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      store: {
        listConversations: () => [stored],
        getConversation: (id: string) => id === stored.id ? stored : null,
        createConversation(input?: unknown) {
          calls.push({ method: 'createConversation', args: [input] });
          return { id: 'duplicate' };
        },
        appendMessage(...args: unknown[]) { calls.push({ method: 'appendMessage', args }); },
        updateMode(...args: unknown[]) { calls.push({ method: 'updateMode', args }); },
        updateModelEffort(...args: unknown[]) { calls.push({ method: 'updateModelEffort', args }); },
        addUsage(...args: unknown[]) { calls.push({ method: 'addUsage', args }); },
      },
    });
    const controller = createChatController({ host: inertHost(), model: createDemoChatModel() });
    const unsubscribe = controller.subscribe((next) => persistence.syncSnapshot(next));
    const restored = persistence.loadConversation(stored.id);

    expect(restored).not.toBeNull();
    expect(resumeTuiConversation(controller, persistence, restored!)).toBe(true);

    expect(calls.filter((call) => call.method === 'createConversation')).toHaveLength(0);
    expect(persistence.getConversationId()).toBe(stored.id);
    expect(controller.getSnapshot().usage).toEqual({
      inputTokens: 120,
      outputTokens: 8,
      totalTokens: 128,
    });
    unsubscribe();
  });

  test('estimates restored context for legacy conversations without per-message usage', () => {
    const stored = {
      id: 'legacy-context',
      mode: 'chat',
      messages: [
        { id: 'legacy-user', role: 'user', content: '请继续分析这个历史会话' },
        { id: 'legacy-assistant', role: 'assistant', content: 'Existing context in English.' },
      ],
    };
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      store: {
        listConversations: () => [stored],
        getConversation: (id: string) => id === stored.id ? stored : null,
        createConversation: () => ({ id: 'unused' }),
        appendMessage() {},
        updateMode() {},
        updateModelEffort() {},
        addUsage() {},
      },
    });

    const restored = persistence.loadConversation(stored.id);

    expect(restored).not.toBeNull();
    expect(restored?.usage).toEqual({ inputTokens: 34, totalTokens: 34 });
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
