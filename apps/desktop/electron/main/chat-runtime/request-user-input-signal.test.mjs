import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createRuntimeToolProjection } from '../tools/index.mjs';
import { extractToolControlSignal } from './tool-orchestrator.mjs';
import { executeProjectedModelTool } from './projected-tool-executor.mjs';

let tmpDir;

describe('request_user_input terminal control signal (runtime chain)', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'request-user-input-'));
    process.env.PEER_AGENT_HOME = tmpDir;
  });

  afterEach(() => {
    delete process.env.PEER_AGENT_HOME;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('projects request_user_input as an inert native capability', () => {
    const { projection } = createRuntimeToolProjection();
    const capability = projection.capabilities.find((c) => c.name === 'request_user_input');
    assert.ok(capability, 'request_user_input should be present in the runtime projection');
    assert.equal(capability.capabilityId, 'local.interaction.request_user_input');
    assert.equal(capability.source, 'native');
    assert.equal(capability.riskLevel, 'L0_inert');
    assert.equal(capability.dataLevel, 'D0_public');
  });

  it('executes through the local tool host and surfaces a terminal control signal', async () => {
    const { registry, projection } = createRuntimeToolProjection();
    const result = await executeProjectedModelTool({
      name: 'request_user_input',
      args: { question: '按 1/2/3 哪种方式提交？', options: ['1', '2', '3'] },
      workspacePath: tmpDir,
      toolContext: { readFiles: new Map(), conversationId: 'c1' },
      toolCallId: 'tc_ask',
      registry,
      runtimeProjection: projection,
    });

    assert.equal(result.success, true);
    assert.equal(result.execution.call.capabilityId, 'local.interaction.request_user_input');
    assert.equal(result.execution.grant.granted, true);

    // 经由 orchestrator 的提取器拿到终止信号——这正是两个 agent loop 用来停止回合的依据。
    const signal = extractToolControlSignal(result);
    assert.deepEqual(signal, { terminal: true, reason: 'request_user_input' });
  });

  it('does not surface a terminal signal for ordinary tools', async () => {
    const { registry, projection } = createRuntimeToolProjection();
    // health 检查是无副作用的只读能力，绝不能携带终止信号。
    const result = await executeProjectedModelTool({
      name: 'request_user_input',
      args: { options: ['1'] }, // 缺少 question → 失败，不终止
      workspacePath: tmpDir,
      toolContext: { readFiles: new Map(), conversationId: 'c1' },
      toolCallId: 'tc_bad',
      registry,
      runtimeProjection: projection,
    });

    assert.equal(extractToolControlSignal(result), null);
  });
});

describe('goal_create_plan terminal control signal (runtime chain)', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'goal-create-handoff-'));
    process.env.PEER_AGENT_HOME = tmpDir;
  });

  afterEach(() => {
    delete process.env.PEER_AGENT_HOME;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('surfaces goal_handoff so the intake agent loop ends before Runner starts', async () => {
    const { registry, projection } = createRuntimeToolProjection();
    const result = await executeProjectedModelTool({
      name: 'goal_create_plan',
      args: {
        title: '修卡住',
        goal: '修复 goal create 后 Runner 不启动',
        tasks: [{ title: '定位 auto-start' }],
      },
      workspacePath: tmpDir,
      toolContext: {
        readFiles: new Map(),
        conversationId: 'c-goal-handoff',
        mode: 'goal',
      },
      toolCallId: 'tc_goal_create',
      registry,
      runtimeProjection: projection,
    });

    assert.equal(result.success, true);
    const signal = extractToolControlSignal(result);
    assert.deepEqual(signal, { terminal: true, reason: 'goal_handoff' });
  });
});
