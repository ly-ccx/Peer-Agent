import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractSkillIdFromCapabilityId,
  isSkillCapabilityId,
  parseSkillToolView,
  SKILL_CAPABILITY_PREFIX,
} from './skillToolView.ts';

describe('skillToolView', () => {
  it('recognizes local.skill.* capability ids', () => {
    assert.equal(isSkillCapabilityId('local.skill.release-process'), true);
    assert.equal(isSkillCapabilityId('local.skill.'), true);
    assert.equal(isSkillCapabilityId('read_file'), false);
    assert.equal(isSkillCapabilityId('local.shell.exec'), false);
    assert.equal(isSkillCapabilityId(null), false);
    assert.equal(SKILL_CAPABILITY_PREFIX, 'local.skill.');
  });

  it('extracts skillId from capability id', () => {
    assert.equal(extractSkillIdFromCapabilityId('local.skill.release-process'), 'release-process');
    assert.equal(extractSkillIdFromCapabilityId('local.skill.foo/bar'), 'foo/bar');
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
    });
  });

  it('falls back to skillId when displayName is missing or is the capability id', () => {
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
  });

  it('does not treat ordinary tools as skills', () => {
    assert.equal(parseSkillToolView({ tool: 'read_file', displayName: '读取文件' }), null);
    assert.equal(parseSkillToolView({ tool: 'bash', displayName: 'local.shell.exec' }), null);
  });
});
