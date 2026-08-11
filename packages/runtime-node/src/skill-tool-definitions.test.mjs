import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSkillToolDefinition,
  createSkillToolDefinitionsFromStore,
  SKILL_PREFIX,
} from './skill-tool-definitions.mjs';

test('createSkillToolDefinition projects enabled skill to skill__* + local.skill.*', () => {
  const tool = createSkillToolDefinition({
    skillId: 'weather-plus',
    name: 'weather-plus',
    description: '查询中国城市天气信息并提供穿衣建议。',
    whenToUse: '用户询问天气、温度、穿衣建议时使用。',
    enabled: true,
  });

  assert.ok(tool);
  assert.equal(tool.name, 'skill__weather-plus');
  assert.equal(tool.capabilityId, `${SKILL_PREFIX}weather-plus`);
  assert.equal(tool.runtime.executorCapabilityId, `${SKILL_PREFIX}weather-plus`);
  assert.equal(tool.source, 'skill');
  assert.deepEqual(tool.availableInModes, ['chat', 'plan', 'goal']);
  assert.match(tool.prompt(), /天气/);
  assert.equal(typeof tool.inputSchema, 'object');
});

test('createSkillToolDefinition skips disabled or invalid skills', () => {
  assert.equal(createSkillToolDefinition(null), null);
  assert.equal(createSkillToolDefinition({ skillId: 'x', enabled: false }), null);
  assert.equal(createSkillToolDefinition({ name: 'no-id', enabled: true }), null);
});

test('createSkillToolDefinitionsFromStore only projects enabled skills', () => {
  const tools = createSkillToolDefinitionsFromStore({
    listSkills: () => ([
      {
        skillId: 'weather-plus',
        name: 'weather-plus',
        description: 'weather skill',
        enabled: true,
      },
      {
        skillId: 'disabled-skill',
        name: 'disabled-skill',
        description: 'should not project',
        enabled: false,
      },
    ]),
  });

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'skill__weather-plus');
  assert.equal(tools[0].capabilityId, 'local.skill.weather-plus');
});

test('createSkillToolDefinitionsFromStore tolerates missing store', () => {
  assert.deepEqual(createSkillToolDefinitionsFromStore(null), []);
  assert.deepEqual(createSkillToolDefinitionsFromStore({}), []);
});
