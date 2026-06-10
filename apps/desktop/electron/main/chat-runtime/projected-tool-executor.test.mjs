import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  executeProjectedModelTool,
  resolveProjectedModelToolCall,
} from './projected-tool-executor.mjs';

let tmpDir;

describe('projected model tool executor', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'projected-model-tool-'));
    process.env.PEER_AGENT_HOME = tmpDir;
  });

  afterEach(() => {
    delete process.env.PEER_AGENT_HOME;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves model-visible read_file through Runtime Projection to local.file.read', () => {
    const projection = resolveProjectedModelToolCall({
      name: 'read_file',
      args: { path: 'note.txt' },
      toolCallId: 'tc_read',
    });

    assert.equal(projection.ok, true);
    assert.equal(projection.capability.capabilityId, 'local.file.read');
    assert.equal(projection.call.toolCallId, 'tc_read');
    assert.equal(projection.call.capabilityId, 'local.file.read');
    assert.deepEqual(projection.call.arguments, { path: 'note.txt' });
  });

  it('executes projected read_file through Local Tool Host and returns model-compatible output', async () => {
    const filePath = path.join(tmpDir, 'note.txt');
    writeFileSync(filePath, 'hello projection\n', 'utf8');

    const result = await executeProjectedModelTool({
      name: 'read_file',
      args: { path: filePath },
      workspacePath: tmpDir,
      toolContext: { readFiles: new Map(), conversationId: 'c1' },
      toolCallId: 'tc_read',
    });

    assert.equal(result.success, true);
    assert.equal(result.execution.call.capabilityId, 'local.file.read');
    assert.equal(result.execution.grant.granted, true);
    assert.equal(result.projectionCapability.capabilityId, 'local.file.read');
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.kind, 'local_file_ref');
    assert.equal(parsed.tool, 'read_file');
    assert.equal(parsed.path, filePath);
    assert.match(parsed.preview, /hello projection/);
  });
});
