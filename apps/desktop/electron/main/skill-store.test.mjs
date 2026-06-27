import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSkillStore } from './skill-store.mjs';

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'skill-store-test-'));
}

function writeSkill(userDataPath, skillId, content) {
  const dir = path.join(userDataPath, 'skills', skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  return dir;
}

describe('createSkillStore', () => {
  let userDataPath;

  beforeEach(() => {
    userDataPath = tmpDir();
  });

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it('returns empty list when skills directory does not exist', () => {
    const store = createSkillStore({ userDataPath });
    assert.deepEqual(store.listSkills(), []);
  });

  it('loads a valid skill with frontmatter', () => {
    writeSkill(userDataPath, 'deploy-app', [
      '---',
      'skillId: deploy-app',
      'name: Deploy Application',
      'description: Deploys the app to production',
      'version: 1.2.0',
      'dataLevel: D1_internal',
      'allowed-tools:',
      '  - local.shell.exec',
      'attachments:',
      '  - assets/deploy.sh',
      '---',
      '',
      '# Deploy Instructions',
      '',
      'Run the deploy script.',
    ].join('\n'));

    const store = createSkillStore({ userDataPath });
    const skills = store.listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].skillId, 'deploy-app');
    assert.equal(skills[0].name, 'Deploy Application');
    assert.equal(skills[0].description, 'Deploys the app to production');
    assert.equal(skills[0].version, '1.2.0');
    assert.equal(skills[0].dataLevel, 'D1_internal');
  });

  it('uses directory name as skillId fallback', () => {
    writeSkill(userDataPath, 'my-skill', [
      '---',
      'name: My Skill',
      'description: A skill without explicit skillId',
      '---',
      '',
      'Some instructions',
    ].join('\n'));

    const store = createSkillStore({ userDataPath });
    assert.equal(store.listSkills()[0].skillId, 'my-skill');
  });

  it('findSkill returns null for unknown skillId', () => {
    const store = createSkillStore({ userDataPath });
    assert.equal(store.findSkill('non-existent'), null);
  });

  it('findSkill returns skill object for known skillId', () => {
    writeSkill(userDataPath, 'test-skill', '---\nskillId: test-skill\nname: Test\ndescription: A test skill\n---\nBody');
    const store = createSkillStore({ userDataPath });
    const skill = store.findSkill('test-skill');
    assert.ok(skill);
    assert.equal(skill.skillId, 'test-skill');
  });

  it('readSkillContext returns full context', () => {
    const dir = writeSkill(userDataPath, 'ctx-skill', [
      '---',
      'skillId: ctx-skill',
      'name: Context Skill',
      'description: desc',
      'version: 0.1.0',
      'dataLevel: D0_public',
      'allowed-tools:',
      '  - local.shell.exec',
      '  - local.health',
      '---',
      '',
      'Do something important.',
    ].join('\n'));

    // Create an asset file
    const assetsDir = path.join(dir, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, 'template.txt'), 'hello', 'utf8');

    const store = createSkillStore({ userDataPath });
    const ctx = store.readSkillContext('ctx-skill');
    assert.ok(ctx);
    assert.equal(ctx.skillId, 'ctx-skill');
    assert.equal(ctx.frontmatter.name, 'Context Skill');
    assert.deepEqual(ctx.frontmatter.allowedTools, ['local.shell.exec', 'local.health']);
    assert.equal(ctx.instructions, 'Do something important.');
    assert.equal(ctx.attachments.length, 1);
    assert.equal(ctx.attachments[0].path, 'assets/template.txt');
    assert.equal(ctx.attachments[0].byteLength, 5);
  });

  it('readSkillContext returns null for unknown skill', () => {
    const store = createSkillStore({ userDataPath });
    assert.equal(store.readSkillContext('nope'), null);
  });

  it('filters out skill with missing frontmatter (no description)', () => {
    // 无 frontmatter 即无 description，按通用规则应被过滤，不再容错加载。
    writeSkill(userDataPath, 'no-fm', 'Just plain markdown without frontmatter');
    const store = createSkillStore({ userDataPath });
    assert.equal(store.listSkills().length, 0);
  });

  it('filters out skill with invalid YAML frontmatter (no description)', () => {
    // 坏 YAML 解析后拿不到 description，按通用规则应被过滤。
    writeSkill(userDataPath, 'bad-yaml', '---\n: invalid: [yaml\n---\nBody');
    const store = createSkillStore({ userDataPath });
    assert.equal(store.listSkills().length, 0);
  });

  it('filters out skill with blank (whitespace-only) description', () => {
    writeSkill(userDataPath, 'blank-desc', '---\nskillId: blank-desc\nname: Blank\ndescription: "   "\n---\nBody');
    const store = createSkillStore({ userDataPath });
    assert.equal(store.listSkills().length, 0);
  });

  it('loads skill with a non-empty description', () => {
    writeSkill(userDataPath, 'with-desc', '---\nskillId: with-desc\nname: With Desc\ndescription: A real description\n---\nBody');
    const store = createSkillStore({ userDataPath });
    const skills = store.listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].skillId, 'with-desc');
    assert.equal(skills[0].description, 'A real description');
  });

  // Layer 2 支撑：whenToUse 字段读取与透传
  it('reads whenToUse from frontmatter (camelCase)', () => {
    writeSkill(userDataPath, 's-when', [
      '---',
      'skillId: s-when',
      'name: When Skill',
      'description: A test',
      'whenToUse: Use this when user asks for X',
      '---',
      'body',
    ].join('\n'));
    const store = createSkillStore({ userDataPath });
    const list = store.listSkills();
    assert.equal(list[0].whenToUse, 'Use this when user asks for X');
    const ctx = store.readSkillContext('s-when');
    assert.equal(ctx.frontmatter.whenToUse, 'Use this when user asks for X');
  });

  it('reads when-to-use from frontmatter (kebab-case)', () => {
    writeSkill(userDataPath, 's-kebab', [
      '---',
      'skillId: s-kebab',
      'name: Kebab Skill',
      'description: A kebab when-to-use skill',
      'when-to-use: Triggered for kebab',
      '---',
      'body',
    ].join('\n'));
    const store = createSkillStore({ userDataPath });
    assert.equal(store.listSkills()[0].whenToUse, 'Triggered for kebab');
  });

  it('whenToUse defaults to empty string when not declared', () => {
    writeSkill(userDataPath, 's-empty', '---\nskillId: s-empty\nname: Empty\ndescription: A skill without whenToUse\n---\nbody');
    const store = createSkillStore({ userDataPath });
    assert.equal(store.listSkills()[0].whenToUse, '');
  });

  it('refresh rescans the directory', () => {
    const store = createSkillStore({ userDataPath });
    assert.equal(store.listSkills().length, 0);

    writeSkill(userDataPath, 'new-skill', '---\nskillId: new-skill\nname: New\ndescription: A newly added skill\n---\nNew body');
    store.refresh();
    assert.equal(store.listSkills().length, 1);
    assert.equal(store.listSkills()[0].skillId, 'new-skill');
  });

  it('ignores non-directory entries in skills folder', () => {
    mkdirSync(path.join(userDataPath, 'skills'), { recursive: true });
    writeFileSync(path.join(userDataPath, 'skills', 'stray-file.txt'), 'not a skill');
    writeSkill(userDataPath, 'real-skill', '---\nskillId: real-skill\nname: Real\ndescription: A real skill\n---\nBody');

    const store = createSkillStore({ userDataPath });
    assert.equal(store.listSkills().length, 1);
    assert.equal(store.listSkills()[0].skillId, 'real-skill');
  });

  it('ignores directories without SKILL.md', () => {
    mkdirSync(path.join(userDataPath, 'skills', 'empty-dir'), { recursive: true });
    writeSkill(userDataPath, 'valid', '---\nskillId: valid\nname: Valid\ndescription: A valid skill\n---\nBody');

    const store = createSkillStore({ userDataPath });
    assert.equal(store.listSkills().length, 1);
  });
});
