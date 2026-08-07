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

test('uninstall refuses workspace skills and path-escape attempts', () => {
  const { store, workspaceRoot } = createStoreFixture();
  makeSkillDir(path.join(workspaceRoot, 'skills'), 'workspace-skill');
  store.refresh();
  assert.ok(store.listSkills().some((skill) => skill.skillId === 'workspace-skill' && skill.scope === 'workspace'));

  const workspaceResult = store.uninstallSkill('workspace-skill');
  assert.equal(workspaceResult.ok, false);
  assert.equal(workspaceResult.error, 'workspace-skill-not-uninstallable');
  assert.equal(existsSync(path.join(workspaceRoot, 'skills', 'workspace-skill')), true);

  const escapeResult = store.uninstallSkill('../escape-skill');
  assert.equal(escapeResult.ok, false);
  assert.equal(escapeResult.error, 'invalid-skill-id');
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
  const installed = store.installSkillFromZip(makeSkillZip('workspace-zip-skill'), { scope: 'workspace' });
  assert.equal(installed.skillId, 'workspace-zip-skill');
  assert.equal(installed.installScope, 'workspace');
  assert.equal(
    existsSync(path.join(workspaceRoot, 'skills', 'workspace-zip-skill', 'SKILL.md')),
    true,
  );
  assert.equal(
    existsSync(path.join(userDataPath, 'skills', 'workspace-zip-skill')),
    false,
  );
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
