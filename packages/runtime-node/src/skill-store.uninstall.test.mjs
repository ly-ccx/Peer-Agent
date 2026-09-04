import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { createSkillStore } from './skill-store.mjs';

function makeSkillDir(root, skillId, { description = 'demo skill' } = {}) {
  const dir = path.join(root, skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---
name: ${skillId}
description: ${description}
---

# ${skillId}
`);
  return dir;
}

function createStoreFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-skill-uninstall-'));
  const userDataPath = path.join(root, 'userData');
  const workspaceRoot = path.join(root, 'workspace');
  const sourceRoot = path.join(root, 'agents-skills');
  mkdirSync(userDataPath, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
  const store = createSkillStore({
    userDataPath,
    sourceRoots: [sourceRoot],
    workspacePath: workspaceRoot,
  });
  return { root, userDataPath, workspaceRoot, sourceRoot, store };
}

test('uninstall deletes a user-installed skill directory under userData/skills', () => {
  const { store, userDataPath } = createStoreFixture();
  makeSkillDir(path.join(userDataPath, 'skills'), 'user-skill');
  store.refresh();
  assert.ok(store.listSkills().some((skill) => skill.skillId === 'user-skill'));

  const result = store.uninstallSkill('user-skill');
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'deleted');
  assert.equal(existsSync(path.join(userDataPath, 'skills', 'user-skill')), false);
  assert.equal(store.listSkills().some((skill) => skill.skillId === 'user-skill'), false);
});

test('uninstall unlinks a borrowed skill without deleting the source directory', () => {
  const { store, userDataPath, sourceRoot } = createStoreFixture();
  const sourceDir = makeSkillDir(sourceRoot, 'borrowed-skill');
  const linkPath = path.join(userDataPath, 'skills', 'borrowed-skill');
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(sourceDir, linkPath);
  store.refresh();
  assert.ok(store.listSkills().some((skill) => skill.skillId === 'borrowed-skill'));

  const result = store.uninstallSkill('borrowed-skill');
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'unlinked');
  assert.equal(existsSync(linkPath), false);
  assert.equal(existsSync(sourceDir), true);
  assert.equal(lstatSync(sourceDir).isDirectory(), true);
});

test('uninstall refuses hand-authored workspace skills and path-escape attempts', () => {
  const { store, workspaceRoot } = createStoreFixture();
  makeSkillDir(path.join(workspaceRoot, 'skills'), 'workspace-skill');
  store.refresh();
  const workspaceSkill = store.listSkills().find((skill) => skill.skillId === 'workspace-skill');
  assert.equal(workspaceSkill?.scope, 'workspace');
  assert.equal(workspaceSkill?.canUninstall, false);

  const workspaceResult = store.uninstallSkill('workspace-skill');
  assert.equal(workspaceResult.ok, false);
  assert.equal(workspaceResult.error, 'workspace-skill-not-uninstallable');
  assert.equal(existsSync(path.join(workspaceRoot, 'skills', 'workspace-skill')), true);

  const escapeResult = store.uninstallSkill('../escape-skill');
  assert.equal(escapeResult.ok, false);
  assert.equal(escapeResult.error, 'invalid-skill-id');
});

test('uninstall refuses workspace symlinks even when their target has managed metadata', () => {
  const { store, workspaceRoot, sourceRoot } = createStoreFixture();
  const sourceDir = makeSkillDir(sourceRoot, 'linked-workspace-skill');
  writeFileSync(path.join(sourceDir, '_meta.json'), JSON.stringify({ source: 'skillhub' }));
  const linkPath = path.join(workspaceRoot, 'skills', 'linked-workspace-skill');
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(sourceDir, linkPath);
  store.refresh();

  const skill = store.listSkills().find((item) => item.skillId === 'linked-workspace-skill');
  assert.equal(skill?.scope, 'workspace');
  assert.equal(skill?.canUninstall, false);
  const result = store.uninstallSkill('linked-workspace-skill');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'workspace-skill-not-uninstallable');
  assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(existsSync(sourceDir), true);
});

function makeSkillZip(skillId = 'zip-skill') {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(`---
name: ${skillId}
description: zip install fixture
skillId: ${skillId}
---

# ${skillId}
`));
  zip.addFile('README.md', Buffer.from('fixture'));
  return zip.toBuffer();
}

test('installSkillFromZip defaults to global userData/skills', () => {
  const { store, userDataPath } = createStoreFixture();
  const installed = store.installSkillFromZip(makeSkillZip('global-zip-skill'));
  assert.equal(installed.skillId, 'global-zip-skill');
  assert.equal(installed.installScope, 'global');
  assert.equal(
    existsSync(path.join(userDataPath, 'skills', 'global-zip-skill', 'SKILL.md')),
    true,
  );
  assert.match(
    readFileSync(path.join(userDataPath, 'skills', 'global-zip-skill', 'SKILL.md'), 'utf8'),
    /global-zip-skill/,
  );
});

test('installSkillFromZip writes workspace/skills when scope=workspace', () => {
  const { store, userDataPath, workspaceRoot } = createStoreFixture();
  const installed = store.installSkillFromZip(makeSkillZip('workspace-zip-skill'), {
    scope: 'workspace',
    source: 'skillhub',
  });
  assert.equal(installed.skillId, 'workspace-zip-skill');
  assert.equal(installed.installScope, 'workspace');
  assert.equal(installed.canUninstall, true);
  assert.equal(store.getSkillDetail('workspace-zip-skill')?.canUninstall, true);
  assert.equal(
    existsSync(path.join(workspaceRoot, 'skills', 'workspace-zip-skill', 'SKILL.md')),
    true,
  );
  assert.equal(
    existsSync(path.join(userDataPath, 'skills', 'workspace-zip-skill')),
    false,
  );
});

test('uninstall deletes a managed workspace install and keeps the workspace root', () => {
  const { store, workspaceRoot } = createStoreFixture();
  const target = path.join(workspaceRoot, 'skills', 'workspace-managed-skill');
  store.installSkillFromZip(makeSkillZip('workspace-managed-skill'), {
    scope: 'workspace',
    source: 'qoder-marketplace',
  });

  const result = store.uninstallSkill('workspace-managed-skill');
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'deleted');
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(path.join(workspaceRoot, 'skills')), true);
});

test('workspace frontmatter source alone does not grant delete permission', () => {
  const { store, workspaceRoot } = createStoreFixture();
  const target = makeSkillDir(path.join(workspaceRoot, 'skills'), 'frontmatter-source-skill');
  writeFileSync(path.join(target, 'SKILL.md'), `---\nname: frontmatter-source-skill\ndescription: demo\nsource: skillhub\n---\n`);
  store.refresh();

  const skill = store.listSkills().find((item) => item.skillId === 'frontmatter-source-skill');
  assert.equal(skill?.source, 'skillhub');
  assert.equal(skill?.canUninstall, false);
  const result = store.uninstallSkill('frontmatter-source-skill');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'workspace-skill-not-uninstallable');
  assert.equal(existsSync(target), true);
});

test('installSkillFromZip rejects workspace scope without an active workspace', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-skill-install-scope-'));
  const userDataPath = path.join(root, 'userData');
  mkdirSync(userDataPath, { recursive: true });
  const store = createSkillStore({ userDataPath, workspacePath: null });
  assert.throws(
    () => store.installSkillFromZip(makeSkillZip('needs-workspace'), { scope: 'workspace' }),
    /workspace_required/,
  );
  assert.equal(existsSync(path.join(userDataPath, 'skills', 'needs-workspace')), false);
});

/** SkillHub 常见：description 未加引号且含 "Use when:"，严格 YAML 会 Nested mappings 失败。 */
function makeColonDescriptionSkillZip(skillId = 'weather-plus') {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(`---
name: ${skillId}
version: 1.0.2
description: 查询中国城市天气信息并提供穿衣建议。使用中国天气网 (weather.com.cn) 数据。Use when: 用户询问天气、温度、穿衣建议。
---

# ${skillId}
`));
  return zip.toBuffer();
}

test('listSkills loads skill whose description contains unquoted colons (YAML fallback)', () => {
  const { store, userDataPath } = createStoreFixture();
  const skillDir = path.join(userDataPath, 'skills', 'weather-plus');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: weather-plus
version: 1.0.2
description: 查询中国城市天气信息并提供穿衣建议。使用中国天气网 (weather.com.cn) 数据。Use when: 用户询问天气、温度、穿衣建议。
---

# weather-plus
`);
  store.refresh();
  const listed = store.listSkills().find((skill) => skill.skillId === 'weather-plus');
  assert.ok(listed, 'weather-plus should appear after loose frontmatter fallback');
  assert.match(listed.description, /Use when:/);
});

test('installSkillFromZip recovers name from colon-containing description frontmatter', () => {
  const { store, userDataPath } = createStoreFixture();
  const installed = store.installSkillFromZip(makeColonDescriptionSkillZip('weather-plus'));
  assert.equal(installed.skillId, 'weather-plus');
  assert.equal(installed.installScope, 'global');
  assert.equal(existsSync(path.join(userDataPath, 'skills', 'weather-plus', 'SKILL.md')), true);
  assert.ok(store.listSkills().some((skill) => skill.skillId === 'weather-plus'));
});

test('installSkillFromZip throws skill_install_unreadable when SKILL.md has empty description', () => {
  const { store, userDataPath } = createStoreFixture();
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(`---
name: broken-skill
description: 
---

# broken
`));
  assert.throws(
    () => store.installSkillFromZip(zip.toBuffer()),
    /skill_install_unreadable/,
  );
  // 文件可能已写入，但不得出现在 listSkills 中
  assert.equal(store.listSkills().some((skill) => skill.skillId === 'broken-skill'), false);
  assert.equal(existsSync(path.join(userDataPath, 'skills', 'broken-skill')), true);
});

test('installSkillFromZip persists market source and iconUrl into _meta.json', () => {
  const { store, userDataPath } = createStoreFixture();
  const installed = store.installSkillFromZip(makeColonDescriptionSkillZip('weather-plus'), {
    source: 'skillhub',
    iconUrl: 'https://example.com/weather.png',
    meta: { namespace: 'chenchaoqun', slug: 'weather-plus-cn' },
  });
  assert.equal(installed.skillId, 'weather-plus');
  assert.equal(installed.source, 'skillhub');
  assert.equal(installed.iconUrl, 'https://example.com/weather.png');
  const meta = JSON.parse(readFileSync(path.join(userDataPath, 'skills', 'weather-plus', '_meta.json'), 'utf8'));
  assert.equal(meta.source, 'skillhub');
  assert.equal(meta.iconUrl, 'https://example.com/weather.png');
  assert.equal(meta.slug, 'weather-plus-cn');
  const listed = store.listSkills().find((skill) => skill.skillId === 'weather-plus');
  assert.equal(listed?.source, 'skillhub');
  assert.equal(listed?.iconUrl, 'https://example.com/weather.png');
});

test('listSkills reads source from frontmatter x-source and icon from _meta.json', () => {
  const { store, userDataPath } = createStoreFixture();
  const skillDir = path.join(userDataPath, 'skills', 'aone-demo');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: aone-demo
description: borrowed skill with source
x-source: aone-open
---

# aone-demo
`);
  writeFileSync(path.join(skillDir, '_meta.json'), `${JSON.stringify({ iconUrl: 'https://example.com/aone.png' }, null, 2)}\n`);
  store.refresh();
  const listed = store.listSkills().find((skill) => skill.skillId === 'aone-demo');
  assert.equal(listed?.source, 'aone-open');
  assert.equal(listed?.iconUrl, 'https://example.com/aone.png');
});
