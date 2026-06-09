import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const { executeTool } = await loadService();
    const filePath = path.join(tmpDir, 'large.txt');
    writeFileSync(filePath, 'line\n'.repeat(3000), 'utf8');

    const result = await executeTool('read_file', { path: filePath }, tmpDir);

    assert.equal(result.success, true);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.kind, 'local_file_ref');
    assert.equal(parsed.path, filePath);
    assert.equal(parsed.contextPreviewTruncated, true);
    assert.equal(parsed.preview.length < 5000, true);
    assert.equal(parsed.suggestedRetrieval.some((cmd) => cmd.includes(filePath)), true);
  });

  it('drops empty assistant placeholders before sending API messages', async () => {
    const { sanitizeApiMessages } = await loadService();

    const messages = sanitizeApiMessages([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: '', segments: [] },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'assistant', content: 'real answer' },
    ]);

    assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'assistant']);
    assert.equal(messages.some((m) => m.role === 'assistant' && m.content === ''), false);
    assert.equal(messages[2].tool_calls[0].id, 't1');
  });
});
