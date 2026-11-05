import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  encodeProviderToolResult,
  FILE_READ_INLINE_MAX_CHARS,
} from './tool-result-encoder.ts';
import { materializeToolResultContent, resolveToolArtifactDir } from './tool-artifact-store.ts';

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
  it('preserves the scoped delegation query fields in Desktop and TUI oversized tool results', () => {
    const baseDir = makeBaseDir();
    const execution = { call: { capabilityId: 'local.delegation.coordinate_work' }, result: { status: 'success', output: {
      ok: true, workId: 'work-current', workRevision: 2, goalRevision: 1, currentReplyRef: 'current-reply',
      decisionFrame: { report: 'long evidence '.repeat(1000) }, sourceInputIds: [], sourceEventIds: ['verified-event'],
      intent: { interpretation: { requirements: [{ requirementId: 'frozen-evaluation' }, { requirementId: 'independent-check' }] } },
    } } };
    const content = JSON.stringify(execution.result.output, null, 2);
    const desktop = materializeToolResultContent({ baseDir, toolCallId: 'desktop', tool: 'coordinate_work', content, execution });
    const tui = encodeProviderToolResult({ baseDir, toolCallId: 'tui', result: execution.result, execution });
    for (const encoded of [desktop, tui]) {
      assert.equal(encoded.materialized, true);
      const preview = JSON.parse(encoded.content);
      assert.equal(preview.tool, 'coordinate_work');
      assert.deepEqual(preview.structuredPreview, { workId: 'work-current', workRevision: 2, goalRevision: 1,
        currentReplyRef: 'current-reply', sourceInputIds: [], sourceEventIds: ['verified-event'],
        requirementIds: ['frozen-evaluation', 'independent-check'],
        omitted: { sourceInputIds: 0, sourceEventIds: 0, requirementIds: 0 } });
      assert.equal(preview.suggestedRetrieval, undefined);
      assert.match(preview.note, /coordinate_work and get_session/);
    }
    assert.equal(readFileSync(desktop.artifactPath!, 'utf8'), content);
    assert.deepEqual(JSON.parse(readFileSync(tui.artifactPath!, 'utf8')).output, execution.result.output);

    const unrelated = materializeToolResultContent({ baseDir, toolCallId: 'mcp', tool: 'coordinate_work', content,
      execution: { ...execution, call: { capabilityId: 'mcp.coordinate_work' } } });
    assert.equal(JSON.parse(unrelated.content).structuredPreview, undefined);
  });

  it('keeps exact report references and session revisions within the structured preview budget', () => {
    const baseDir = makeBaseDir();
    const state = { sessionId: 'task', status: 'result_ready', sourceRevision: 'a'.repeat(64), observationRevision: 'b'.repeat(64) };
    const reportEvidenceRefs = Array.from({ length: 30 }, (_, index) => `interactive-inspection://${index}-${'x'.repeat(180)}`);
    const report = { evidenceRefs: reportEvidenceRefs, summary: 's'.repeat(9000) };
    const encode = (capabilityId: string, output: object) => {
      const result = { status: 'success', output };
      return JSON.parse(encodeProviderToolResult({ baseDir, result, execution: { call: { capabilityId }, result } }).content);
    };
    const task = encode('local.delegation.get_session', { ok: true, ...state, report });
    const { reportEvidenceRefs: kept, omittedReportEvidenceRefs, ...seenState } = task.structuredPreview;
    assert.deepEqual(seenState, state);
    assert.ok(kept.length > 0 && omittedReportEvidenceRefs > 0);
    assert.deepEqual(kept, reportEvidenceRefs.slice(0, reportEvidenceRefs.length - omittedReportEvidenceRefs));
    assert.deepEqual(JSON.parse(readFileSync(task.artifactRef, 'utf8')).output.report, report);
    const roster = encode('local.delegation.list_sessions', { ok: true, sessions: [{ ...state, report },
      { sessionId: 'prior', status: 'accepted', report }] });
    assert.deepEqual(roster.structuredPreview, { sessions: [state, { sessionId: 'prior', status: 'accepted' }], omittedSessions: 0 });
  });

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
