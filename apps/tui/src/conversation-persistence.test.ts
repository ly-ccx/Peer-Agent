import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

  test('lists resumable conversations from the current workspace only', () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const current = {
      id: 'current-workspace',
      title: 'Current workspace session',
      updatedAt: '2026-07-15T10:00:00.000Z',
      messageCount: 2,
    };
    const other = {
      id: 'other-workspace',
      title: 'Other workspace session',
      updatedAt: '2026-07-15T11:00:00.000Z',
      messageCount: 4,
    };
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      store: {
        listConversations() {
          throw new Error('global list should not be used');
        },
        listConversationsByWorkspace(...args: unknown[]) {
          calls.push({ method: 'listConversationsByWorkspace', args });
          return [current];
        },
        getConversation(id: string) {
          return id === current.id ? { ...current, messages: [] } : id === other.id ? { ...other, messages: [] } : null;
        },
        createConversation: () => ({ id: 'new' }),
        appendMessage() {},
        updateMode() {},
        updateModelEffort() {},
        addUsage() {},
      },
    });

    expect(persistence.listResumable()).toEqual([{
      id: 'current-workspace',
      title: 'Current workspace session',
      updatedAt: '2026-07-15T10:00:00.000Z',
      messageCount: 2,
    }]);
    expect(calls).toEqual([{
      method: 'listConversationsByWorkspace',
      args: ['/workspace', { status: 'active' }],
    }]);
  });

  test('normalizes a symlinked workspace path before listing and creating conversations', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'peer-tui-workspace-'));
    const canonicalRoot = realpathSync(root);
    const linkedWorkspace = `${root}-link`;
    symlinkSync(root, linkedWorkspace);
    const calls: Array<{ method: string; args: unknown[] }> = [];
    try {
      const persistence = createTuiConversationPersistence({
        workspacePath: linkedWorkspace,
        initialMode: 'chat',
        initialModel: selection,
        store: {
          listConversations() { return []; },
          listConversationsByWorkspace(...args: unknown[]) {
            calls.push({ method: 'listConversationsByWorkspace', args });
            return [];
          },
          getConversation: () => null,
          createConversation(input?: unknown) {
            calls.push({ method: 'createConversation', args: [input] });
            return { id: 'normalized' };
          },
          appendMessage() {},
          updateMode() {},
          updateModelEffort() {},
          addUsage() {},
        },
      });

      persistence.listResumable();
      persistence.syncSnapshot(snapshot({
        messages: [{ id: 'user-normalized', role: 'user', content: 'hello' }],
      }));

      expect(calls).toContainEqual({
        method: 'listConversationsByWorkspace',
        args: [canonicalRoot, { status: 'active' }],
      });
      expect(calls).toContainEqual({
        method: 'createConversation',
        args: [{ workspacePath: canonicalRoot, mode: 'chat' }],
      });
    } finally {
      rmSync(linkedWorkspace, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back to the global list for legacy stores without workspace listing', () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const stored = {
      id: 'legacy-stored',
      title: 'Legacy store session',
      updatedAt: '2026-07-15T10:00:00.000Z',
      messageCount: 2,
    };
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      store: {
        listConversations(...args: unknown[]) {
          calls.push({ method: 'listConversations', args });
          return [stored];
        },
        getConversation: () => ({ ...stored, messages: [] }),
        createConversation: () => ({ id: 'new' }),
        appendMessage() {},
        updateMode() {},
        updateModelEffort() {},
        addUsage() {},
      },
    });

    expect(persistence.listResumable()).toEqual([{
      id: 'legacy-stored',
      title: 'Legacy store session',
      updatedAt: '2026-07-15T10:00:00.000Z',
      messageCount: 2,
    }]);
    expect(calls).toEqual([{
      method: 'listConversations',
      args: [{ status: 'active' }],
    }]);
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
  test('persists assistant tools as Desktop-compatible multi tool-call segments', () => {
    const recorder = createStoreRecorder();
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      store: recorder.store,
    });

    persistence.syncSnapshot(snapshot({
      messages: [
        { id: 'user-1', role: 'user', content: 'read package.json' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'done',
          tools: [
            {
              capabilityId: 'local.file.read',
              toolName: 'Read',
              argumentSummary: 'package.json',
              status: 'completed',
              detail: 'file contents',
              detailLines: ['file contents'],
              toolCallId: 'call-1',
              arguments: { path: 'package.json' },
            },
            {
              capabilityId: 'local.search.files',
              toolName: 'Search',
              argumentSummary: 'foo',
              status: 'completed',
              detail: '2 matches',
              detailLines: ['2 matches'],
              toolCallId: 'call-2',
              arguments: { query: 'foo' },
            },
          ],
        },
      ],
    }));

    const appends = recorder.calls.filter((call) => call.method === 'appendMessage');
    expect(appends.length).toBeGreaterThanOrEqual(2);
    const assistantAppend = appends.find((call) => {
      const message = call.args[1] as Record<string, unknown>;
      return message.role === 'assistant';
    });
    expect(assistantAppend).toBeDefined();
    const message = assistantAppend!.args[1] as Record<string, unknown>;
    expect(message.role).toBe('assistant');
    expect(message.segments).toEqual([
      {
        type: 'tool-call',
        tool: 'local.file.read',
        displayName: 'Read',
        args: { path: 'package.json' },
        result: 'file contents',
        toolCallId: 'call-1',
      },
      {
        type: 'tool-call',
        tool: 'local.search.files',
        displayName: 'Search',
        args: { query: 'foo' },
        result: '2 matches',
        toolCallId: 'call-2',
      },
      {
        type: 'text',
        content: 'done',
      },
    ]);
  });

  test('persists interleaved thinking/tool segments in event order', () => {
    const recorder = createStoreRecorder();
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      store: recorder.store,
    });

    persistence.syncSnapshot(snapshot({
      messages: [
        { id: 'user-1', role: 'user', content: 'go' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'done',
          thinkingContent: 'think1think2',
          tools: [
            {
              capabilityId: 'local.file.read',
              toolName: 'Read',
              argumentSummary: 'a.txt',
              status: 'completed',
              detail: 'ok',
              detailLines: ['ok'],
              toolCallId: 'call-1',
            },
            {
              capabilityId: 'local.search.files',
              toolName: 'Search',
              argumentSummary: 'foo',
              status: 'completed',
              detail: 'ok',
              detailLines: ['ok'],
              toolCallId: 'call-2',
            },
          ],
          segments: [
            { type: 'thinking', content: 'think1' },
            {
              type: 'tool-call',
              tool: {
                capabilityId: 'local.file.read',
                toolName: 'Read',
                argumentSummary: 'a.txt',
                status: 'completed',
                detail: 'ok',
                detailLines: ['ok'],
                toolCallId: 'call-1',
              },
            },
            { type: 'thinking', content: 'think2' },
            {
              type: 'tool-call',
              tool: {
                capabilityId: 'local.search.files',
                toolName: 'Search',
                argumentSummary: 'foo',
                status: 'completed',
                detail: 'ok',
                detailLines: ['ok'],
                toolCallId: 'call-2',
              },
            },
            { type: 'text', content: 'done' },
          ],
        },
      ],
    }));

    const appends = recorder.calls.filter((call) => call.method === 'appendMessage');
    const assistantAppend = appends.find((call) => {
      const message = call.args[1] as Record<string, unknown>;
      return message.role === 'assistant';
    });
    expect(assistantAppend).toBeDefined();
    const message = assistantAppend!.args[1] as Record<string, unknown>;
    expect(message.role).toBe('assistant');
    expect(message.segments).toEqual([
      { type: 'thinking', content: 'think1' },
      {
        type: 'tool-call',
        tool: 'local.file.read',
        displayName: 'Read',
        result: 'ok',
        toolCallId: 'call-1',
      },
      { type: 'thinking', content: 'think2' },
      {
        type: 'tool-call',
        tool: 'local.search.files',
        displayName: 'Search',
        result: 'ok',
        toolCallId: 'call-2',
      },
      { type: 'text', content: 'done' },
    ]);
  });

  test('still persists legacy role=tool rows with a single tool-call segment', () => {
    const recorder = createStoreRecorder();
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      store: recorder.store,
    });

    persistence.syncSnapshot(snapshot({
      messages: [
        { id: 'user-1', role: 'user', content: 'read package.json' },
        {
          id: 'tool-1',
          role: 'tool',
          content: 'file contents',
          tool: {
            capabilityId: 'local.file.read',
            toolName: 'Read',
            argumentSummary: 'package.json',
            status: 'completed',
            detail: 'file contents',
            detailLines: ['file contents'],
            toolCallId: 'call-1',
            arguments: { path: 'package.json' },
          },
        },
      ],
    }));

    const toolAppend = recorder.calls.find((call) => {
      if (call.method !== 'appendMessage') return false;
      const message = call.args[1] as Record<string, unknown>;
      return message.role === 'tool';
    });
    expect(toolAppend).toBeDefined();
    const message = toolAppend!.args[1] as Record<string, unknown>;
    expect(message.segments).toEqual([{
      type: 'tool-call',
      tool: 'local.file.read',
      displayName: 'Read',
      args: { path: 'package.json' },
      result: 'file contents',
      toolCallId: 'call-1',
    }]);
  });


  test('persists user images as Desktop-readable attachments', () => {
    const recorder = createStoreRecorder();
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      store: recorder.store as never,
      now: () => 456,
    });

    const dataUrl = 'data:image/png;base64,aGVsbG8=';
    persistence.syncSnapshot(snapshot({
      messages: [
        {
          id: 'user-img-1',
          role: 'user',
          content: '看一下',
          images: [{ url: dataUrl, mimeType: 'image/png' }],
        },
      ],
    }));

    const append = recorder.calls.find((call) => call.method === 'appendMessage');
    expect(append).toBeTruthy();
    const payload = append?.args[1] as Record<string, unknown>;
    expect(payload.content).toBe('看一下');
    expect(payload).not.toHaveProperty('images');
    expect(payload.attachments).toEqual([
      {
        id: 'user-img-1-image-1',
        name: 'image-1.png',
        mimeType: 'image/png',
        size: 5,
        kind: 'image',
        dataUrl,
      },
    ]);
  });

  test('restores Desktop attachments back into TUI images', () => {
    const dataUrl = 'data:image/png;base64,aGVsbG8=';
    const store = {
      listConversations() {
        return [{
          id: 'stored-img',
          title: 'Image session',
          mode: 'chat',
          updatedAt: '2026-07-15T10:00:00.000Z',
          messageCount: 1,
        }];
      },
      getConversation() {
        return {
          id: 'stored-img',
          mode: 'chat',
          messages: [
            {
              id: 'user-1',
              role: 'user',
              content: '看一下',
              attachments: [
                {
                  id: 'user-1-image-1',
                  name: 'image-1.png',
                  mimeType: 'image/png',
                  size: 5,
                  kind: 'image',
                  dataUrl,
                },
              ],
            },
          ],
        };
      },
      createConversation() { return { id: 'new' }; },
      appendMessage() {},
      updateMode() {},
      updateModelEffort() {},
      addUsage() {},
    };
    const persistence = createTuiConversationPersistence({
      workspacePath: '/workspace',
      initialMode: 'chat',
      initialModel: selection,
      store: store as never,
    });
    const loaded = persistence.loadConversation('stored-img');
    expect(loaded?.messages[0]).toEqual({
      id: 'user-1',
      role: 'user',
      content: '看一下',
      images: [{ url: dataUrl, mimeType: 'image/png' }],
    });
  });

});
