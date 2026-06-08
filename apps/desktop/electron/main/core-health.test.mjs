import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runHealthStub } from './core-health.mjs';

function createWorkspace() {
  return mkdtempSync(path.join(tmpdir(), 'zeus-atlas-core-health-'));
}

test('runHealthStub returns failed evidence when the Rust core binary is missing', async () => {
  const workspaceRoot = createWorkspace();
  const result = await runHealthStub({
    workspaceRoot,
    toolCallId: 'tool_missing_core',
    locale: 'zh-CN',
  });

  assert.equal(result.toolCallId, 'tool_missing_core');
  assert.equal(result.status, 'failed');
  assert.equal(result.outputPreview.status, 'core_binary_missing');
  assert.match(String(result.outputPreview.expectedPath), /target\/debug\/cu-proxy-core$/);
  assert.equal(result.evidence.toolCallId, 'tool_missing_core');
  assert.equal(result.evidence.returnedToCloud, false);
  assert.equal(result.evidence.dataLevel, 'D0_public');
  assert.match(result.evidence.summary, /Rust health stub/);
});

test('runHealthStub executes the Rust core command and wraps success evidence', {
  skip: process.platform === 'win32' ? 'fake executable path is Unix-only' : false,
}, async () => {
  const workspaceRoot = createWorkspace();
  const binaryPath = path.join(workspaceRoot, 'target/debug/cu-proxy-core');
  mkdirSync(path.dirname(binaryPath), { recursive: true });
  writeFileSync(
    binaryPath,
    [
      '#!/usr/bin/env sh',
      'printf \'{"status":"ready","capabilityId":"local.health","summary":"fake core ready"}\\n\'',
    ].join('\n'),
    'utf8',
  );
  chmodSync(binaryPath, 0o755);

  const result = await runHealthStub({
    workspaceRoot,
    toolCallId: 'tool_core_ready',
    locale: 'en-US',
  });

  assert.equal(result.toolCallId, 'tool_core_ready');
  assert.equal(result.status, 'success');
  assert.equal(result.outputPreview.status, 'ready');
  assert.equal(result.outputPreview.capabilityId, 'local.health');
  assert.equal(result.evidence.toolCallId, 'tool_core_ready');
  assert.equal(result.evidence.returnedToCloud, false);
  assert.equal(result.evidence.dataLevel, 'D0_public');
  assert.match(result.evidence.summary, /Local health capability completed/);
});
