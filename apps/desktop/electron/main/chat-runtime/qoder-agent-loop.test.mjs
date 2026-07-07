import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agentLoopQoder, parseQoderLiteralToolCalls } from './qoder-agent-loop.mjs';
import { createToolContext } from './tool-orchestrator.mjs';

describe('agentLoopQoder', () => {
  it('parses GLM literal tool_call blocks only when the content is purely tool calls', () => {
    assert.deepEqual(
      parseQoderLiteralToolCalls('<tool_call>{"name":"bash","input":{"command":"pwd"}}</tool_call>'),
      [{ id: 'qoder_literal_tool_1', name: 'bash', arguments: '{"command":"pwd"}' }],
    );
    assert.deepEqual(
      parseQoderLiteralToolCalls('&lt;tool_call&gt;\n{"name":"bash","input":{"command":"pwd"}}\n&lt;/tool_call&gt;'),
      [{ id: 'qoder_literal_tool_1', name: 'bash', arguments: '{"command":"pwd"}' }],
    );
    assert.deepEqual(
      parseQoderLiteralToolCalls('example: <tool_call>{"name":"bash","input":{}}</tool_call>'),
      [],
    );
  });

  it('starts Qoder tool turns in literal mode and continues with flattened tool results', async () => {
    const sent = [];
    const attempts = [];
    const sendStream = async (args) => {
      attempts.push(args);
      if (attempts.length === 1) {
        return {
          ok: true,
          content: '',
          thinkingContent: '',
          toolCalls: [{ id: 'call_1', name: 'missing_tool', arguments: '{"value":1}' }],
          streamUsage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return {
        ok: true,
        content: 'done',
        thinkingContent: '',
        toolCalls: [],
        streamUsage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'gm51model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'run a tool' }],
      tools: [{ type: 'function', function: { name: 'missing_tool', parameters: { type: 'object' } } }],
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-tool',
      contextWindow: 1000,
      toolContext: createToolContext({ conversationId: 'conv-qoder-loop', mode: 'chat' }),
      permissionGate: {
        createFilePermissionRequester: () => async () => ({ granted: true }),
        createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }),
        createShellApprovalDecider: () => async () => ({ approved: true }),
      },
      sendStream,
    });

    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].tools, []);
    assert.ok(attempts[0].messages.some((message) => /Qoder literal tool-call dialect/.test(message.content)));
    assert.ok(attempts[0].messages.some((message) => /Available tool names: missing_tool/.test(message.content)));
    assert.equal(attempts[1].messages.at(-1).role, 'user');
    assert.match(attempts[1].messages.at(-1).content, /Unknown tool: missing_tool/);
    assert.equal(attempts[1].messages.some((message) => message.role === 'tool'), false);
    assert.equal(attempts[1].messages.some((message) => /\[tool_call|\[tool_result/.test(message.content)), false);
    assert.ok(sent.some((event) => event.channel === 'chat:stream:tool-call'));
    assert.ok(sent.some((event) => event.channel === 'chat:stream:tool-result'));
    assert.ok(sent.some((event) => event.channel === 'chat:stream:done'));
  });

  it('executes pure GLM literal tool_call text as a Qoder tool-call dialect', async () => {
    const sent = [];
    const attempts = [];
    const sendStream = async (args) => {
      attempts.push(args);
      if (attempts.length === 1) {
        return {
          ok: true,
          content: '<tool_call>{"name":"missing_tool","input":{"value":1}}</tool_call>',
          thinkingContent: '',
          toolCalls: [],
          streamUsage: null,
        };
      }
      return {
        ok: true,
        content: 'done',
        thinkingContent: '',
        toolCalls: [],
        streamUsage: null,
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'gm51model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'run a tool' }],
      tools: [{ type: 'function', function: { name: 'missing_tool', parameters: { type: 'object' } } }],
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-literal-tool',
      permissionGate: {
        createFilePermissionRequester: () => async () => ({ granted: true }),
        createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }),
        createShellApprovalDecider: () => async () => ({ approved: true }),
      },
      sendStream,
    });

    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].tools, []);
    assert.ok(attempts[0].messages.some((message) => /Qoder literal tool-call dialect/.test(message.content)));
    assert.equal(attempts[1].messages.at(-1).role, 'user');
    assert.match(attempts[1].messages.at(-1).content, /Unknown tool: missing_tool/);
    assert.equal(attempts[1].messages.some((message) => message.role === 'tool'), false);
    assert.ok(sent.some((event) => event.channel === 'chat:stream:tool-call'));
    assert.ok(sent.some((event) => event.channel === 'chat:stream:done'));
  });

  it('executes HTML-escaped Qoder literal tool_call text', async () => {
    const sent = [];
    const attempts = [];
    const sendStream = async (args) => {
      attempts.push(args);
      if (attempts.length === 1) {
        return {
          ok: true,
          content: '&lt;tool_call&gt;\n{"name":"missing_tool","input":{"value":1}}\n&lt;/tool_call&gt;',
          thinkingContent: '',
          toolCalls: [],
          streamUsage: null,
        };
      }
      return {
        ok: true,
        content: 'done',
        thinkingContent: '',
        toolCalls: [],
        streamUsage: null,
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'gm51model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'run a tool' }],
      tools: [{ type: 'function', function: { name: 'missing_tool', parameters: { type: 'object' } } }],
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-escaped-literal-tool',
      permissionGate: {
        createFilePermissionRequester: () => async () => ({ granted: true }),
        createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }),
        createShellApprovalDecider: () => async () => ({ approved: true }),
      },
      sendStream,
    });

    assert.equal(attempts.length, 2);
    assert.match(attempts[1].messages.at(-1).content, /Unknown tool: missing_tool/);
    assert.ok(sent.some((event) => event.channel === 'chat:stream:tool-call'));
    assert.ok(sent.some((event) => event.channel === 'chat:stream:done'));
  });

  it('does not enter the native tool conversion path for Qoder tool turns', async () => {
    const sent = [];
    const attempts = [];
    const sendStream = async (args) => {
      attempts.push(args);
      if (attempts.length === 1) {
        return {
          ok: true,
          content: '<tool_call>{"name":"missing_tool","input":{"value":1}}</tool_call>',
          thinkingContent: '',
          toolCalls: [],
          streamUsage: null,
        };
      }
      return {
        ok: true,
        content: 'done',
        thinkingContent: '',
        toolCalls: [],
        streamUsage: null,
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'ultimate',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'run a tool' }],
      tools: [{ type: 'function', function: { name: 'missing_tool', parameters: { type: 'object' } } }],
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-tool-conversion-fallback',
      permissionGate: {
        createFilePermissionRequester: () => async () => ({ granted: true }),
        createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }),
        createShellApprovalDecider: () => async () => ({ approved: true }),
      },
      sendStream,
    });

    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].tools, []);
    assert.ok(attempts[0].messages.some((message) => /Qoder literal tool-call dialect/.test(message.content)));
    assert.equal(attempts[1].messages.at(-1).role, 'user');
    assert.match(attempts[1].messages.at(-1).content, /Unknown tool: missing_tool/);
    assert.equal(attempts[1].messages.some((message) => Array.isArray(message.tool_calls)), false);
    assert.ok(sent.some((event) => event.channel === 'chat:stream:tool-call'));
    assert.ok(sent.some((event) => event.channel === 'chat:stream:done'));
  });

  it('surfaces HTTP 500 when Qoder fails after native tools have already been skipped', async () => {
    const sent = [];
    const attempts = [];
    const sendStream = async (args) => {
      attempts.push(args);
      return {
        ok: false,
        status: 500,
        errorText: '{"error":"internal server error"}',
        providerTracePath: '/tmp/qoder-500-trace.jsonl',
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'ultimate',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'run a tool' }],
      tools: [{ type: 'function', function: { name: 'missing_tool', parameters: { type: 'object' } } }],
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-http-500-fallback',
      permissionGate: {
        createFilePermissionRequester: () => async () => ({ granted: true }),
        createLocalCapabilityPermissionRequester: () => async () => ({ granted: true }),
        createShellApprovalDecider: () => async () => ({ approved: true }),
      },
      sendStream,
    });

    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].tools, []);
    assert.ok(attempts[0].messages.some((message) => /Qoder literal tool-call dialect/.test(message.content)));
    const error = sent.find((event) => event.channel === 'chat:stream:error');
    assert.match(error?.payload?.error, /HTTP 500/);
    assert.equal(sent.some((event) => event.channel === 'chat:stream:done'), false);
  });

  it('flattens historical native tool protocol when Qoder literal mode is active', async () => {
    const attempts = [];
    const sendStream = async (args) => {
      attempts.push(args);
      return {
        ok: true,
        content: 'done',
        thinkingContent: '',
        toolCalls: [],
        streamUsage: null,
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'ultimate',
      systemPrompt: 'system',
      messages: [
        { role: 'user', content: 'inspect repo' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tool_call_0',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"pwd"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'tool_call_0', content: '/tmp/project' },
        { role: 'user', content: 'continue' },
      ],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      webContents: { send: () => {} },
      streamId: 'qoder-loop-flatten-history',
      sendStream,
    });

    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].tools, []);
    assert.equal(attempts[0].messages.some((message) => message.role === 'tool'), false);
    assert.equal(attempts[0].messages.some((message) => Array.isArray(message.tool_calls)), false);
    assert.equal(attempts[0].messages.some((message) => message.tool_call_id), false);
    assert.equal(attempts[0].messages.some((message) => /\[tool_call|\[tool_result/.test(message.content)), false);
    assert.ok(attempts[0].messages.some((message) => /Result from bash:\n\/tmp\/project/.test(message.content)));
    assert.ok(attempts[0].messages.some((message) => /Available tool names: bash/.test(message.content)));
  });

  it('retries instead of displaying literal GLM tool_call text', async () => {
    const attempts = [];
    const sent = [];
    const sendStream = async (args) => {
      attempts.push(args);
      if (attempts.length === 1) {
        return {
          ok: true,
          content: 'I should call <tool_call>{"name":"bash","input":{"command":"pwd"}}</tool_call>',
          thinkingContent: '',
          toolCalls: [],
          streamUsage: null,
        };
      }
      return {
        ok: true,
        content: 'clean answer',
        thinkingContent: '',
        toolCalls: [],
        streamUsage: null,
      };
    };

    await agentLoopQoder({
      baseUrl: 'https://example.test/model/v1',
      apiKey: 'token',
      model: 'gm51model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'search repo' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
      streamId: 'qoder-loop-leaked-tool',
      sendStream,
    });

    assert.equal(attempts.length, 2);
    assert.ok(attempts[1].messages.some((message) => /emitted no actual tool call/.test(message.content)));
    assert.ok(attempts[1].messages.some((message) => /Qoder literal tool-call dialect/.test(message.content)));
    assert.ok(sent.some((event) => event.channel === 'chat:stream:done'));
  });
});
