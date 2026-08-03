import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPanelRevealCoordinator } from './browser-panel-reveal-coordinator.mjs';

test('browser panel reveal coordinator resolves a matching request/ack', async () => {
  const sent = [];
  const coordinator = createBrowserPanelRevealCoordinator({
    broadcast: (channel, payload) => sent.push([channel, payload]),
    isBrowserReady: () => true,
    timeoutMs: 200,
  });

  const pending = coordinator.ensureBrowserReady({
    conversationId: 'conversation-a',
    focus: true,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'browser:panel-reveal-request');
  assert.equal(sent[0][1].conversationId, 'conversation-a');
  assert.equal(sent[0][1].sessionPolicy, 'reuse-or-create');

  assert.equal(coordinator.acknowledge({
    requestId: sent[0][1].requestId,
    conversationId: 'conversation-a',
    status: 'activated',
    sessionId: 'conversation-a',
    focused: true,
  }), true);
  assert.deepEqual(await pending, {
    status: 'activated',
    sessionId: 'conversation-a',
    focused: true,
  });
});

test('browser panel reveal coordinator coalesces concurrent requests for one conversation', async () => {
  const sent = [];
  const coordinator = createBrowserPanelRevealCoordinator({
    broadcast: (_channel, payload) => sent.push(payload),
    timeoutMs: 200,
  });

  const first = coordinator.ensureBrowserReady({ conversationId: 'conversation-a' });
  const second = coordinator.ensureBrowserReady({ conversationId: 'conversation-a' });
  assert.equal(first, second);
  assert.equal(sent.length, 1);
  coordinator.acknowledge({
    requestId: sent[0].requestId,
    conversationId: 'conversation-a',
    status: 'opened',
  });
  assert.deepEqual(await first, {
    status: 'opened',
    sessionId: null,
    focused: true,
  });
});

test('browser panel reveal coordinator rejects cross-conversation acknowledgements', async () => {
  const sent = [];
  const coordinator = createBrowserPanelRevealCoordinator({
    broadcast: (_channel, payload) => sent.push(payload),
    timeoutMs: 30,
  });

  const pending = coordinator.ensureBrowserReady({ conversationId: 'conversation-a' });
  assert.equal(coordinator.acknowledge({
    requestId: sent[0].requestId,
    conversationId: 'conversation-b',
    status: 'opened',
  }), false);
  await assert.rejects(pending, /Timed out while opening the Browser workspace/);
});

test('browser panel reveal coordinator retries a reveal request that was sent before renderer subscribed', async () => {
  const sent = [];
  let ready = false;
  const coordinator = createBrowserPanelRevealCoordinator({
    broadcast: (_channel, payload) => {
      sent.push(payload);
      // Simulate the first event being lost before the renderer subscribes.
      if (sent.length === 2) {
        coordinator.acknowledge({
          requestId: payload.requestId,
          conversationId: payload.conversationId,
          status: 'opened',
        });
        ready = true;
      }
    },
    isBrowserReady: () => ready,
    timeoutMs: 200,
    retryIntervalMs: 25,
  });

  const result = await coordinator.ensureBrowserReady({ conversationId: 'conversation-a' });
  assert.equal(sent.length >= 2, true);
  assert.equal(sent[0].requestId, sent[1].requestId);
  assert.deepEqual(result, { status: 'opened', sessionId: null, focused: true });
  coordinator.dispose();
});

test('browser panel reveal coordinator does not resolve an early ack before registry readiness', async () => {
  const sent = [];
  let ready = false;
  const coordinator = createBrowserPanelRevealCoordinator({
    broadcast: (_channel, payload) => sent.push(payload),
    isBrowserReady: (conversationId) => ready && conversationId === 'conversation-a',
    timeoutMs: 250,
    retryIntervalMs: 25,
  });

  let settled = false;
  const pending = coordinator.ensureBrowserReady({ conversationId: 'conversation-a' });
  pending.finally(() => { settled = true; });
  coordinator.acknowledge({
    requestId: sent[0].requestId,
    conversationId: 'conversation-a',
    status: 'opened',
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(settled, false);
  assert.equal(sent.length >= 2, true);

  ready = true;
  assert.deepEqual(await pending, { status: 'opened', sessionId: null, focused: true });
  coordinator.dispose();
});

test('browser panel reveal coordinator keeps conversations isolated while waiting for readiness', async () => {
  const sent = [];
  const readyConversations = new Set(['conversation-b']);
  const coordinator = createBrowserPanelRevealCoordinator({
    broadcast: (_channel, payload) => sent.push(payload),
    isBrowserReady: (conversationId) => readyConversations.has(conversationId),
    timeoutMs: 250,
    retryIntervalMs: 25,
  });

  let settled = false;
  const pending = coordinator.ensureBrowserReady({ conversationId: 'conversation-a' });
  pending.finally(() => { settled = true; });
  coordinator.acknowledge({
    requestId: sent[0].requestId,
    conversationId: 'conversation-a',
    status: 'opened',
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(settled, false);

  readyConversations.add('conversation-a');
  assert.deepEqual(await pending, { status: 'opened', sessionId: null, focused: true });
  coordinator.dispose();
});

test('browser panel reveal coordinator returns renderer rejection and ignores duplicate ack', async () => {
  const sent = [];
  const coordinator = createBrowserPanelRevealCoordinator({
    broadcast: (_channel, payload) => sent.push(payload),
    timeoutMs: 200,
  });

  const pending = coordinator.ensureBrowserReady({ conversationId: 'conversation-a' });
  const ack = {
    requestId: sent[0].requestId,
    conversationId: 'conversation-a',
    ok: false,
    error: 'conversation_not_foreground',
  };
  assert.equal(coordinator.acknowledge(ack), true);
  await assert.rejects(pending, /conversation_not_foreground/);
  assert.equal(coordinator.acknowledge(ack), false);
});
