import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { executeProjectedModelTool } from './chat-runtime/projected-tool-executor.mjs';
import { createToolContext } from './chat-runtime/tool-orchestrator.mjs';

let tmpDir;

async function loadService() {
  return import(`./llm-chat-service.mjs?test=${Date.now()}-${Math.random()}`);
}

function sse(frames) {
  return frames.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
}

async function runProjectedTool(name, args, workspacePath, toolContext = null, options = {}) {
  return executeProjectedModelTool({
    name,
    args,
    workspacePath,
    toolContext,
    requestPermission: options?.requestPermission,
    shellApprovalDecider: options?.shellApprovalDecider,
    toolCallId: options?.toolCallId,
    registry: options?.registry,
    runtimeProjection: options?.runtimeProjection,
  });
}

describe('llm chat service tool materialization', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'llm-chat-service-'));
    process.env.PEER_AGENT_HOME = tmpDir;
  });

  afterEach(() => {
    delete process.env.PEER_AGENT_HOME;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('materializes bash output as an artifact-backed local tool result ref', async () => {
    const result = await runProjectedTool(
      'bash',
      { command: 'node -e "process.stdout.write(\'x\'.repeat(12000))"' },
      tmpDir,
      null,
      { shellApprovalDecider: async () => ({ granted: true, reason: 'test_approved' }) },
    );

    assert.equal(result.success, true);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.kind, 'local_tool_result_ref');
    assert.equal(parsed.tool, 'bash');
    assert.equal(parsed.stdoutChars, 12000);
    assert.equal(parsed.contextPreviewTruncated, true);
    assert.equal(parsed.stdoutPreview.length < 5000, true);
    assert.equal(existsSync(parsed.stdoutPath), true);
    assert.equal(readFileSync(parsed.stdoutPath, 'utf8').length, 12000);
    assert.equal(parsed.suggestedRetrieval.length > 0, true);
  });

  it('materializes large file reads as a local file ref', async () => {
    const filePath = path.join(tmpDir, 'large.txt');
    writeFileSync(filePath, 'line\n'.repeat(3000), 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: tmpDir });

    const result = await runProjectedTool('read_file', { path: filePath }, tmpDir, toolContext);

    assert.equal(result.success, true);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.kind, 'local_file_ref');
    assert.equal(parsed.path, filePath);
    assert.equal(parsed.fullRead, true);
    assert.equal(typeof parsed.mtimeMs, 'number');
    assert.equal(parsed.sizeBytes > 0, true);
    assert.equal(parsed.contentHash.length, 64);
    assert.equal(parsed.contextPreviewTruncated, true);
    assert.equal(parsed.preview.length < 5000, true);
    assert.equal(parsed.suggestedRetrieval.some((cmd) => cmd.includes(filePath)), true);
  });

  it('rejects edit_file before the file has been read', async () => {
    const filePath = path.join(tmpDir, 'app.js');
    writeFileSync(filePath, 'const value = 1;\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: tmpDir });

    const result = await runProjectedTool(
      'edit_file',
      { path: filePath, old_string: '1', new_string: '2' },
      tmpDir,
      toolContext,
    );

    assert.equal(result.success, false);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.tool, 'edit_file');
    assert.equal(parsed.status, 'blocked');
    assert.match(parsed.reason, /must be read/);
    assert.equal(readFileSync(filePath, 'utf8'), 'const value = 1;\n');
  });

  it('edits an existing file with an exact old_string after read_file', async () => {
    const filePath = path.join(tmpDir, 'app.js');
    writeFileSync(filePath, 'const value = 1;\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: tmpDir });

    await runProjectedTool('read_file', { path: filePath }, tmpDir, toolContext);
    const result = await runProjectedTool(
      'edit_file',
      { path: filePath, old_string: 'const value = 1;', new_string: 'const value = 2;' },
      tmpDir,
      toolContext,
    );

    assert.equal(result.success, true);
    assert.equal(readFileSync(filePath, 'utf8'), 'const value = 2;\n');
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.kind, 'file_edit_result');
    assert.equal(parsed.replacements, 1);
    assert.match(parsed.diffPreview, /-const value = 1;/);
    assert.match(parsed.diffPreview, /\+const value = 2;/);
    assert.equal(parsed.contentHashBefore.length, 64);
    assert.equal(parsed.contentHashAfter.length, 64);
  });

  it('requires replace_all for repeated old_string matches', async () => {
    const filePath = path.join(tmpDir, 'copy.txt');
    writeFileSync(filePath, 'same\nsame\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: tmpDir });

    await runProjectedTool('read_file', { path: filePath }, tmpDir, toolContext);
    const blocked = await runProjectedTool(
      'edit_file',
      { path: filePath, old_string: 'same', new_string: 'done' },
      tmpDir,
      toolContext,
    );

    assert.equal(blocked.success, false);
    assert.match(JSON.parse(blocked.output).reason, /matched 2 times/);
    assert.equal(readFileSync(filePath, 'utf8'), 'same\nsame\n');

    const replaced = await runProjectedTool(
      'edit_file',
      { path: filePath, old_string: 'same', new_string: 'done', replace_all: true },
      tmpDir,
      toolContext,
    );

    assert.equal(replaced.success, true);
    assert.equal(JSON.parse(replaced.output).replacements, 2);
    assert.equal(readFileSync(filePath, 'utf8'), 'done\ndone\n');
  });

  it('rejects edit_file when the file changed after read_file', async () => {
    const filePath = path.join(tmpDir, 'stale.txt');
    writeFileSync(filePath, 'before\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: tmpDir });

    await runProjectedTool('read_file', { path: filePath }, tmpDir, toolContext);
    writeFileSync(filePath, 'external change\n', 'utf8');
    const result = await runProjectedTool(
      'edit_file',
      { path: filePath, old_string: 'before', new_string: 'after' },
      tmpDir,
      toolContext,
    );

    assert.equal(result.success, false);
    assert.match(JSON.parse(result.output).reason, /File changed after it was read/);
    assert.equal(readFileSync(filePath, 'utf8'), 'external change\n');
  });

  it('tightens write_file for existing files and allows explicit full replacement after read_file', async () => {
    const filePath = path.join(tmpDir, 'replace.txt');
    writeFileSync(filePath, 'old\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: tmpDir });

    const blocked = await runProjectedTool('write_file', { path: filePath, content: 'new\n' }, tmpDir, toolContext);
    assert.equal(blocked.success, false);
    assert.match(JSON.parse(blocked.output).reason, /allow_overwrite=true/);
    assert.equal(readFileSync(filePath, 'utf8'), 'old\n');

    await runProjectedTool('read_file', { path: filePath }, tmpDir, toolContext);
    const replaced = await runProjectedTool(
      'write_file',
      { path: filePath, content: 'new\n', allow_overwrite: true },
      tmpDir,
      toolContext,
    );

    assert.equal(replaced.success, true);
    assert.equal(readFileSync(filePath, 'utf8'), 'new\n');
    const parsed = JSON.parse(replaced.output);
    assert.equal(parsed.kind, 'file_write_result');
    assert.equal(parsed.created, false);
    assert.match(parsed.diffPreview, /-old/);
    assert.match(parsed.diffPreview, /\+new/);
  });

  it('keeps out-of-workspace write_file blocked when no permission requester is available', async () => {
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    const outsidePath = path.join(outsideDir, 'new.txt');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: workspaceDir });

    const result = await runProjectedTool(
      'write_file',
      { path: outsidePath, content: 'outside\n' },
      workspaceDir,
      toolContext,
    );

    assert.equal(result.success, false);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.tool, 'write_file');
    assert.equal(parsed.status, 'blocked');
    assert.match(parsed.reason, /outside the active workspace/);
    assert.equal(existsSync(outsidePath), false);
  });

  it('writes outside the active workspace only after permission approval', async () => {
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    const outsidePath = path.join(outsideDir, 'new.txt');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: workspaceDir });
    let requested = null;

    const result = await runProjectedTool(
      'write_file',
      { path: outsidePath, content: 'outside\n' },
      workspaceDir,
      toolContext,
      {
        requestPermission: async (request) => {
          requested = request;
          return { granted: true, reason: 'test_approved' };
        },
      },
    );

    assert.equal(result.success, true);
    assert.equal(readFileSync(outsidePath, 'utf8'), 'outside\n');
    assert.equal(requested.tool, 'write_file');
    assert.equal(requested.filePath, outsidePath);
    assert.equal(requested.workspacePath, workspaceDir);
    assert.equal(JSON.parse(result.output).kind, 'file_write_result');
  });

  it('does not mutate an outside file when edit_file permission is denied', async () => {
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    const outsidePath = path.join(outsideDir, 'app.js');
    writeFileSync(outsidePath, 'const value = 1;\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: workspaceDir });

    await runProjectedTool('read_file', { path: outsidePath }, workspaceDir, toolContext);
    const result = await runProjectedTool(
      'edit_file',
      { path: outsidePath, old_string: 'const value = 1;', new_string: 'const value = 2;' },
      workspaceDir,
      toolContext,
      { requestPermission: async () => ({ granted: false, reason: 'test_denied' }) },
    );

    assert.equal(result.success, false);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.tool, 'edit_file');
    assert.equal(parsed.status, 'blocked');
    assert.match(parsed.reason, /User denied/);
    assert.equal(readFileSync(outsidePath, 'utf8'), 'const value = 1;\n');
  });

  it('edits outside the active workspace only after permission approval', async () => {
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    const outsidePath = path.join(outsideDir, 'app.js');
    writeFileSync(outsidePath, 'const value = 1;\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: workspaceDir });
    let requested = null;

    await runProjectedTool('read_file', { path: outsidePath }, workspaceDir, toolContext);
    const result = await runProjectedTool(
      'edit_file',
      { path: outsidePath, old_string: 'const value = 1;', new_string: 'const value = 2;' },
      workspaceDir,
      toolContext,
      {
        requestPermission: async (request) => {
          requested = request;
          return { granted: true, reason: 'test_approved' };
        },
      },
    );

    assert.equal(result.success, true);
    assert.equal(readFileSync(outsidePath, 'utf8'), 'const value = 2;\n');
    assert.equal(requested.tool, 'edit_file');
    assert.equal(requested.filePath, outsidePath);
    assert.equal(requested.workspacePath, workspaceDir);
    assert.equal(JSON.parse(result.output).kind, 'file_edit_result');
  });

  it('drops empty assistant placeholders before sending API messages', async () => {
    const { sanitizeApiMessages } = await loadService();

    const messages = sanitizeApiMessages([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'continue' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
      { role: 'assistant', content: '', segments: [] },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'assistant', content: 'real answer' },
    ]);

    assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'user', 'assistant', 'assistant']);
    assert.equal(messages.some((m) => m.role === 'assistant' && m.content === ''), false);
    assert.equal(Array.isArray(messages[2].content), true);
    assert.equal(messages[3].tool_calls[0].id, 't1');
  });

  it('normalizes OpenAI and Anthropic multimodal user messages', async () => {
    const { normalizeAnthropicMessages, normalizeOpenAIMessages } = await loadService();
    const imageData = Buffer.from('image-bytes').toString('base64');
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageData}` } },
        ],
      },
    ];

    const openai = normalizeOpenAIMessages(messages);
    assert.equal(openai[0].content[1].type, 'image_url');
    assert.equal(openai[0].content[1].image_url.url, `data:image/png;base64,${imageData}`);

    const anthropic = normalizeAnthropicMessages(messages);
    assert.deepEqual(anthropic[0].content[0], { type: 'text', text: 'describe this' });
    assert.equal(anthropic[0].content[1].type, 'image');
    assert.equal(anthropic[0].content[1].source.type, 'base64');
    assert.equal(anthropic[0].content[1].source.media_type, 'image/png');
    assert.equal(anthropic[0].content[1].source.data, imageData);
  });

  it('emits an error instead of completing an empty OpenAI response', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const events = [];
    globalThis.fetch = async () => new Response('data: [DONE]\n\n', { status: 200 });

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'openai',
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            isDefault: true,
            apiKeyConfigured: true,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), false);
    const errorEvent = events.find((event) => event.channel === 'chat:stream:error');
    assert.ok(errorEvent);
    assert.match(errorEvent.payload.error, /empty_model_response/);
  });

  it('retries an empty OpenAI xhigh reasoning response without native reasoning for the same turn', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const events = [];
    const capturedBodies = [];
    globalThis.fetch = async (_url, init) => {
      capturedBodies.push(JSON.parse(init.body));
      if (capturedBodies.length === 1) {
        return new Response('data: [DONE]\n\n', { status: 200 });
      }
      return new Response(sse([
        { choices: [{ delta: { content: 'ok' } }] },
        '[DONE]',
      ]), { status: 200 });
    };

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'openai',
            baseUrl: 'https://example.test/v1',
            model: 'gpt-5.5',
            isDefault: true,
            apiKeyConfigured: true,
            supportsReasoning: true,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        effort: 'xhigh',
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(capturedBodies.length, 2);
    assert.equal(capturedBodies[0].reasoning_effort, 'xhigh');
    assert.equal(capturedBodies[1].reasoning_effort, undefined);
    assert.equal(events.find((event) => event.channel === 'chat:stream:delta')?.payload.content, 'ok');
    assert.equal(events.some((event) => event.channel === 'chat:stream:error'), false);
    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), true);
  });

  it('completes an OpenAI-compatible reasoning-only response without empty response error', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const events = [];
    globalThis.fetch = async () => new Response(sse([
      { choices: [{ delta: { reasoning_content: '先分析问题' } }] },
      '[DONE]',
    ]), { status: 200 });

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'openai',
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            isDefault: true,
            apiKeyConfigured: true,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(events.find((event) => event.channel === 'chat:stream:thinking')?.payload.content, '先分析问题');
    assert.equal(events.some((event) => event.channel === 'chat:stream:error'), false);
    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), true);
  });

  it('does not send Anthropic native thinking for high effort unless the provider declares reasoning support', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const events = [];
    let capturedBody = null;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(sse([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ]), { status: 200 });
    };

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'anthropic',
            baseUrl: 'https://example.test',
            model: 'claude-test',
            isDefault: true,
            apiKeyConfigured: true,
            supportsReasoning: false,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        effort: 'high',
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(capturedBody.thinking, undefined);
    assert.equal(capturedBody.max_tokens, 16384);
    assert.equal(events.find((event) => event.channel === 'chat:stream:delta')?.payload.content, 'ok');
    assert.equal(events.some((event) => event.channel === 'chat:stream:error'), false);
    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), true);
  });

  it('falls back to plain mode for the turn but does NOT persist supportsReasoning=false on an empty response', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const events = [];
    const capturedBodies = [];
    const updateProviderCalls = [];
    const providerState = {
      id: 'p1',
      provider: 'anthropic',
      baseUrl: 'https://example.test',
      model: 'claude-test',
      isDefault: true,
      apiKeyConfigured: true,
      supportsReasoning: true,
    };
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      capturedBodies.push(body);
      if (capturedBodies.length === 1) {
        return new Response(sse([
          {
            type: 'message_start',
            message: { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        ]), { status: 200 });
      }
      return new Response(sse([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ]), { status: 200 });
    };

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [providerState],
          getDecryptedApiKey: () => 'test-key',
          updateProvider: (id, patch) => {
            updateProviderCalls.push({ id, patch });
            Object.assign(providerState, patch);
          },
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        effort: 'high',
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(capturedBodies.length, 2);
    assert.equal(capturedBodies[0].thinking.type, 'enabled');
    // 第二轮在 loop 内当轮降级:本轮请求不带 thinking。
    assert.equal(capturedBodies[1].thinking, undefined);
    // 关键回归:偶发空响应不得把 supportsReasoning 持久化为 false。
    assert.equal(
      updateProviderCalls.some((call) => call.patch && 'supportsReasoning' in call.patch),
      false,
      'empty_response fallback must not persist supportsReasoning=false',
    );
    assert.equal(providerState.supportsReasoning, true);
    assert.equal(events.find((event) => event.channel === 'chat:stream:delta')?.payload.content, 'ok');
    assert.equal(events.some((event) => event.channel === 'chat:stream:error'), false);
    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), true);
  });

  it('records completed stream usage in the main conversation ledger before done reaches the renderer', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const events = [];
    const usageWrites = [];
    globalThis.fetch = async () => new Response(sse([
      { choices: [{ delta: { content: 'ok' } }] },
      {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 5 },
        },
      },
      '[DONE]',
    ]), { status: 200 });

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'openai',
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            isDefault: true,
            apiKeyConfigured: true,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
        conversationStore: {
          addUsage: (id, usage) => {
            usageWrites.push({ id, usage });
            return {
              inputTokens: 112,
              outputTokens: 13,
              cacheWriteTokens: 7,
              cacheReadTokens: 55,
            };
          },
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.deepEqual(usageWrites, [{
      id: 'c1',
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        cacheWriteTokens: 0,
        cacheReadTokens: 5,
      },
    }]);
    const done = events.find((event) => event.channel === 'chat:stream:done');
    assert.ok(done);
    assert.deepEqual(done.payload.lifetimeUsage, {
      inputTokens: 112,
      outputTokens: 13,
      cacheWriteTokens: 7,
      cacheReadTokens: 55,
    });
  });

  it('records provider usage from empty-response errors in the main conversation ledger', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const events = [];
    const usageWrites = [];
    globalThis.fetch = async () => new Response(sse([
      {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 10 },
        },
      },
      '[DONE]',
    ]), { status: 200 });

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'openai',
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            isDefault: true,
            apiKeyConfigured: true,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
        conversationStore: {
          addUsage: (id, usage) => {
            usageWrites.push({ id, usage });
            return {
              inputTokens: 230,
              outputTokens: 9,
              cacheWriteTokens: 0,
              cacheReadTokens: 40,
            };
          },
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.deepEqual(usageWrites, [{
      id: 'c1',
      usage: {
        inputTokens: 30,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 10,
      },
    }]);
    const error = events.find((event) => event.channel === 'chat:stream:error');
    assert.ok(error);
    assert.match(error.payload.error, /empty_model_response/);
    assert.deepEqual(error.payload.lifetimeUsage, {
      inputTokens: 230,
      outputTokens: 9,
      cacheWriteTokens: 0,
      cacheReadTokens: 40,
    });
  });

  it('parses an OpenAI stream frame that ends without a trailing newline', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const events = [];
    const frame = JSON.stringify({ choices: [{ delta: { content: 'hello' } }] });
    globalThis.fetch = async () => new Response(`data: ${frame}`, { status: 200 });

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'openai',
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            isDefault: true,
            apiKeyConfigured: true,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(events.find((event) => event.channel === 'chat:stream:delta')?.payload.content, 'hello');
    assert.equal(events.some((event) => event.channel === 'chat:stream:error'), false);
    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), true);
  });

  it('omits max_output_tokens for ChatGPT subscription Responses requests', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const events = [];
    let capturedUrl = null;
    let capturedBody = null;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return new Response(sse([
        { type: 'response.output_text.delta', delta: 'ok' },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]), { status: 200 });
    };

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p-chatgpt',
            provider: 'openai',
            authMethod: 'oauth_chatgpt',
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            model: 'gpt-5.5',
            isDefault: true,
            apiKeyConfigured: true,
            maxOutputTokens: 4096,
          }],
          getCredential: () => ({
            tokens: {
              access: 'oauth-access',
              refresh: 'oauth-refresh',
              expires: Date.now() + 3_600_000,
              accountId: 'acct-1',
            },
          }),
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(capturedUrl, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(capturedBody.max_output_tokens, undefined);
    assert.equal(events.find((event) => event.channel === 'chat:stream:delta')?.payload.content, 'ok');
    assert.equal(events.some((event) => event.channel === 'chat:stream:error'), false);
    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), true);
  });

  it('does not recover a transport-blocked provider by switching to a different model', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const events = [];
    const urls = [];
    const providers = [
      {
        id: 'p-openai',
        provider: 'openai',
        authMethod: 'oauth_chatgpt',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        model: 'gpt-5.5',
        name: 'ChatGPT 订阅',
        isDefault: true,
        apiKeyConfigured: true,
      },
      {
        id: 'p-anthropic',
        provider: 'anthropic',
        baseUrl: 'https://example.test',
        model: 'claude-test',
        name: 'Anthropic',
        isDefault: false,
        apiKeyConfigured: true,
      },
    ];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response(
        '抱歉，您要访问的网站不在安全策略默认允许的范围内。Domain Blocking.',
        { status: 403, statusText: 'Forbidden' },
      );
    };

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => providers,
          getDecryptedApiKey: (id) => `key-${id}`,
          getCredential: () => ({
            tokens: {
              access: 'oauth-access',
              refresh: 'oauth-refresh',
              expires: Date.now() + 3_600_000,
              accountId: 'acct-1',
            },
          }),
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.deepEqual(urls, [
      'https://chatgpt.com/backend-api/codex/responses',
    ]);
    assert.equal(events.some((event) => event.channel === 'chat:stream:provider-recovery'), false);
    const error = events.find((event) => event.channel === 'chat:stream:error');
    assert.ok(error);
    assert.match(error.payload.error, /HTTP 403/);
    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), false);
  });

  it('recovers a transport-blocked primary provider only on a same-model fallback provider', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const events = [];
    const urls = [];
    const providers = [
      {
        id: 'p-chatgpt',
        provider: 'openai',
        authMethod: 'oauth_chatgpt',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        model: 'gpt-5.5',
        name: 'ChatGPT 订阅',
        isDefault: true,
        apiKeyConfigured: true,
      },
      {
        id: 'p-compatible',
        provider: 'openai',
        baseUrl: 'https://compatible.example/v1',
        model: 'gpt-5.5',
        name: 'Compatible GPT-5.5',
        isDefault: false,
        apiKeyConfigured: true,
      },
      {
        id: 'p-anthropic',
        provider: 'anthropic',
        baseUrl: 'https://example.test',
        model: 'claude-test',
        name: 'Anthropic',
        isDefault: false,
        apiKeyConfigured: true,
      },
    ];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return new Response(
          '抱歉，您要访问的网站不在安全策略默认允许的范围内。Domain Blocking.',
          { status: 403, statusText: 'Forbidden' },
        );
      }
      return new Response(sse([
        { choices: [{ delta: { content: 'same model ok' } }] },
        '[DONE]',
      ]), { status: 200 });
    };

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => providers,
          getDecryptedApiKey: (id) => `key-${id}`,
          getCredential: () => ({
            tokens: {
              access: 'oauth-access',
              refresh: 'oauth-refresh',
              expires: Date.now() + 3_600_000,
              accountId: 'acct-1',
            },
          }),
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.deepEqual(urls, [
      'https://chatgpt.com/backend-api/codex/responses',
      'https://compatible.example/v1/chat/completions',
    ]);
    const recovery = events.find((event) => event.channel === 'chat:stream:provider-recovery');
    assert.ok(recovery);
    assert.equal(recovery.payload.fromProviderId, 'p-chatgpt');
    assert.equal(recovery.payload.toProviderId, 'p-compatible');
    assert.match(recovery.payload.reason, /HTTP 403/);
    assert.equal(events.find((event) => event.channel === 'chat:stream:delta')?.payload.content, 'same model ok');
    assert.equal(events.some((event) => event.channel === 'chat:stream:error'), false);
    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), true);
  });

  it('does not replay a provider failure after model output has reached the stream', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const events = [];
    let fetchCalls = 0;
    const providers = [
      {
        id: 'p-openai',
        provider: 'openai',
        baseUrl: 'https://example.test/v1',
        model: 'gpt-test',
        isDefault: true,
        apiKeyConfigured: true,
      },
      {
        id: 'p-anthropic',
        provider: 'anthropic',
        baseUrl: 'https://fallback.test',
        model: 'claude-test',
        apiKeyConfigured: true,
      },
    ];
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(sse([
        { choices: [{ delta: { content: 'partial' } }] },
        { error: { message: 'upstream reset after output' } },
      ]), { status: 200 });
    };

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => providers,
          getDecryptedApiKey: (id) => `key-${id}`,
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: {
          send: (channel, payload) => events.push({ channel, payload }),
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(fetchCalls, 1);
    assert.equal(events.find((event) => event.channel === 'chat:stream:delta')?.payload.content, 'partial');
    assert.equal(events.some((event) => event.channel === 'chat:stream:provider-recovery'), false);
    const error = events.find((event) => event.channel === 'chat:stream:error');
    assert.ok(error);
    assert.match(error.payload.error, /provider_stream_error/);
  });

  it('reuses scope permission grants in the main runtime without renderer auto-approval state', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    const firstPath = path.join(outsideDir, 'first.txt');
    const secondPath = path.join(outsideDir, 'second.txt');
    const requests = [];
    const events = [];

    function toolStream(id, args) {
      const frame = JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id,
              type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify(args) },
            }],
          },
        }],
      });
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, { status: 200 });
    }

    function textStream(content) {
      const frame = JSON.stringify({ choices: [{ delta: { content } }] });
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, { status: 200 });
    }

    const responses = [
      () => toolStream('tool-1', { path: firstPath, content: 'one\n' }),
      () => toolStream('tool-2', { path: secondPath, content: 'two\n' }),
      () => textStream('done'),
    ];
    globalThis.fetch = async () => responses.shift()();

    let service;
    try {
      service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'openai',
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            isDefault: true,
            apiKeyConfigured: true,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
      });
      service.setWorkspacePath(workspaceDir);

      await service.sendMessage({
        messages: [{ role: 'user', content: 'write twice' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: {
          send: (channel, payload) => {
            events.push({ channel, payload });
            if (channel === 'chat:stream:permission-request') {
              requests.push(payload.call);
              service.resolvePermissionGrant(payload.call.toolCallId, {
                grantId: 'grant-1',
                toolCallId: payload.call.toolCallId,
                granted: true,
                duration: 'scope',
                scope: payload.call.capabilityId,
                decidedAt: new Date().toISOString(),
              });
            }
          },
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(requests.length, 1);
    assert.equal(requests[0].capabilityId, 'local.file.write');
    assert.equal(readFileSync(firstPath, 'utf8'), 'one\n');
    assert.equal(readFileSync(secondPath, 'utf8'), 'two\n');
    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), true);
  });

  it('requests permission for model bash commands through local.shell.exec', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const command = 'node -e "process.stdout.write(\'ok\')"';
    const requests = [];
    const events = [];

    function toolStream() {
      const frame = JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'tool-shell',
              type: 'function',
              function: { name: 'bash', arguments: JSON.stringify({ command }) },
            }],
          },
        }],
      });
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, { status: 200 });
    }

    function textStream(content) {
      const frame = JSON.stringify({ choices: [{ delta: { content } }] });
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, { status: 200 });
    }

    const responses = [
      () => toolStream(),
      () => textStream('done'),
    ];
    globalThis.fetch = async () => responses.shift()();

    let service;
    try {
      service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'openai',
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            isDefault: true,
            apiKeyConfigured: true,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
      });
      service.setWorkspacePath(tmpDir);

      await service.sendMessage({
        messages: [{ role: 'user', content: 'run command' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: {
          send: (channel, payload) => {
            events.push({ channel, payload });
            if (channel === 'chat:stream:permission-request') {
              requests.push(payload.call);
              service.resolvePermissionGrant(payload.call.toolCallId, {
                grantId: 'grant-shell',
                toolCallId: payload.call.toolCallId,
                granted: true,
                duration: 'once',
                scope: payload.call.capabilityId,
                decidedAt: new Date().toISOString(),
              });
            }
          },
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.equal(requests.length, 1);
    assert.equal(requests[0].capabilityId, 'local.shell.exec');
    assert.equal(requests[0].arguments.command, command);
    assert.equal(events.some((event) => (
      event.channel === 'chat:stream:tool-result' &&
      String(event.payload.result).includes('"stdoutPreview": "ok"')
    )), true);
    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), true);
  });

  it('emits agent_loop_exhausted instead of done when an explicit loop budget is reached', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const previousMaxTurns = process.env.PEER_AGENT_AGENT_LOOP_MAX_TURNS;
    const command = 'node -e "process.stdout.write(\'ok\')"';
    const requests = [];
    const events = [];
    let fetchCalls = 0;

    const frame = JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'tool-shell',
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command }) },
          }],
        },
      }],
    });

    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, { status: 200 });
    };
    process.env.PEER_AGENT_AGENT_LOOP_MAX_TURNS = '1';

    let service;
    try {
      service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'openai',
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            isDefault: true,
            apiKeyConfigured: true,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
      });
      service.setWorkspacePath(tmpDir);

      await service.sendMessage({
        messages: [{ role: 'user', content: 'run command' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: {
          send: (channel, payload) => {
            events.push({ channel, payload });
            if (channel === 'chat:stream:permission-request') {
              requests.push(payload.call);
              service.resolvePermissionGrant(payload.call.toolCallId, {
                grantId: 'grant-shell',
                toolCallId: payload.call.toolCallId,
                granted: true,
                duration: 'once',
                scope: payload.call.capabilityId,
                decidedAt: new Date().toISOString(),
              });
            }
          },
        },
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousMaxTurns === undefined) {
        delete process.env.PEER_AGENT_AGENT_LOOP_MAX_TURNS;
      } else {
        process.env.PEER_AGENT_AGENT_LOOP_MAX_TURNS = previousMaxTurns;
      }
    }

    assert.equal(fetchCalls, 1);
    assert.equal(requests.length, 1);
    assert.equal(events.some((event) => event.channel === 'chat:stream:tool-result'), true);
    assert.equal(events.some((event) => event.channel === 'chat:stream:done'), false);
    const error = events.find((event) => event.channel === 'chat:stream:error');
    assert.ok(error);
    assert.match(error.payload.error, /agent_loop_exhausted/);
    assert.match(error.payload.error, /task is not complete/);
  });

  it('adds evidence-discipline rules to the system prompt', async () => {
    const { buildSystemPrompt } = await loadService();

    const prompt = buildSystemPrompt('/tmp/workspace');

    assert.match(prompt, /Evidence discipline/);
    assert.match(prompt, /Never claim/);
    assert.match(prompt, /actual tool call/);
    assert.match(prompt, /Tool selection/);
    assert.match(prompt, /read_file/);
    assert.match(prompt, /bash/);
    assert.match(prompt, /\/tmp\/workspace/);
  });

  it('builds provider tool schemas from detailed tool prompts', async () => {
    const { buildOpenAITools, buildAnthropicTools } = await loadService();

    const openAiTools = buildOpenAITools();
    const anthropicTools = buildAnthropicTools();
    const bashTool = openAiTools.find((tool) => tool.function.name === 'bash');
    const readTool = anthropicTools.find((tool) => tool.name === 'read_file');
    const editTool = openAiTools.find((tool) => tool.function.name === 'edit_file');
    const writeTool = openAiTools.find((tool) => tool.function.name === 'write_file');

    assert.equal(openAiTools.length, anthropicTools.length);
    assert.ok(bashTool);
    assert.ok(readTool);
    assert.ok(editTool);
    assert.ok(writeTool);
    assert.match(bashTool.function.description, /Use read_file instead of bash cat\/head\/tail/);
    assert.match(readTool.description, /exact file path/);
    assert.match(editTool.function.description, /old_string/);
    assert.match(writeTool.function.description, /allow_overwrite=true/);
    assert.equal(bashTool.function.parameters.additionalProperties, false);
  });

  it('detects local tool claims that are unsupported by tool calls', async () => {
    const { hasUnsupportedToolClaim } = await loadService();

    assert.equal(hasUnsupportedToolClaim('真实返回，table 块完整内容已确认。'), true);
    assert.equal(hasUnsupportedToolClaim('[Tool call: bash {"command":"cat package.json"}]'), true);
    assert.equal(hasUnsupportedToolClaim('我现在发起了这次 bash 调用，等真实返回。'), true);
    assert.equal(hasUnsupportedToolClaim('我刚才运行了 pnpm typecheck，结果通过。'), true);
    assert.equal(hasUnsupportedToolClaim('I ran git status and confirmed the tree is clean.'), true);
    assert.equal(hasUnsupportedToolClaim('我接下来会检查文件，然后再给结论。'), false);
    assert.equal(hasUnsupportedToolClaim('This looks like a rendering issue based on your screenshot.'), false);
  });

  it('detects dangling tool-use preambles without tool calls', async () => {
    const { hasDanglingToolIntent } = await loadService();

    assert.equal(hasDanglingToolIntent('先一次性查全相关文件和关键代码：'), true);
    assert.equal(hasDanglingToolIntent('我先用真实工具摸清现有输入区结构和消息发送链路，再动手——这次每步贴真实返回。'), true);
    assert.equal(hasDanglingToolIntent('Let me inspect the composer and message send flow:'), true);
    assert.equal(hasDanglingToolIntent('我接下来会检查文件，然后再给结论。'), false);
    assert.equal(hasDanglingToolIntent('可以添加图片附件，方案是按钮、预览和模型消息三部分。'), false);
  });

  it('treats pseudo tool-call text as unsupported text rather than executable tool calls', async () => {
    const service = await loadService();

    assert.equal('extractPseudoToolCalls' in service, false);
    assert.equal(service.hasUnsupportedToolClaim('[Tool call: read_file {"path":"/tmp/a.txt"}]'), true);
  });

  it('broadcasts active conversation ids while streaming and clears them after done', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    // 记录每次 active-changed 广播时的会话集合快照,验证运行中含 c1、结束后清空。
    const activeSnapshots = [];
    globalThis.fetch = async () => new Response(sse([
      { choices: [{ delta: { content: 'hi' } }] },
      '[DONE]',
    ]), { status: 200 });

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'openai',
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            isDefault: true,
            apiKeyConfigured: true,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
        broadcast: (channel, payload) => {
          if (channel === 'chat:stream:active-changed') {
            activeSnapshots.push([...payload.conversationIds]);
          }
        },
      });

      // 发起前无活跃流。
      assert.deepEqual(service.listActiveConversationIds(), []);

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: { send: () => {} },
      });

      // 至少广播两次:创建(含 c1) + 终态删除(清空)。
      assert.equal(activeSnapshots.length >= 2, true);
      assert.deepEqual(activeSnapshots[0], ['c1']);
      assert.deepEqual(activeSnapshots[activeSnapshots.length - 1], []);
      // 结束后枚举为空。
      assert.deepEqual(service.listActiveConversationIds(), []);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('ADR 27: active stream projection carries the workspace it was started in', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    // 捕获每次 active-changed 广播时的 streams 快照(含工作区维度)。
    const streamSnapshots = [];
    globalThis.fetch = async () => new Response(sse([
      { choices: [{ delta: { content: 'hi' } }] },
      '[DONE]',
    ]), { status: 200 });

    try {
      const service = createLlmChatService({
        llmConfigStore: {
          listProviders: () => [{
            id: 'p1',
            provider: 'openai',
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            isDefault: true,
            apiKeyConfigured: true,
          }],
          getDecryptedApiKey: () => 'test-key',
        },
        broadcast: (channel, payload) => {
          if (channel === 'chat:stream:active-changed') {
            streamSnapshots.push(payload.streams.map((s) => ({ ...s })));
          }
        },
      });

      // 发起前投影为空。
      assert.deepEqual(service.listActiveStreams(), []);

      // 流在发起时快照工作区:先设置当前工作区再发起。
      service.setWorkspacePath('/ws/alpha');
      await service.sendMessage({
        messages: [{ role: 'user', content: 'hello' }],
        streamId: 's1',
        conversationId: 'c1',
        webContents: { send: () => {} },
      });

      // 创建时的首个广播应携带 c1 + 其发起工作区 /ws/alpha。
      const firstWithStream = streamSnapshots.find((snap) => snap.length > 0);
      assert.ok(firstWithStream, 'expected at least one broadcast with an active stream');
      assert.deepEqual(firstWithStream[0], {
        conversationId: 'c1',
        workspacePath: '/ws/alpha',
      });
      // 终态后投影清空。
      assert.deepEqual(service.listActiveStreams(), []);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

// 方案 3：助手正文持久化真值下沉主进程 + 流终结后保留 streamRecord 供回放。
describe('llm chat service main-side persistence (方案 3)', () => {
  function openaiProviderStore() {
    return {
      listProviders: () => [{
        id: 'p1',
        provider: 'openai',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
        isDefault: true,
        apiKeyConfigured: true,
      }],
      getDecryptedApiKey: () => 'test-key',
    };
  }

  it('persists assistant content+segments by id on done, even with no visible session (background turn)', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const patches = [];
    globalThis.fetch = async () => new Response(sse([
      { choices: [{ delta: { content: 'hello ' } }] },
      { choices: [{ delta: { content: 'world' } }] },
      { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      '[DONE]',
    ]), { status: 200 });

    try {
      const service = createLlmChatService({
        llmConfigStore: openaiProviderStore(),
        conversationStore: {
          addUsage: () => null,
          // 主进程权威落盘：捕获每次按 id 的 patch（节流期间可能多次，终态强制 flush）。
          updateMessageById: (id, messageId, patch) => {
            patches.push({ id, messageId, patch: JSON.parse(JSON.stringify(patch)) });
            return { id };
          },
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hi' }],
        streamId: 's-bg',
        conversationId: 'c-bg',
        assistantMessageId: 'a-bg',
        // 后台轮次：webContents 仍会收到事件，但没有可见会话消费（这正是「切走即丢」的场景）。
        webContents: { send: () => {} },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.ok(patches.length > 0, 'expected at least one persistence patch');
    // 都打到正确的会话与消息 id。
    assert.ok(patches.every((p) => p.id === 'c-bg' && p.messageId === 'a-bg'));
    const finalPatch = patches[patches.length - 1].patch;
    assert.equal(finalPatch.content, 'hello world');
    const textSeg = (finalPatch.segments || []).find((s) => s.type === 'text');
    assert.ok(textSeg && textSeg.content === 'hello world');
    // done（正常完成）不应标记 interrupted。
    assert.notEqual(finalPatch.interrupted, true);
  });

  it('marks interrupted=true on terminal error persistence', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    const patches = [];
    // 空响应 → empty_model_response 错误终态（不触发慢速网络重试）。
    globalThis.fetch = async () => new Response('data: [DONE]\n\n', { status: 200 });

    try {
      const service = createLlmChatService({
        llmConfigStore: openaiProviderStore(),
        conversationStore: {
          addUsage: () => null,
          updateMessageById: (id, messageId, patch) => {
            patches.push({ id, messageId, patch: JSON.parse(JSON.stringify(patch)) });
            return { id };
          },
        },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hi' }],
        streamId: 's-err',
        conversationId: 'c-err',
        assistantMessageId: 'a-err',
        webContents: { send: () => {} },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.ok(patches.length > 0, 'expected a terminal persistence patch');
    const finalPatch = patches[patches.length - 1].patch;
    assert.equal(finalPatch.interrupted, true);
  });

  it('reattach returns a terminal snapshot after done (retained for replay)', async () => {
    const { createLlmChatService } = await loadService();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(sse([
      { choices: [{ delta: { content: 'final answer' } }] },
      { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      '[DONE]',
    ]), { status: 200 });

    try {
      const service = createLlmChatService({
        llmConfigStore: openaiProviderStore(),
        conversationStore: { addUsage: () => null, updateMessageById: () => ({}) },
      });

      await service.sendMessage({
        messages: [{ role: 'user', content: 'hi' }],
        streamId: 's-keep',
        conversationId: 'c-keep',
        assistantMessageId: 'a-keep',
        webContents: { send: () => {} },
      });

      // 终态后不再算「运行中」，但记录被保留供回放。
      assert.deepEqual(service.listActiveStreams(), []);
      const snap = service.reattach({ conversationId: 'c-keep' });
      assert.ok(snap, 'expected a retained terminal snapshot');
      assert.equal(snap.isStreaming, false);
      assert.equal(snap.terminalStatus, 'done');
      assert.equal(snap.interrupted, false);
      assert.equal(snap.accumulatedText, 'final answer');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
