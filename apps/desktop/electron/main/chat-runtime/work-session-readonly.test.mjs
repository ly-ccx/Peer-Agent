import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateWorkSessionWrite } from '@peer-agent/runtime-node';
import { executeProjectedModelTool } from './projected-tool-executor.mjs';
import { createRuntimeToolProjection, createRuntimeToolRegistry, createRuntimeProjectionFromToolRegistry } from '../tools/index.mjs';

test('readonly work session denies unknown side effects and allows task facts', () => {
  const plan = { delegationOrigin: { readOnly: true } };
  for (const capabilityId of ['local.file.write', 'local.shell.exec', 'local.web.control.click', 'local.mcp.unknown', 'future.side_effect']) {
    assert.equal(evaluateWorkSessionWrite(plan, { capabilityId }).allowed, false, capabilityId);
  }
  for (const capabilityId of ['local.file.read', 'local.goal.update_task', 'local.goal.explore', 'local.interaction.request_user_input', 'local.skill.instructions']) {
    assert.equal(evaluateWorkSessionWrite(plan, { capabilityId }).allowed, true, capabilityId);
  }
});

test('readonly desktop projection hides writes and the executor rejects a stale writable projection', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-readonly-desktop-'));
  const previous = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = root;
  try {
    const { projection } = createRuntimeToolProjection({ projectionOptions: { mode: 'chat', readOnlyWorkSession: true } });
    assert.equal(projection.capabilities.some(item => item.capabilityId === 'local.file.write'), false);
    assert.equal(projection.capabilities.some(item => item.capabilityId === 'local.file.read'), true);
    assert.equal(projection.capabilities.some(item => item.capabilityId === 'local.goal.update_task'), true);
    const registry = createRuntimeToolRegistry();
    const runtimeProjection = createRuntimeProjectionFromToolRegistry(registry, { mode: 'chat' });
    let approvals = 0;
    const result = await executeProjectedModelTool({ name: 'write_file', args: { path: 'blocked.txt', content: 'wrong' },
      workspacePath: root, toolCallId: 'readonly-write', registry, runtimeProjection,
      toolContext: { planId: 'readonly-plan', conversationId: 'session' },
      goalPlanStore: { getPlan: () => ({ delegationOrigin: { readOnly: true } }) },
      requestPermission: () => { approvals++; return { granted: true }; },
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'read_only');
    assert.equal(result.execution.grant.granted, false);
    assert.equal(result.execution.result.status, 'denied');
    assert.equal(approvals, 0);
    assert.equal(existsSync(path.join(root, 'blocked.txt')), false);
  } finally {
    if (previous === undefined) delete process.env.PEER_AGENT_HOME; else process.env.PEER_AGENT_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
