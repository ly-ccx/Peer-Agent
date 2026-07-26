import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createRuntimeSdk } from '@peer-agent/runtime-sdk';

import { createLlmChatService } from '../llm-chat-service.mjs';
import { createDesktopRuntimeSessionAdapter } from './runtime-session-adapter.mjs';

const originalFetch = globalThis.fetch;

function sse(frames) {
  return frames
    .map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
    .join('');
}

function createLlmConfigStore() {
  return {
    listProviders: () => [{
      id: 'provider-1',
      provider: 'openai',
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      isDefault: true,
      apiKeyConfigured: true,
    }],
    getDecryptedApiKey: () => 'test-key',
  };
}

function createWebContents(events = []) {
  return {
    send: (channel, payload) => events.push({ channel, payload }),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Desktop chat Runtime session lifecycle', () => {
  it('persists the shared context accounting snapshot on normal completion', async () => {
    globalThis.fetch = async () => new Response(sse([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {} }], usage: { prompt_tokens: 120, completion_tokens: 2 } },
      '[DONE]',
    ]), { status: 200 });

    const snapshots = [];
    const conversationStore = {
      updateContextSnapshot: (conversationId, snapshot) => {
        snapshots.push({ conversationId, snapshot });
        return { id: conversationId, contextSnapshot: snapshot };
      },
    };
    const service = createLlmChatService({
      llmConfigStore: createLlmConfigStore(),
      conversationStore,
      runtimeSessionAdapter: createDesktopRuntimeSessionAdapter(),
    });
    const events = [];

    const outcome = await service.sendMessage({
      messages: [{ role: 'user', content: 'hello' }],
      streamId: 'stream-context-snapshot',
      conversationId: 'conversation-context-snapshot',
      webContents: createWebContents(events),
    });

    assert.equal(outcome.terminalStatus, 'done');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].conversationId, 'conversation-context-snapshot');
    assert.equal(snapshots[0].snapshot.version, 1);
    assert.equal(snapshots[0].snapshot.authoritativeInputTokens, 120);
    assert.equal(snapshots[0].snapshot.pressureSource, 'provider_usage');
    const done = events.find((event) => event.channel === 'chat:stream:done');
    assert.deepEqual(done.payload.contextAccounting, snapshots[0].snapshot);
  });

  it('resumes the same SDK session across consecutive conversation turns', async () => {
    globalThis.fetch = async () => new Response(sse([
      { choices: [{ delta: { content: 'ok' } }] },
      '[DONE]',
    ]), { status: 200 });
    const runtimeSessionAdapter = createDesktopRuntimeSessionAdapter();
    const runtimeEvents = [];
    const runtime = createRuntimeSdk({
      host: {
        executeProvider: () => { throw new Error('not used'); },
        createBlockedExecution: () => { throw new Error('not used'); },
      },
    });
    runtime.subscribe((event) => runtimeEvents.push(event));
    const service = createLlmChatService({
      llmConfigStore: createLlmConfigStore(),
      runtimeSessionAdapter,
      emitRuntimeEvent: (event) => runtime.emit(event),
    });

    const first = await service.sendMessage({
      messages: [{ role: 'user', content: 'first' }],
      streamId: 'stream-1',
      conversationId: 'conversation-1',
      webContents: createWebContents(),
    });
    const firstSession = runtimeSessionAdapter.getSession('conversation-1');

    const second = await service.sendMessage({
      messages: [{ role: 'user', content: 'second' }],
      streamId: 'stream-2',
      conversationId: 'conversation-1',
      webContents: createWebContents(),
    });
    const resumedSession = runtimeSessionAdapter.getSession('conversation-1');

    assert.equal(first.terminalStatus, 'done');
    assert.equal(second.terminalStatus, 'done');
    assert.equal(firstSession.sessionId, 'conversation-1');
    assert.equal(firstSession.lastTurn.turnIndex, 0);
    assert.equal(firstSession.lastTurn.streamId, 'stream-1');
    assert.equal(resumedSession.sessionId, 'conversation-1');
    assert.equal(resumedSession.lastTurn.turnIndex, 1);
    assert.equal(resumedSession.lastTurn.turnId, 'conversation-1:turn:1');
    assert.equal(resumedSession.lastTurn.streamId, 'stream-2');
    assert.equal(resumedSession.nextTurnIndex, 2);
    assert.deepEqual(
      runtimeEvents.map((event) => event.sequence),
      runtimeEvents.map((_, index) => index + 1),
    );
    const lifecycleEvents = runtimeEvents.filter((event) => event.type !== 'context.accounting');
    assert.deepEqual(lifecycleEvents.map((event) => event.streamId), [
      'stream-1',
      'stream-1',
      'stream-1',
      'stream-2',
      'stream-2',
      'stream-2',
    ]);
    assert.equal(runtimeEvents.some((event) => event.type === 'context.accounting'), true);
  });

  it('propagates Desktop abort through the SDK-owned signal and preserves cancelled state', async () => {
    let resolveFetchStarted;
    const fetchStarted = new Promise((resolve) => { resolveFetchStarted = resolve; });
    globalThis.fetch = async (_url, init = {}) => {
      resolveFetchStarted();
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (init.signal?.aborted) rejectAbort();
        else init.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    };

    const runtimeSessionAdapter = createDesktopRuntimeSessionAdapter();
    const events = [];
    const service = createLlmChatService({
      llmConfigStore: createLlmConfigStore(),
      runtimeSessionAdapter,
    });
    const outcomePromise = service.sendMessage({
      messages: [{ role: 'user', content: 'wait' }],
      streamId: 'stream-abort',
      conversationId: 'conversation-abort',
      webContents: createWebContents(events),
    });

    await fetchStarted;
    const abortResult = service.abort('stream-abort');
    const outcome = await outcomePromise;
    const session = runtimeSessionAdapter.getSession('conversation-abort');

    assert.deepEqual(abortResult, { aborted: true });
    assert.equal(outcome.terminalStatus, 'aborted');
    assert.equal(session.status, 'idle');
    assert.equal(session.lastTurn.status, 'cancelled');
    assert.equal(session.lastTurn.reason, 'user_aborted');
    assert.equal(session.lastTurn.streamId, 'stream-abort');
    assert.equal(events.filter((event) => event.channel === 'chat:stream:aborted').length, 1);
    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), false);
  });

  it('resolves released on force-complete so goal handoff does not hang', async () => {
    let resolveFetchStarted;
    const fetchStarted = new Promise((resolve) => { resolveFetchStarted = resolve; });
    globalThis.fetch = async (_url, init = {}) => {
      resolveFetchStarted();
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (init.signal?.aborted) rejectAbort();
        else init.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    };

    const runtimeSessionAdapter = createDesktopRuntimeSessionAdapter();
    const runtimeEvents = [];
    const service = createLlmChatService({
      llmConfigStore: createLlmConfigStore(),
      runtimeSessionAdapter,
    });
    const outcomePromise = service.sendMessage({
      messages: [{ role: 'user', content: 'wait' }],
      streamId: 'stream-handoff',
      conversationId: 'conversation-handoff',
      webContents: createWebContents(runtimeEvents),
    });

    await fetchStarted;
    const handoff = service.forceCompleteConversationStreams('conversation-handoff', {
      reason: 'goal_handoff',
      graceMs: 20,
    });
    assert.equal(handoff.completed >= 1, true);
    assert.equal(
      runtimeEvents.some((event) => event.channel === 'chat:stream:done'),
      false,
      'handoff must not steal the normal agent-loop done before the grace window',
    );
    await assert.doesNotReject(
      () => Promise.race([
        handoff.released,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('released hung after force-complete')), 200);
        }),
      ]),
    );
    assert.equal(
      runtimeEvents.some((event) => event.channel === 'chat:stream:done'),
      true,
      'timeout fallback must still unlock the renderer',
    );
    await outcomePromise;
    assert.equal(runtimeSessionAdapter.getSession('conversation-handoff')?.status, 'idle');
  });

  it('allows a new turn after abort without stale active-turn lock', async () => {
    let resolveFetchStarted;
    const fetchStarted = new Promise((resolve) => { resolveFetchStarted = resolve; });
    globalThis.fetch = async (_url, init = {}) => {
      resolveFetchStarted();
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (init.signal?.aborted) rejectAbort();
        else init.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    };

    const runtimeSessionAdapter = createDesktopRuntimeSessionAdapter();
    const service = createLlmChatService({
      llmConfigStore: createLlmConfigStore(),
      runtimeSessionAdapter,
    });
    const firstOutcome = service.sendMessage({
      messages: [{ role: 'user', content: 'wait' }],
      streamId: 'stream-abort-1',
      conversationId: 'conversation-resume',
      webContents: createWebContents(),
    });
    await fetchStarted;
    service.abort('stream-abort-1');
    await firstOutcome;

    globalThis.fetch = async () => new Response(sse([
      { choices: [{ delta: { content: 'ok' } }] },
      '[DONE]',
    ]), { status: 200 });
    // If abort left an active turn / unresolved lock, this would throw.
    const second = await service.sendMessage({
      messages: [{ role: 'user', content: 'continue' }],
      streamId: 'stream-abort-2',
      conversationId: 'conversation-resume',
      webContents: createWebContents(),
    });
    assert.ok(['completed', 'done'].includes(second.terminalStatus), `unexpected terminalStatus: ${second.terminalStatus}`);
    assert.equal(runtimeSessionAdapter.getSession('conversation-resume')?.status, 'idle');
  });
});
