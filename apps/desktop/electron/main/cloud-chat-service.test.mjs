import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudChatService } from './cloud-chat-service.mjs';

const ORIGINAL_FETCH = globalThis.fetch;

function createService() {
  return createCloudChatService({
    getAccessToken: async () => 'sso-token',
    getEndpointConfig: () => ({
      mode: 'pre',
      developerMode: true,
      gatewayUrl: 'https://gateway.example.com',
      streamUrl: 'https://stream.example.com',
      source: 'developer-settings',
    }),
  });
}

function createServiceWithLocalRuntime() {
  return createCloudChatService({
    getAccessToken: async () => 'sso-token',
    getEndpointConfig: () => ({
      mode: 'pre',
      developerMode: true,
      gatewayUrl: 'https://gateway.example.com',
      streamUrl: 'https://stream.example.com',
      source: 'developer-settings',
    }),
    getSession: () => ({
      sessionId: 'session-local-1',
      accessLevel: 'ask_before_local',
    }),
    buildRuntimeProjection: () => ({
      sessionId: 'session-local-1',
      accessLevel: 'ask_before_local',
      capabilities: [
        {
          capabilityId: 'local.shell.exec',
          name: 'Local shell execution',
        },
      ],
      createdAt: '2026-05-25T00:00:00.000Z',
    }),
  });
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test('cloud chat requests trust SSO token and strip spoofable identity fields', async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return jsonResponse({ code: 0, data: { id: 1 } });
  };

  const service = createService();
  await service.createConversation({
    title: 'hello',
    agentId: 1,
    workId: 'spoof-work',
    ownerWorkId: 'spoof-owner',
    operatorWorkId: 'spoof-operator',
    updatedBy: 'spoof-updater',
    empId: 'spoof-emp',
    accountId: 'spoof-account',
    userId: 'spoof-user',
  });

  assert.equal(requests.length, 1);
  const headers = requests[0].init.headers;
  assert.equal(headers.Authorization, 'Bearer sso-token');
  assert.equal(headers['x-zeus-atlas-client'], 'desktop');
  assert.equal(headers['x-zeus-atlas-work-id'], undefined);
  assert.equal(headers['x-zeus-atlas-account-id'], undefined);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    title: 'hello',
    agentId: 1,
  });
});

test('cloud chat GET requests strip spoofable identity fields from query params', async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return jsonResponse({ code: 0, data: {} });
  };

  const service = createService();
  await service.resolveOpenClawEffectiveAgentConfig({
    agentId: 123,
    workId: 'spoof-work',
    ownerWorkId: 'spoof-owner',
    operatorWorkId: 'spoof-operator',
    empId: 'spoof-emp',
    accountId: 'spoof-account',
  });

  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('agentId'), '123');
  assert.equal(url.searchParams.has('workId'), false);
  assert.equal(url.searchParams.has('ownerWorkId'), false);
  assert.equal(url.searchParams.has('operatorWorkId'), false);
  assert.equal(url.searchParams.has('empId'), false);
  assert.equal(url.searchParams.has('accountId'), false);
});

test('cloud chat SSE requests strip spoofable identity fields from stream body', async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/api/auth/sse-ticket')) {
      return jsonResponse({ code: 0, data: { sseTicket: 'ticket-1' } });
    }
    return new Response('', { status: 200 });
  };

  const service = createService();
  const streamEvents = [];
  await service.startMessageStream({
    webContents: {
      send: (channel, payload) => {
        streamEvents.push({ channel, payload });
      },
    },
    params: {
      conversationId: 1,
      content: 'hello',
      workId: 'spoof-work',
      ownerWorkId: 'spoof-owner',
      operatorWorkId: 'spoof-operator',
      empId: 'spoof-emp',
      accountId: 'spoof-account',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(requests.length, 2);
  const streamRequest = requests[1];
  assert.equal(streamRequest.init.headers.Authorization, 'Bearer sso-token');
  assert.equal(streamRequest.init.headers['x-zeus-atlas-work-id'], undefined);
  assert.equal(streamRequest.init.headers['x-zeus-atlas-account-id'], undefined);
  assert.deepEqual(JSON.parse(streamRequest.init.body), {
    conversationId: 1,
    content: 'hello',
    sseTicket: 'ticket-1',
  });
  assert.equal(streamEvents.at(-1)?.channel, 'chat:stream:done');
});

test('cloud chat SSE requests include current client local capability surface', async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/api/auth/sse-ticket')) {
      return jsonResponse({ code: 0, data: { sseTicket: 'ticket-1' } });
    }
    return new Response('', { status: 200 });
  };

  const service = createServiceWithLocalRuntime();
  await service.startMessageStream({
    webContents: {
      send: () => undefined,
    },
    params: {
      conversationId: 1,
      content: 'hello',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  const body = JSON.parse(requests[1].init.body);
  assert.equal(body.sessionId, 'session-local-1');
  assert.equal(body.sourceMetadata.clientRuntimeSessionId, 'session-local-1');
  assert.equal(body.sourceMetadata.clientRuntimeSource, 'zeus_atlas_desktop');
  assert.deepEqual(body.sourceMetadata.clientRuntimeCapabilities, [
    {
      capabilityId: 'local.shell.exec',
      name: 'Local shell execution',
    },
  ]);
  assert.equal(body.sourceMetadata.clientRuntime.projectionId, undefined);
});

/**
 * 把字符串数组组成的 SSE 数据流封装成 Response。每个 chunk 之间不主动 flush，
 * 假装是一次性收到的整段；测试用例上层用 setTimeout 让 main loop 跑完一轮。
 */
function sseResponseFromChunks(chunks) {
  const encoded = chunks.join('');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(encoded));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('main SSE forwards run_started runId and emits chat:stream:done when run is already completed', async () => {
  const requests = [];
  let snapshotCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, init });
    if (u.endsWith('/api/auth/sse-ticket')) {
      return jsonResponse({ code: 0, data: { sseTicket: 'ticket-main' } });
    }
    if (u.includes('/api/chat/messages/stream/authenticated')) {
      return sseResponseFromChunks([
        'event: run_started\ndata: {"runId":"user-uuid-7","conversationId":1}\n\n',
        'event: chat_complete\ndata: {"messageUuid":"a-1"}\n\n',
      ]);
    }
    if (u.includes('/api/chat/agent-runs/user-uuid-7') && !u.includes('user-uuid-7/stream')) {
      snapshotCalls += 1;
      return jsonResponse({ code: 0, data: { runId: 'user-uuid-7', runStatus: 'completed', conversationId: 1 } });
    }
    throw new Error(`unexpected url ${u}`);
  };

  const service = createService();
  const streamEvents = [];
  await service.startMessageStream({
    webContents: {
      send: (channel, payload) => streamEvents.push({ channel, payload }),
    },
    params: { conversationId: 1, content: 'hi' },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));

  const eventChannels = streamEvents.map((e) => e.channel);
  assert.ok(eventChannels.includes('chat:stream:event'));
  assert.equal(eventChannels.at(-1), 'chat:stream:done');
  // 主流结束后应该至少查一次 snapshot 决定要不要重订阅
  assert.equal(snapshotCalls, 1);
  // 不应该尝试拿 run-stream 鉴权 ticket（snapshot 已 terminal）
  assert.equal(
    requests.filter((r) => r.url.endsWith('/api/auth/sse-ticket')).length,
    1,
  );
});

test('main SSE auto-resubscribes to runId-scoped stream when snapshot says suspended', async () => {
  let snapshotCalls = 0;
  const sseTickets = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/api/auth/sse-ticket')) {
      const body = init.body ? JSON.parse(init.body) : {};
      sseTickets.push(body);
      return jsonResponse({
        code: 0,
        data: { sseTicket: body.scene === 'chat_run_stream' ? 'ticket-run' : 'ticket-main' },
      });
    }
    if (u.includes('/api/chat/messages/stream/authenticated')) {
      // 主流：emit run_started 后立刻关流（模拟 stream_paused 之后服务端断流）
      return sseResponseFromChunks([
        'event: run_started\ndata: {"runId":"user-uuid-9","conversationId":1}\n\n',
        'event: client_tool_dispatching\ndata: {"toolCallId":"tc-1"}\n\n',
        'event: stream_paused\ndata: {"reason":"awaiting_client_tool_result"}\n\n',
      ]);
    }
    if (u.includes('/api/chat/agent-runs/user-uuid-9') && !u.includes('user-uuid-9/stream')) {
      snapshotCalls += 1;
      // 第一次 snapshot 说 suspended → 触发重订阅；第二次 completed → 退出
      if (snapshotCalls === 1) {
        return jsonResponse({
          code: 0,
          data: { runId: 'user-uuid-9', runStatus: 'suspended', conversationId: 1 },
        });
      }
      return jsonResponse({
        code: 0,
        data: { runId: 'user-uuid-9', runStatus: 'completed', conversationId: 1 },
      });
    }
    if (u.includes('/api/chat/agent-runs/user-uuid-9/stream')) {
      // run-stream：emit 续聊事件 + run_complete 后关闭
      assert.ok(u.includes('sseTicket=ticket-run'), `expected ticket-run in url, got ${u}`);
      return sseResponseFromChunks([
        'event: client_tool_running\ndata: {"toolCallId":"tc-1"}\n\n',
        'event: client_tool_result_received\ndata: {"toolCallId":"tc-1","status":"success"}\n\n',
        'event: chat_complete\ndata: {"messageUuid":"a-resume"}\n\n',
        'event: run_complete\ndata: {"runId":"user-uuid-9","runStatus":"completed"}\n\n',
      ]);
    }
    throw new Error(`unexpected url ${u}`);
  };

  const service = createService();
  const streamEvents = [];
  await service.startMessageStream({
    webContents: {
      send: (channel, payload) => streamEvents.push({ channel, payload }),
    },
    params: { conversationId: 1, content: 'do shell' },
  });

  await new Promise((resolve) => setTimeout(resolve, 120));

  const eventNames = streamEvents
    .filter((e) => e.channel === 'chat:stream:event')
    .map((e) => e.payload.event.event);
  assert.ok(eventNames.includes('run_started'));
  assert.ok(eventNames.includes('client_tool_dispatching'));
  assert.ok(eventNames.includes('stream_paused'));
  assert.ok(eventNames.includes('client_tool_running'));
  assert.ok(eventNames.includes('client_tool_result_received'));
  assert.ok(eventNames.includes('run_complete'));
  assert.equal(streamEvents.at(-1)?.channel, 'chat:stream:done');
  // 主流断后查 snapshot 一次 → 触发重订阅 → run-stream 结束后再查一次 → completed 退出
  assert.equal(snapshotCalls, 2);
  // 两次 sse-ticket 签发：第一次 chat_message_stream 给主流，第二次 chat_run_stream 给 run-stream
  assert.equal(sseTickets.length, 2);
  assert.equal(sseTickets[0].scene, 'chat_message_stream');
  assert.equal(sseTickets[1].scene, 'chat_run_stream');
  assert.equal(sseTickets[1].messageId, 'user-uuid-9');
});

test('main SSE abort cancels both main stream and active run-scoped stream', async () => {
  let runStreamOpened = false;
  // 用 promise + signal 让 mock 的 ReadableStream 在 abort 时关闭，模拟真实 fetch
  // 取消 reader 的行为。否则 reader.read() 永远 await，测试死锁。
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/api/auth/sse-ticket')) {
      const body = init.body ? JSON.parse(init.body) : {};
      return jsonResponse({
        code: 0,
        data: { sseTicket: body.scene === 'chat_run_stream' ? 'tk-run' : 'tk-main' },
      });
    }
    if (u.includes('/api/chat/messages/stream/authenticated')) {
      return sseResponseFromChunks([
        'event: run_started\ndata: {"runId":"user-abort","conversationId":2}\n\n',
        'event: stream_paused\ndata: {"reason":"awaiting_client_tool_result"}\n\n',
      ]);
    }
    if (u.includes('/api/chat/agent-runs/user-abort') && !u.includes('user-abort/stream')) {
      return jsonResponse({ code: 0, data: { runId: 'user-abort', runStatus: 'suspended', conversationId: 2 } });
    }
    if (u.includes('/api/chat/agent-runs/user-abort/stream')) {
      runStreamOpened = true;
      const signal = init?.signal;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
          if (signal) {
            signal.addEventListener('abort', () => {
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            });
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected url ${u}`);
  };

  const service = createService();
  const streamEvents = [];
  const { streamId } = await service.startMessageStream({
    webContents: {
      send: (channel, payload) => streamEvents.push({ channel, payload }),
    },
    params: { conversationId: 2, content: 'cancel me' },
  });

  // 等到 run-stream 打开 + reader 启动
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(runStreamOpened, 'expected run-stream to be opened before abort');

  const result = service.abortMessageStream({ streamId });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'aborted');

  await new Promise((resolve) => setTimeout(resolve, 60));
  // abort 触发后：run-stream reader 因 signal abort 关闭 → 内 loop 退出 →
  // outer loop 探活时检测到 mainController.signal.aborted 也是 true → break →
  // 走到 send chat:stream:done。
  assert.equal(streamEvents.at(-1)?.channel, 'chat:stream:done');
});
