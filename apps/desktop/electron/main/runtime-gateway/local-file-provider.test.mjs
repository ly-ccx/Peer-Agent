import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createLocalFileProvider } from './local-file-provider.mjs';

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
