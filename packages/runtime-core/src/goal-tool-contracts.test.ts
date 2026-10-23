import assert from 'node:assert/strict';
import test from 'node:test';

import { SHARED_LOCAL_TOOL_CONTRACTS } from './local-tool-contracts.ts';
import {
  GOAL_CREATE_PLAN_INPUT_SCHEMA,
  GOAL_CREATE_PLAN_PROMPT,
  GOAL_GET_PLAN_INPUT_SCHEMA,
  GOAL_GET_PLAN_PROMPT,
  GOAL_REQUEST_EXPLORER_INPUT_SCHEMA,
  GOAL_REQUEST_EXPLORER_PROMPT,
  GOAL_UPDATE_TASK_INPUT_SCHEMA,
  GOAL_UPDATE_TASK_PROMPT,
} from './goal-tool-contracts.ts';

const CONTRACTS = [
  {
    label: 'goal_create_plan',
    contract: SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan,
    prompt: GOAL_CREATE_PLAN_PROMPT,
    schema: GOAL_CREATE_PLAN_INPUT_SCHEMA,
  },
  {
    label: 'goal_update_task',
    contract: SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask,
    prompt: GOAL_UPDATE_TASK_PROMPT,
    schema: GOAL_UPDATE_TASK_INPUT_SCHEMA,
  },
  {
    label: 'goal_get_plan',
    contract: SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan,
    prompt: GOAL_GET_PLAN_PROMPT,
    schema: GOAL_GET_PLAN_INPUT_SCHEMA,
  },
  {
    label: 'request_explorer',
    contract: SHARED_LOCAL_TOOL_CONTRACTS.requestExplorer,
    prompt: GOAL_REQUEST_EXPLORER_PROMPT,
    schema: GOAL_REQUEST_EXPLORER_INPUT_SCHEMA,
  },
];

test('every goal tool shares a non-trivial prompt and a closed object schema', () => {
  for (const { label, prompt, schema } of CONTRACTS) {
    assert.equal(typeof prompt, 'string', `${label}: prompt must be a string`);
    assert.ok(prompt.length > 40, `${label}: prompt must describe real usage, got ${prompt.length} chars`);
    assert.equal(schema.type, 'object', `${label}: schema must be an object`);
    assert.equal(
      schema.additionalProperties,
      false,
      `${label}: schema must be closed so unknown fields cannot silently pass`,
    );
    assert.ok(schema.properties && typeof schema.properties === 'object', `${label}: schema needs properties`);
    for (const [name, property] of Object.entries(schema.properties)) {
      assert.ok(
        typeof property === 'object' && property !== null,
        `${label}.${name}: property must be an object schema`,
      );
    }
  }
});

test('goal_create_plan requires a title and exposes the relation fields', () => {
  const schema = GOAL_CREATE_PLAN_INPUT_SCHEMA;

  // 回归点：title 曾是可选项且无描述，模型因此漏传，store 落成「未命名任务」。
  assert.ok(
    schema.required.includes('title'),
    'title must be required — otherwise the plan panel shows the untitled placeholder',
  );
  assert.equal(typeof schema.properties.title.description, 'string');
  assert.ok(schema.properties.title.description.length > 0, 'title needs a description telling the model not to omit it');

  // 关系字段必须与执行层能力对齐：schema 承诺了，TUI/Desktop 就必须真的透传。
  assert.ok(schema.required.includes('goal'));
  assert.ok(schema.required.includes('tasks'));
  assert.ok('parentPlanId' in schema.properties, 'parentPlanId must be declared');
  assert.ok('sourceTaskId' in schema.properties, 'sourceTaskId must be declared');
  assert.equal(schema.properties.tasks.items.required.includes('title'), true);
});

test('goal tool schemas stay wired to the shared capability IDs', () => {
  // 共享的是“模型可见的契约”，toolName/capabilityId 仍由 local-tool-contracts 单一持有。
  assert.equal(SHARED_LOCAL_TOOL_CONTRACTS.goalCreatePlan.toolName, 'goal_create_plan');
  assert.equal(SHARED_LOCAL_TOOL_CONTRACTS.goalUpdateTask.toolName, 'goal_update_task');
  assert.equal(SHARED_LOCAL_TOOL_CONTRACTS.goalGetPlan.toolName, 'goal_get_plan');
  assert.equal(SHARED_LOCAL_TOOL_CONTRACTS.requestExplorer.toolName, 'request_explorer');
  for (const { contract, label } of CONTRACTS) {
    assert.ok(contract.capabilityId.startsWith('local.'), `${label}: capabilityId must be a local capability`);
  }
});

test('goal_update_task keeps the task status enum and evidence slots', () => {
  const schema = GOAL_UPDATE_TASK_INPUT_SCHEMA;
  assert.deepEqual([...schema.required], ['planId', 'taskId']);
  assert.ok(schema.properties.status.enum.includes('completed'));
  assert.ok(schema.properties.status.enum.includes('failed'));
  assert.ok(schema.properties.status.enum.includes('waiting_user'));
  assert.ok('evidenceRefs' in schema.properties);
  assert.ok('criterionResults' in schema.properties);
});

test('request_explorer stays read-only shaped (question required, reason optional)', () => {
  const schema = GOAL_REQUEST_EXPLORER_INPUT_SCHEMA;
  assert.deepEqual([...schema.required], ['question']);
  // reason 在两端都是可选（旧 TUI 曾要求必填，与 Desktop 不一致，现已统一）。
  assert.ok('reason' in schema.properties);
  // Explorer 不能带执行类字段，否则破坏了只读契约。
  for (const forbidden of ['command', 'capabilityId', 'writePath', 'toolCallId']) {
    assert.ok(!(forbidden in schema.properties), `request_explorer must not accept ${forbidden}`);
  }
});
