import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  createLegacyLlmLocalToolProvider,
  executeLegacyLlmLocalTool,
} from './legacy-llm-local-tool-provider.mjs';
import { createShellArtifactStore } from './shell-artifacts.mjs';

let tmpDir;
let artifactStore;

describe('legacy LLM local tool provider', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'legacy-llm-tool-provider-'));
    artifactStore = createShellArtifactStore({ userDataPath: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('executes read_file as a capability provider result with grant and evidence', async () => {
    const filePath = path.join(tmpDir, 'note.txt');
    writeFileSync(filePath, 'hello\n', 'utf8');
    const provider = createLegacyLlmLocalToolProvider({ artifactStore });
    const call = {
      toolCallId: 'tc_read',
      capabilityId: 'legacy.local.file.read',
      arguments: { path: filePath },
    };

    const execution = await provider.executeCapability({ call }, {
      workspaceRoot: tmpDir,
      toolContext: { readFiles: new Map(), conversationId: 'c1' },
      locale: 'zh-CN',
    });

    assert.equal(execution.call, call);
    assert.equal(execution.grant.granted, true);
    assert.equal(execution.grant.scope, 'legacy.local.file.read');
    assert.equal(execution.result.status, 'success');
    assert.equal(execution.result.evidence.toolCallId, 'tc_read');
    const legacyOutput = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(legacyOutput.kind, 'local_file_ref');
    assert.equal(legacyOutput.path, filePath);
  });

  it('keeps executeLegacyLlmLocalTool as the compatibility adapter', async () => {
    const filePath = path.join(tmpDir, 'note.txt');
    writeFileSync(filePath, 'hello\n', 'utf8');

    const legacyResult = await executeLegacyLlmLocalTool({
      name: 'read_file',
      args: { path: filePath },
      workspacePath: tmpDir,
      toolContext: { readFiles: new Map(), conversationId: 'c1' },
      artifactStore,
    });

    assert.equal(legacyResult.success, true);
    assert.equal(JSON.parse(legacyResult.output).kind, 'local_file_ref');
  });

  it('delegates legacy file tool execution to local.file capabilities', async () => {
    const calls = [];
    const provider = createLegacyLlmLocalToolProvider({
      artifactStore,
      fileProvider: {
        async executeCapability(request, context) {
          calls.push({ request, context });
          return {
            call: request.call,
            grant: {
              grantId: 'g1',
              toolCallId: request.call.toolCallId,
              granted: true,
              duration: 'once',
              scope: request.call.capabilityId,
              decidedAt: new Date().toISOString(),
            },
            result: {
              toolCallId: request.call.toolCallId,
              status: 'success',
              outputPreview: {
                legacyResult: {
                  success: true,
                  output: JSON.stringify({ kind: 'local_file_ref', tool: 'read_file' }),
                },
              },
              evidence: {
                evidenceId: 'e1',
                toolCallId: request.call.toolCallId,
                summary: 'ok',
                locale: 'zh-CN',
                returnedToCloud: false,
                dataLevel: 'D1_internal',
                redactions: [],
                artifactRefs: [],
              },
              completedAt: new Date().toISOString(),
            },
          };
        },
      },
    });

    const call = {
      toolCallId: 'tc_read',
      capabilityId: 'legacy.local.file.read',
      arguments: { path: 'note.txt' },
    };
    const execution = await provider.executeCapability({ call }, {
      workspaceRoot: tmpDir,
      toolContext: { readFiles: new Map(), conversationId: 'c1' },
      locale: 'zh-CN',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.call.capabilityId, 'local.file.read');
    assert.deepEqual(calls[0].request.call.arguments, { path: 'note.txt' });
    assert.equal(calls[0].context.workspaceRoot, tmpDir);
    assert.equal(execution.result.status, 'success');
    assert.equal(JSON.parse(execution.result.outputPreview.legacyResult.output).kind, 'local_file_ref');
  });

  it('delegates legacy bash execution to local.shell.exec capabilities', async () => {
    const calls = [];
    const provider = createLegacyLlmLocalToolProvider({
      artifactStore,
      shellProvider: {
        async executeCapability(request, context) {
          calls.push({ request, context });
          return {
            call: request.call,
            grant: {
              grantId: 'g1',
              toolCallId: request.call.toolCallId,
              granted: true,
              duration: 'once',
              scope: 'local.shell.exec:read-only',
              decidedAt: new Date().toISOString(),
            },
            result: {
              toolCallId: request.call.toolCallId,
              status: 'success',
              outputPreview: {
                localToolResultRef: {
                  kind: 'local_tool_result_ref',
                  command: 'pwd',
                  cwd: tmpDir,
                  status: 'success',
                  exitCode: 0,
                  stdoutPreview: `${tmpDir}\n`,
                  stderrPreview: null,
                  stdoutChars: tmpDir.length + 1,
                  stderrChars: 0,
                  stdoutLines: 2,
                  stderrLines: 0,
                  contextPreviewTruncated: false,
                  suggestedRetrieval: [],
                },
              },
              evidence: {
                evidenceId: 'e1',
                toolCallId: request.call.toolCallId,
                summary: 'ok',
                locale: 'zh-CN',
                returnedToCloud: false,
                dataLevel: 'D1_internal',
                redactions: [],
                artifactRefs: [],
              },
              completedAt: new Date().toISOString(),
            },
          };
        },
      },
    });

    const call = {
      toolCallId: 'tc_bash',
      capabilityId: 'legacy.local.shell.exec',
      arguments: { command: 'pwd' },
    };
    const execution = await provider.executeCapability({ call }, {
      workspaceRoot: tmpDir,
      locale: 'zh-CN',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.call.capabilityId, 'local.shell.exec');
    assert.deepEqual(calls[0].request.call.arguments, { command: 'pwd' });
    assert.equal(calls[0].context.workspaceRoot, tmpDir);
    const output = JSON.parse(execution.result.outputPreview.legacyResult.output);
    assert.equal(output.kind, 'local_tool_result_ref');
    assert.equal(output.tool, 'bash');
    assert.equal(output.command, 'pwd');
  });
});
