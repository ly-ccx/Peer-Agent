import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

let tmpDir;

async function loadService() {
  return import(`./llm-chat-service.mjs?test=${Date.now()}-${Math.random()}`);
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
    const { executeTool } = await loadService();

    const result = await executeTool(
      'bash',
      { command: 'node -e "process.stdout.write(\'x\'.repeat(12000))"' },
      tmpDir,
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
    const { createToolContext, executeTool } = await loadService();
    const filePath = path.join(tmpDir, 'large.txt');
    writeFileSync(filePath, 'line\n'.repeat(3000), 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: tmpDir });

    const result = await executeTool('read_file', { path: filePath }, tmpDir, toolContext);

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
    const { createToolContext, executeTool } = await loadService();
    const filePath = path.join(tmpDir, 'app.js');
    writeFileSync(filePath, 'const value = 1;\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: tmpDir });

    const result = await executeTool(
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
    const { createToolContext, executeTool } = await loadService();
    const filePath = path.join(tmpDir, 'app.js');
    writeFileSync(filePath, 'const value = 1;\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: tmpDir });

    await executeTool('read_file', { path: filePath }, tmpDir, toolContext);
    const result = await executeTool(
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
    const { createToolContext, executeTool } = await loadService();
    const filePath = path.join(tmpDir, 'copy.txt');
    writeFileSync(filePath, 'same\nsame\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: tmpDir });

    await executeTool('read_file', { path: filePath }, tmpDir, toolContext);
    const blocked = await executeTool(
      'edit_file',
      { path: filePath, old_string: 'same', new_string: 'done' },
      tmpDir,
      toolContext,
    );

    assert.equal(blocked.success, false);
    assert.match(JSON.parse(blocked.output).reason, /matched 2 times/);
    assert.equal(readFileSync(filePath, 'utf8'), 'same\nsame\n');

    const replaced = await executeTool(
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
    const { createToolContext, executeTool } = await loadService();
    const filePath = path.join(tmpDir, 'stale.txt');
    writeFileSync(filePath, 'before\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: tmpDir });

    await executeTool('read_file', { path: filePath }, tmpDir, toolContext);
    writeFileSync(filePath, 'external change\n', 'utf8');
    const result = await executeTool(
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
    const { createToolContext, executeTool } = await loadService();
    const filePath = path.join(tmpDir, 'replace.txt');
    writeFileSync(filePath, 'old\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: tmpDir });

    const blocked = await executeTool('write_file', { path: filePath, content: 'new\n' }, tmpDir, toolContext);
    assert.equal(blocked.success, false);
    assert.match(JSON.parse(blocked.output).reason, /allow_overwrite=true/);
    assert.equal(readFileSync(filePath, 'utf8'), 'old\n');

    await executeTool('read_file', { path: filePath }, tmpDir, toolContext);
    const replaced = await executeTool(
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
    const { createToolContext, executeTool } = await loadService();
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    const outsidePath = path.join(outsideDir, 'new.txt');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: workspaceDir });

    const result = await executeTool(
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
    const { createToolContext, executeTool } = await loadService();
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    const outsidePath = path.join(outsideDir, 'new.txt');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: workspaceDir });
    let requested = null;

    const result = await executeTool(
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
    const { createToolContext, executeTool } = await loadService();
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    const outsidePath = path.join(outsideDir, 'app.js');
    writeFileSync(outsidePath, 'const value = 1;\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: workspaceDir });

    await executeTool('read_file', { path: outsidePath }, workspaceDir, toolContext);
    const result = await executeTool(
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
    const { createToolContext, executeTool } = await loadService();
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    const outsidePath = path.join(outsideDir, 'app.js');
    writeFileSync(outsidePath, 'const value = 1;\n', 'utf8');
    const toolContext = createToolContext({ conversationId: 'c1', workspacePath: workspaceDir });
    let requested = null;

    await executeTool('read_file', { path: outsidePath }, workspaceDir, toolContext);
    const result = await executeTool(
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
});
