import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  encodeProviderToolResult,
  FILE_READ_INLINE_MAX_CHARS,
} from './tool-result-encoder.ts';
import { resolveToolArtifactDir } from './tool-artifact-store.ts';

const tempDirs: string[] = [];

function makeBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'peer-tool-result-encoder-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function artifactFiles(baseDir: string, conversationId: string): string[] {
  const dir = resolveToolArtifactDir({ baseDir, conversationId });
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

describe('encodeProviderToolResult', () => {
  it('keeps a working-set file read inline and does not dump a tool-tui-tool artifact', () => {
    const baseDir = makeBaseDir();
    const content = `${'line\n'.repeat(1_200)}UNIQUE_MIDDLE_LINE\n`;
    assert.ok(content.length > 6_000);
    assert.ok(content.length < FILE_READ_INLINE_MAX_CHARS);

    const encoded = encodeProviderToolResult({
      conversationId: 'conv-file',
      toolCallId: 'tui-tool-8',
      baseDir,
      result: {
        status: 'completed',
        output: {
          path: 'src/adaptix/name_mapping.py',
          content,
          bytes: Buffer.byteLength(content),
          contentHash: 'abc',
        },
        outputPreview: {
          path: 'src/adaptix/name_mapping.py',
          content: content.slice(0, 4_000),
        },
      },
    });

    assert.equal(encoded.materialized, false);
    const parsed = JSON.parse(encoded.content) as {
      kind: string;
      path: string;
      preview: string;
      contextPreviewTruncated: boolean;
      suggestedRetrieval: string[];
    };
    assert.equal(parsed.kind, 'local_file_ref');
    assert.equal(parsed.path, 'src/adaptix/name_mapping.py');
    assert.equal(parsed.contextPreviewTruncated, false);
    assert.match(parsed.preview, /UNIQUE_MIDDLE_LINE/);
    assert.ok(parsed.suggestedRetrieval.some((cmd) => cmd.includes('src/adaptix/name_mapping.py')));
    assert.equal(artifactFiles(baseDir, 'conv-file').length, 0);
  });

  it('does not rematerialize a wrapped shell result into a JSON artifact', () => {
    const baseDir = makeBaseDir();
    const stdout = `x`.repeat(12_000);
    const encoded = encodeProviderToolResult({
      conversationId: 'conv-shell',
      toolCallId: 'tui-tool-9',
      baseDir,
      result: {
        status: 'completed',
        output: {
          command: 'cat src/big.py',
          cwd: '/tmp/ws',
          stdout,
          stderr: '',
          exitCode: 0,
          status: 'completed',
          artifactRef: 'local-shell-artifact://shell_abc',
          artifactRefs: ['local-shell-artifact://shell_abc/stdout'],
          stdoutPath: '/tmp/shell-artifacts/stdout.txt',
        },
        outputPreview: {
          command: 'cat src/big.py',
          stdout: stdout.slice(0, 4_000),
          artifactRef: 'local-shell-artifact://shell_abc',
          artifactRefs: ['local-shell-artifact://shell_abc/stdout'],
          stdoutPath: '/tmp/shell-artifacts/stdout.txt',
        },
      },
    });

    assert.equal(encoded.materialized, false);
    const parsed = JSON.parse(encoded.content) as {
      kind: string;
      stdoutPreview: string;
      stdoutChars: number;
      contextPreviewTruncated: boolean;
      suggestedRetrieval: string[];
      note: string;
    };
    assert.equal(parsed.kind, 'local_tool_result_ref');
    assert.equal(parsed.stdoutChars, 12_000);
    assert.equal(parsed.contextPreviewTruncated, true);
    assert.ok(parsed.stdoutPreview.length <= 4_000);
    assert.ok(parsed.suggestedRetrieval.some((cmd) => cmd.includes('/tmp/shell-artifacts/stdout.txt')));
    assert.match(parsed.note, /tool-tui-tool/);
    assert.equal(artifactFiles(baseDir, 'conv-shell').length, 0);
  });

  it('passes through an existing local_*_ref without a second dump', () => {
    const baseDir = makeBaseDir();
    const already = {
      kind: 'local_file_ref' as const,
      path: 'README.md',
      preview: 'x'.repeat(8_000),
      suggestedRetrieval: ['sed -n \'1,160p\' "README.md"'],
    };
    const encoded = encodeProviderToolResult({
      conversationId: 'conv-ref',
      toolCallId: 'tui-tool-1',
      baseDir,
      result: {
        status: 'completed',
        output: already,
        outputPreview: already,
      },
    });
    assert.equal(encoded.materialized, false);
    assert.deepEqual(JSON.parse(encoded.content), already);
    assert.equal(artifactFiles(baseDir, 'conv-ref').length, 0);
  });

  it('still materializes unstructured leftover dumps', () => {
    const baseDir = makeBaseDir();
    const dump = `mcp-body ${'z'.repeat(8_000)}`;
    const encoded = encodeProviderToolResult({
      conversationId: 'conv-mcp',
      toolCallId: 'tui-tool-77',
      tool: 'mcp_tool',
      baseDir,
      result: {
        status: 'completed',
        output: dump,
      },
    });
    assert.equal(encoded.materialized, true);
    const parsed = JSON.parse(encoded.content) as { kind: string; artifactRef: string };
    assert.equal(parsed.kind, 'local_tool_result_ref');
    assert.ok(parsed.artifactRef);
    assert.equal(artifactFiles(baseDir, 'conv-mcp').length, 1);
  });
});
