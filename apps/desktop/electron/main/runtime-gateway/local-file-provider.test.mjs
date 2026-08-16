import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createLocalFileProvider, MAX_WRITE_FILE_BYTES } from './local-file-provider.mjs';

let tmpDir;

function createCall(capabilityId, args = {}) {
  return {
    toolCallId: `${capabilityId}:test`,
    capabilityId,
    arguments: args,
    argumentsPreview: args,
    occurredAt: new Date().toISOString(),
  };
}

describe('local file provider', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'local-file-provider-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads files as artifact-style local file refs and records read state', async () => {
    const filePath = path.join(tmpDir, 'note.txt');
    const toolContext = { conversationId: 'c1', readFiles: new Map() };
    writeFileSync(filePath, 'hello\n', 'utf8');

    const provider = createLocalFileProvider({ workspaceRoot: tmpDir });
    const execution = await provider.executeCapability({ call: createCall('local.file.read', { path: filePath }) }, {
      workspaceRoot: tmpDir,
      toolContext,
      locale: 'zh-CN',
    });

    assert.equal(execution.grant.granted, true);
    assert.equal(execution.grant.scope, 'local.file.read');
    assert.equal(execution.result.status, 'success');
    const output = JSON.parse(execution.result.outputPreview.fileResult.output);
    assert.equal(output.kind, 'local_file_ref');
    assert.equal(output.path, filePath);
    assert.equal(toolContext.readFiles.get(filePath)?.fullRead, true);
  });

  it('write_file and edit_file emit structured user artifacts while read_file does not', async () => {
    const filePath = path.join(tmpDir, 'artifact.txt');
    const provider = createLocalFileProvider({ workspaceRoot: tmpDir });
    const toolContext = { conversationId: 'c1', readFiles: new Map() };

    const writeExecution = await provider.executeCapability(
      { call: createCall('local.file.write', { path: filePath, content: 'before\n' }) },
      { workspaceRoot: tmpDir, toolContext, locale: 'zh-CN' },
    );
    assert.deepEqual(writeExecution.result.evidence.userArtifacts, [{
      kind: 'file',
      ref: `file://${filePath}`,
      path: filePath,
      label: '新建文件',
    }]);

    const readExecution = await provider.executeCapability(
      { call: createCall('local.file.read', { path: filePath }) },
      { workspaceRoot: tmpDir, toolContext, locale: 'zh-CN' },
    );
    assert.equal(readExecution.result.evidence.userArtifacts, undefined);

    const editExecution = await provider.executeCapability(
      { call: createCall('local.file.edit', { path: filePath, old_string: 'before', new_string: 'after' }) },
      { workspaceRoot: tmpDir, toolContext, locale: 'zh-CN' },
    );
    assert.deepEqual(editExecution.result.evidence.userArtifacts, [{
      kind: 'code-change',
      ref: `file://${filePath}`,
      path: filePath,
      label: '代码变更',
      preview: {
        kind: 'code',
        additions: 1,
        deletions: 1,
        diffLines: [
          `--- a/${filePath}`,
          `+++ b/${filePath}`,
          '@@ -1,2 +1,2 @@',
          '-before',
          '+after',
          ' ',
        ],
      },
    }]);
    assert.ok(editExecution.result.evidence.userArtifacts[0].preview.diffLines.length <= 41);
    assert.ok(editExecution.result.evidence.userArtifacts[0].preview.diffLines.every((line) => line.length <= 240));
  });

  it('lists directory entries through the governed file provider', async () => {
    const directoryPath = path.join(tmpDir, 'docs');
    mkdirSync(directoryPath);
    mkdirSync(path.join(directoryPath, 'nested'));
    writeFileSync(path.join(directoryPath, 'note.txt'), 'hello\n', 'utf8');

    const provider = createLocalFileProvider({ workspaceRoot: tmpDir });
    const execution = await provider.executeCapability(
      { call: createCall('local.file.list', { path: 'docs' }) },
      {
        workspaceRoot: tmpDir,
        toolContext: { conversationId: 'c1', readFiles: new Map() },
        locale: 'zh-CN',
      },
    );

    assert.equal(execution.grant.granted, true);
    assert.equal(execution.result.status, 'success');
    const output = JSON.parse(execution.result.outputPreview.fileResult.output);
    assert.equal(output.tool, 'list_files');
    assert.equal(output.path, 'docs');
    assert.deepEqual(output.entries, [
      { name: 'nested', path: 'docs/nested', type: 'directory' },
      { name: 'note.txt', path: 'docs/note.txt', type: 'file' },
    ]);
  });

  it('requires a fresh read before editing existing files', async () => {
    const filePath = path.join(tmpDir, 'app.js');
    writeFileSync(filePath, 'const value = 1;\n', 'utf8');
    const toolContext = { conversationId: 'c1', readFiles: new Map() };
    const provider = createLocalFileProvider({ workspaceRoot: tmpDir });

    const blocked = await provider.executeCapability({
      call: createCall('local.file.edit', {
        path: filePath,
        old_string: '1',
        new_string: '2',
      }),
    }, {
      workspaceRoot: tmpDir,
      toolContext,
      locale: 'zh-CN',
    });

    assert.equal(blocked.result.status, 'denied');
    assert.equal(blocked.grant.granted, false);
    assert.match(JSON.parse(blocked.result.outputPreview.fileResult.output).reason, /must be read/);

    await provider.executeCapability({ call: createCall('local.file.read', { path: filePath }) }, {
      workspaceRoot: tmpDir,
      toolContext,
      locale: 'zh-CN',
    });
    const edited = await provider.executeCapability({
      call: createCall('local.file.edit', {
        path: filePath,
        old_string: 'const value = 1;',
        new_string: 'const value = 2;',
      }),
    }, {
      workspaceRoot: tmpDir,
      toolContext,
      locale: 'zh-CN',
    });

    assert.equal(edited.result.status, 'success');
    assert.equal(readFileSync(filePath, 'utf8'), 'const value = 2;\n');
    assert.equal(JSON.parse(edited.result.outputPreview.fileResult.output).kind, 'file_edit_result');
  });

  it('requests permission before writing outside the active workspace', async () => {
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    const outsidePath = path.join(outsideDir, 'new.txt');
    const provider = createLocalFileProvider({ workspaceRoot: workspaceDir });
    let requested = null;

    const denied = await provider.executeCapability({
      call: createCall('local.file.write', { path: outsidePath, content: 'outside\n' }),
    }, {
      workspaceRoot: workspaceDir,
      toolContext: { conversationId: 'c1', readFiles: new Map() },
      locale: 'zh-CN',
    });

    assert.equal(denied.result.status, 'denied');
    assert.equal(existsSync(outsidePath), false);

    const allowed = await provider.executeCapability({
      call: createCall('local.file.write', { path: outsidePath, content: 'outside\n' }),
    }, {
      workspaceRoot: workspaceDir,
      toolContext: { conversationId: 'c1', readFiles: new Map() },
      requestPermission: async (request) => {
        requested = request;
        return { granted: true, reason: 'test_approved' };
      },
      locale: 'zh-CN',
    });

    assert.equal(allowed.result.status, 'success');
    assert.equal(readFileSync(outsidePath, 'utf8'), 'outside\n');
    assert.equal(requested.tool, 'write_file');
    assert.equal(requested.filePath, outsidePath);
    assert.equal(requested.workspacePath, workspaceDir);
  });

  it('search_files finds matching lines without requesting permission', async () => {
    writeFileSync(path.join(tmpDir, 'a.txt'), 'alpha\nNEEDLE here\n', 'utf8');
    writeFileSync(path.join(tmpDir, 'b.txt'), 'no match\n', 'utf8');
    const nested = path.join(tmpDir, 'sub');
    mkdirSync(nested);
    writeFileSync(path.join(nested, 'c.txt'), 'another needle line\n', 'utf8');

    const provider = createLocalFileProvider({ workspaceRoot: tmpDir });
    let requested = null;
    const execution = await provider.executeCapability(
      { call: createCall('local.file.search', { query: 'needle' }) },
      {
        workspaceRoot: tmpDir,
        toolContext: { conversationId: 'c1', readFiles: new Map() },
        requestPermission: async (request) => {
          requested = request;
          return { granted: true };
        },
        locale: 'zh-CN',
      },
    );

    assert.equal(execution.grant.granted, true);
    assert.equal(execution.result.status, 'success');
    assert.equal(requested, null, 'read-only search must not request permission');
    const output = JSON.parse(execution.result.outputPreview.fileResult.output);
    assert.equal(output.tool, 'search_files');
    assert.equal(output.matchCount, 2);
    assert.equal(output.fileCount, 2);
  });

  it('search_files yields the event loop while scanning files', async () => {
    const previous = process.env.PEER_AGENT_DISABLE_RIPGREP;
    process.env.PEER_AGENT_DISABLE_RIPGREP = '1';
    try {
      for (let i = 0; i < 40; i += 1) {
        writeFileSync(path.join(tmpDir, `bulk-${i}.txt`), `${'x'.repeat(4000)}\n`, 'utf8');
      }
      writeFileSync(path.join(tmpDir, 'hit.txt'), 'NEEDLE\n', 'utf8');

      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 1);
      const provider = createLocalFileProvider({ workspaceRoot: tmpDir });
      const execution = await provider.executeCapability(
        { call: createCall('local.file.search', { query: 'NEEDLE' }) },
        {
          workspaceRoot: tmpDir,
          toolContext: { conversationId: 'c1', readFiles: new Map() },
          locale: 'zh-CN',
        },
      );
      clearInterval(timer);

      assert.equal(execution.result.status, 'success');
      assert.ok(ticks > 0, `event loop should tick during search, got ${ticks}`);
      const output = JSON.parse(execution.result.outputPreview.fileResult.output);
      assert.equal(output.matchCount, 1);
    } finally {
      if (previous === undefined) delete process.env.PEER_AGENT_DISABLE_RIPGREP;
      else process.env.PEER_AGENT_DISABLE_RIPGREP = previous;
    }
  });

  it('search_files blocks paths outside the workspace', async () => {
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    writeFileSync(path.join(outsideDir, 'secret.txt'), 'needle\n', 'utf8');

    const provider = createLocalFileProvider({ workspaceRoot: workspaceDir });
    const execution = await provider.executeCapability(
      { call: createCall('local.file.search', { query: 'needle', path: outsideDir }) },
      {
        workspaceRoot: workspaceDir,
        toolContext: { conversationId: 'c1', readFiles: new Map() },
        locale: 'zh-CN',
      },
    );

    assert.equal(execution.result.status, 'denied');
  });

  it('write_file blocks content larger than 32KB and allows 32KB boundary', async () => {
    const provider = createLocalFileProvider({ workspaceRoot: tmpDir });
    const toolContext = {
      conversationId: 'c1',
      readFiles: new Map(),
    };
    const overLimitPath = path.join(tmpDir, 'over-limit.md');
    const boundaryPath = path.join(tmpDir, 'boundary.md');

    const overLimit = await provider.executeCapability(
      {
        call: createCall('local.file.write', {
          path: overLimitPath,
          content: 'a'.repeat(MAX_WRITE_FILE_BYTES + 1),
        }),
      },
      {
        workspaceRoot: tmpDir,
        toolContext,
        locale: 'zh-CN',
      },
    );
    assert.equal(overLimit.result.status, 'denied');
    assert.match(JSON.parse(overLimit.result.outputPreview.fileResult.output).reason, /32|chunked|exceeds/i);
    assert.equal(existsSync(overLimitPath), false);

    const boundary = await provider.executeCapability(
      {
        call: createCall('local.file.write', {
          path: boundaryPath,
          content: 'b'.repeat(MAX_WRITE_FILE_BYTES),
        }),
      },
      {
        workspaceRoot: tmpDir,
        toolContext,
        locale: 'zh-CN',
      },
    );
    assert.equal(boundary.result.status, 'success');
    assert.equal(readFileSync(boundaryPath, 'utf8').length, MAX_WRITE_FILE_BYTES);
  });

  it('search_files allows outside-workspace paths when permission is granted', async () => {
    const workspaceDir = path.join(tmpDir, 'workspace');
    const outsideDir = path.join(tmpDir, 'outside');
    mkdirSync(workspaceDir);
    mkdirSync(outsideDir);
    writeFileSync(path.join(outsideDir, 'secret.txt'), 'NEEDLE here\n', 'utf8');

    const provider = createLocalFileProvider({ workspaceRoot: workspaceDir });
    let requested = null;
    const execution = await provider.executeCapability(
      { call: createCall('local.file.search', { query: 'needle', path: outsideDir }) },
      {
        workspaceRoot: workspaceDir,
        toolContext: { conversationId: 'c1', readFiles: new Map() },
        requestPermission: async (request) => {
          requested = request;
          return { granted: true, reason: 'test_approved' };
        },
        locale: 'zh-CN',
      },
    );

    assert.equal(execution.grant.granted, true);
    assert.equal(execution.result.status, 'success');
    assert.equal(requested.tool, 'search_files');
    assert.equal(requested.filePath, outsideDir);
    assert.equal(requested.workspacePath, workspaceDir);
    const output = JSON.parse(execution.result.outputPreview.fileResult.output);
    assert.equal(output.tool, 'search_files');
    assert.equal(output.matchCount, 1);
  });
});
