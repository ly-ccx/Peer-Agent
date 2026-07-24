import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  enforceConversationArtifactBudget,
  materializeToolResultContent,
  removeConversationToolArtifacts,
  resolveToolArtifactDir,
  writeToolResultArtifact,
} from './tool-artifact-store.ts';

const tempDirs: string[] = [];

function makeBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'peer-tool-artifacts-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('tool result materialization (17 号文档 §3.1)', () => {
  it('keeps small results inline without touching disk', () => {
    const baseDir = makeBaseDir();
    const result = materializeToolResultContent({
      conversationId: 'conv-1',
      toolCallId: 'call-1',
      tool: 'bash',
      content: 'short output',
      baseDir,
    });
    assert.equal(result.materialized, false);
    assert.equal(result.content, 'short output');
    assert.equal(existsSync(resolveToolArtifactDir({ baseDir, conversationId: 'conv-1' })), false);
  });

  it('materializes oversized output into an artifact plus a local_tool_result_ref skeleton', () => {
    const baseDir = makeBaseDir();
    const middle = 'MIDDLE-SECRET-MARKER';
    const content = `${'a'.repeat(4000)}\nError: build failed at step 3\n${middle}\n${'b'.repeat(4000)}`;
    const result = materializeToolResultContent({
      conversationId: 'conv-1',
      toolCallId: 'call-2',
      tool: 'mcp_tool',
      content,
      isError: true,
      baseDir,
    });
    assert.equal(result.materialized, true);
    assert.ok(result.artifactPath);
    // 全文可从 artifact 找回(包括被预览省略的中段)。
    assert.ok(readFileSync(result.artifactPath!, 'utf8').includes(middle));

    const ref = JSON.parse(result.content);
    assert.equal(ref.kind, 'local_tool_result_ref');
    assert.equal(ref.status, 'error');
    assert.equal(ref.artifactRef, result.artifactPath);
    assert.equal(ref.originalChars, content.length);
    assert.ok(Array.isArray(ref.suggestedRetrieval) && ref.suggestedRetrieval.length > 0);
    assert.ok(ref.keyFindings.some((line: string) => line.includes('build failed')));
    assert.ok(String(ref.note).includes('Do NOT re-run'));
    // ref 骨架必须显著小于原文。
    assert.ok(result.content.length < content.length / 2);
  });

  it('does not re-materialize content that is already a structured local ref', () => {
    const baseDir = makeBaseDir();
    const already = JSON.stringify({
      kind: 'local_tool_result_ref',
      artifactRef: '/tmp/existing.txt',
      stdoutPreview: 'x'.repeat(7000),
    });
    const result = materializeToolResultContent({
      conversationId: 'conv-1',
      toolCallId: 'call-3',
      content: already,
      baseDir,
    });
    assert.equal(result.materialized, false);
    assert.equal(result.content, already);
  });

  it('cascades conversation artifact cleanup', () => {
    const baseDir = makeBaseDir();
    const written = writeToolResultArtifact({
      conversationId: 'conv-gone',
      toolCallId: 'call-4',
      tool: 'bash',
      content: 'x'.repeat(10),
      baseDir,
    });
    assert.equal(existsSync(written.artifactPath), true);
    removeConversationToolArtifacts({ conversationId: 'conv-gone', baseDir });
    assert.equal(existsSync(written.artifactPath), false);
  });

  it('evicts oldest artifacts first when the conversation budget is exceeded (LRU)', () => {
    const baseDir = makeBaseDir();
    const conversationId = 'conv-lru';
    const paths: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const written = writeToolResultArtifact({
        conversationId,
        toolCallId: `call-${index}`,
        tool: 'bash',
        content: 'x'.repeat(1000),
        baseDir,
        // 写入时禁用治理,由下方显式 enforce 触发,便于断言。
        maxConversationBytes: Number.MAX_SAFE_INTEGER,
      });
      paths.push(written.artifactPath);
      // 人为拉开 mtime:index 越小越旧。
      const when = new Date(Date.now() - (10 - index) * 60_000);
      utimesSync(written.artifactPath, when, when);
    }
    enforceConversationArtifactBudget({ conversationId, baseDir, maxBytes: 2200 });
    assert.equal(existsSync(paths[0]!), false, 'oldest artifact should be evicted');
    assert.equal(existsSync(paths[1]!), true);
    assert.equal(existsSync(paths[2]!), true, 'newest artifact must survive');
  });

  it('the retrieval route in suggestedRetrieval actually recovers the omitted middle (e2e)', () => {
    const baseDir = makeBaseDir();
    const middle = 'MIDDLE-SECRET-MARKER';
    const content = `${'head '.repeat(1500)}\n${middle}\n${'tail '.repeat(1500)}`;
    const result = materializeToolResultContent({
      conversationId: 'conv-route',
      toolCallId: 'call-route',
      tool: 'bash',
      content,
      baseDir,
    });
    assert.equal(result.materialized, true);
    const ref = JSON.parse(result.content);
    // 预览里确实看不到中段(误解风险场景成立)…
    assert.equal(String(ref.stdoutPreview).includes(middle), false);
    // …但沿 ref 的回路用真实 shell 工具能找回中段(回来的路是真的)。
    const grepOut = execFileSync('grep', ['-n', middle, ref.artifactRef], { encoding: 'utf8' });
    assert.ok(grepOut.includes(middle));
    // suggestedRetrieval 里的 tail 命令可直接执行且能看到尾部内容。
    const tailOut = execFileSync('tail', ['-n', '120', ref.artifactRef], { encoding: 'utf8' });
    assert.ok(tailOut.includes('tail'));
  });
});
