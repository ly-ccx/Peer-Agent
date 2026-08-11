import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractSkillIdFromCapabilityId,
  extractSkillIdFromModelName,
  isSkillCapabilityId,
  isSkillModelName,
  parseSkillToolView,
  SKILL_CAPABILITY_PREFIX,
  SKILL_MODEL_NAME_PREFIX,
} from './skillToolView.ts';

describe('skillToolView', () => {
  it('recognizes local.skill.* capability ids and skill__* model names', () => {
    assert.equal(isSkillCapabilityId('local.skill.release-process'), true);
    assert.equal(isSkillCapabilityId('local.skill.'), true);
    assert.equal(isSkillCapabilityId('read_file'), false);
    assert.equal(isSkillCapabilityId('local.shell.exec'), false);
    assert.equal(isSkillCapabilityId(null), false);
    assert.equal(isSkillModelName('skill__weather-plus'), true);
    assert.equal(isSkillModelName('skill__'), true);
    assert.equal(isSkillModelName('bash'), false);
    assert.equal(SKILL_CAPABILITY_PREFIX, 'local.skill.');
    assert.equal(SKILL_MODEL_NAME_PREFIX, 'skill__');
  });

  it('extracts skillId from capability id and model name', () => {
    assert.equal(extractSkillIdFromCapabilityId('local.skill.release-process'), 'release-process');
    assert.equal(extractSkillIdFromCapabilityId('local.skill.foo/bar'), 'foo/bar');
    assert.equal(extractSkillIdFromModelName('skill__weather-plus'), 'weather-plus');
    assert.equal(extractSkillIdFromModelName('skill__release_process'), 'release_process');
  });

  it('parses skill view from tool field and prefers human displayName', () => {
    const view = parseSkillToolView({
      tool: 'local.skill.release-process',
      displayName: 'Release Process',
    });
    assert.deepEqual(view, {
      skillId: 'release-process',
      skillName: 'Release Process',
      capabilityId: 'local.skill.release-process',
      modelName: 'skill__release-process',
    });
  });

  it('parses model-visible skill__* names from chat tool stream', () => {
    const view = parseSkillToolView({
      tool: 'skill__weather-plus',
    });
    assert.deepEqual(view, {
      skillId: 'weather-plus',
      skillName: 'weather-plus',
      capabilityId: 'local.skill.weather-plus',
      modelName: 'skill__weather-plus',
    });
  });

  it('falls back to skillId when displayName is missing or is a raw skill id', () => {
    assert.equal(
      parseSkillToolView({ tool: 'local.skill.release-process' })?.skillName,
      'release-process',
    );
    assert.equal(
      parseSkillToolView({
        tool: 'local.skill.release-process',
        displayName: 'local.skill.release-process',
      })?.skillName,
      'release-process',
    );
    assert.equal(
      parseSkillToolView({
        tool: 'skill__weather-plus',
        displayName: 'skill__weather-plus',
      })?.skillName,
      'weather-plus',
    );
  });

  it('does not treat ordinary tools as skills', () => {
    assert.equal(parseSkillToolView({ tool: 'read_file', displayName: '读取文件' }), null);
    assert.equal(parseSkillToolView({ tool: 'bash', displayName: 'local.shell.exec' }), null);
    assert.equal(parseSkillToolView({ tool: 'goal_update_task' }), null);
  });
});
