import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBotProfileStore, createProjectRegistry, createSkillStore } from '@peer-agent/runtime-node';
import AdmZip from 'adm-zip';
import { createQoderMarketplaceService } from './qoder-marketplace-service.mjs';
import { createSkillInstallTargetDirectory } from './skill-install-target.mjs';
import { computeSkillHubContentHash, createSkillHubVerifiedInstaller } from './skillhub-verified-installer.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'peer-skill-targets-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataHome = path.join(root, 'data');
  const registry = createProjectRegistry({ filePath: path.join(dataHome, 'projects', 'registry.json') });
  const profiles = createBotProfileStore({ rootDir: dataHome });
  function bot(name, { status = 'active', present = true, bind = true } = {}) {
    const folder = path.join(root, name);
    if (present) mkdirSync(folder);
    const workspaceId = bind ? registry.ensureForPath(folder).workspaceId : 'still-has-a-profile';
    const { profile } = profiles.create({ workspaceId, displayName: name, agentConversationId: 'fixture' });
    if (status !== 'active') profiles.save({ ...profile, status });
    return { workspaceId, workspacePath: folder };
  }
  const peer = bot('peer-dev');
  const silly = bot('SillyTavern');
  const other = bot('unselected');
  const archived = bot('Peer RSI', { status: 'archived' });
  const disabled = bot('inactive', { status: 'disabled' });
  const missing = bot('失联机器人', { present: false });
  const unbound = bot('unbound', { bind: false });
  const alias = path.join(root, 'alias-for-silly');
  symlinkSync(silly.workspacePath, alias, 'junction');
  const settings = { activeWorkspace: alias, workspaces: [{ path: alias, name: '旧称' }] };
  const targetDirectory = createSkillInstallTargetDirectory({ dataHome, getSettings: () => settings, getViewingBotId: () => peer.workspaceId });
  const store = createSkillStore({ userDataPath: dataHome, workspacePath: silly.workspacePath });
  return { root, dataHome, registry, profiles, settings, targetDirectory, store, peer, silly, other, archived, disabled, missing, unbound, alias };
}

function installedFile(workspacePath, skill = 'sample-skill') {
  return path.join(workspacePath, 'skills', skill, 'SKILL.md');
}

const skillHubIdentity = { namespace: 'owner', slug: 'sample-skill', version: '1.0.0' };
const qoderIdentity = { skillId: 'qoder-sample' };
function packageZip() {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from('---\nname: sample-skill\ndescription: Example skill\n---\nTest instructions.\n'));
  zip.addFile('reference.txt', Buffer.from('hello'));
  return zip.toBuffer();
}

function marketInstallers({ targetDirectory, store }, { badSignature = false, badZip = false, beforeDownload } = {}) {
  const counts = { download: 0, signature: 0, keys: 0, prepare: 0 };
  const zip = packageZip();
  const { contentHash, fileCount } = computeSkillHubContentHash(new AdmZip(zip).getEntries());
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const payload = JSON.stringify({
    v: 1, issuer: 'skillhub.cn', publisher_user_name: 'owner',
    skill_slug: skillHubIdentity.slug, skill_version: skillHubIdentity.version,
    content_hash: contentHash, file_count: fileCount, package_md5: createHash('md5').update(zip).digest('hex'),
  });
  const signature = sign(null, Buffer.from(payload), privateKey);
  if (badSignature) signature[0] ^= 0xff;
  const prepareSkillFromZip = (...args) => {
    counts.prepare++;
    return store.prepareSkillFromZip(...args);
  };
  const download = async () => {
    counts.download++;
    beforeDownload?.();
    return badZip ? Buffer.from('not a zip') : zip;
  };
  const skillhub = createSkillHubVerifiedInstaller({
    targetDirectory, prepareSkillFromZip,
    apiClient: {
      getSkillInstallIdentity: async () => ({ ...skillHubIdentity, publisher: 'owner' }),
      getVersionSignature: async () => {
        counts.signature++;
        return { signed: true, payload, signature_b64: signature.toString('base64'), hash_version: 1, key_id: 'key' };
      },
      getPlatformKeys: async () => {
        counts.keys++;
        return { keys: [{ key_id: 'key', public_key_raw_b64: key, algorithm: 'Ed25519', issuer: 'skillhub.cn', status: 'active' }] };
      },
      downloadSkill: download,
    },
  });
  const qoder = createQoderMarketplaceService({
    targetDirectory, prepareSkillFromZip,
    apiClient: {
      getSkillDetail: async () => ({ version: '1.0.0', downloadUrl: 'https://example.test/skill.zip' }),
      downloadZip: download,
    },
  });
  return { skillhub, qoder, counts };
}

test('uses the active profile and current registration, merging classic rows by canonical path', (t) => {
  const { root, settings, targetDirectory, peer, silly, other, missing, archived, unbound, disabled, alias } = fixture(t);
  const classicPath = path.join(root, 'classic-only');
  mkdirSync(classicPath);
  settings.workspaces.push({ path: classicPath, name: 'Classic' }, { path: '' });
  for (const excluded of [archived, disabled, unbound]) settings.workspaces.push({ path: excluded.workspacePath, id: excluded.workspaceId });

  const targets = targetDirectory.list();
  assert.deepEqual(targets.map(({ name, kind, available }) => [name, kind, available]), [
    ['peer-dev', 'bot', true], ['SillyTavern', 'bot', true], ['unselected', 'bot', true], ['失联机器人', 'bot', false], ['Classic', 'workspace', true],
  ]);
  assert.equal(targets.find((target) => target.isActive).workspaceId, peer.workspaceId);
  assert.equal(targets.find((target) => target.workspaceId === missing.workspaceId).unavailableReason, 'workspace_install_target_missing');
  assert.equal(targetDirectory.resolve([{ workspacePath: alias }])[0].receipt.workspaceId, silly.workspaceId);
  for (const excluded of [archived, disabled, unbound]) {
    assert.equal(targetDirectory.resolve([excluded])[0].error, 'workspace_install_target_not_registered');
  }
  assert.equal(targetDirectory.resolve([other, { workspacePath: other.workspacePath }]).length, 1);
  assert.equal(targetDirectory.resolve([{ workspaceId: peer.workspaceId, workspacePath: silly.workspacePath }])[0].error,
    'workspace_install_target_mismatch');
});

test('a read of invalid registry data fails without rewriting the record', (t) => {
  const { dataHome, targetDirectory } = fixture(t);
  const registryFile = path.join(dataHome, 'projects', 'registry.json');
  writeFileSync(registryFile, 'bad registry');
  assert.throws(() => targetDirectory.list(), /CORRUPT_REGISTRY/);
  assert.equal(readFileSync(registryFile, 'utf8'), 'bad registry');
});

for (const [name, identity] of [['skillhub', skillHubIdentity], ['qoder', qoderIdentity]]) {
  test(`${name}: batch downloads and prepares once and lists the installed skill for a registry-only Bot`, async (t) => {
    const current = fixture(t);
    const { peer, silly, other, dataHome, targetDirectory, store, alias } = current;
    const installers = marketInstallers(current);
    const result = await installers[name].install({ ...identity, scope: 'workspace', targets: [peer, silly, { workspacePath: alias }] });
    assert.equal(result.ok, true);
    assert.equal(result.partial, false);
    assert.equal(result.succeededCount, 2);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(result.results.map(({ name, ok }) => [name, ok]), [['peer-dev', true], ['SillyTavern', true]]);
    assert.deepEqual(installers.counts, { download: 1, signature: name === 'skillhub' ? 1 : 0, keys: name === 'skillhub' ? 1 : 0, prepare: 1 });
    for (const target of [peer, silly]) {
      assert.match(readFileSync(installedFile(target.workspacePath), 'utf8'), /Test instructions/);
      assert.equal(readFileSync(path.join(target.workspacePath, 'skills', 'sample-skill', 'reference.txt'), 'utf8'), 'hello');
    }
    assert.equal(existsSync(path.join(other.workspacePath, 'skills')), false);
    assert.equal(existsSync(installedFile(dataHome)), false);
    const paths = targetDirectory.list().filter((target) => target.available).map((target) => target.path);
    const list = store.listSkills(paths);
    assert.equal(list.length, 2);
    assert.equal(list.find((row) => row.workspacePath === peer.workspacePath)?.skillId, 'sample-skill');
    assert.equal(store.getWorkspacePath(), silly.workspacePath);
  });

  test(`${name}: a package rejected by the normal verification chain writes nothing`, async (t) => {
    const current = fixture(t);
    const { peer, silly } = current;
    const installers = marketInstallers(current, name === 'skillhub' ? { badSignature: true } : { badZip: true });
    const result = await installers[name].install({ ...identity, scope: 'workspace', targets: [peer, silly] });
    assert.equal(result.ok, false);
    assert.equal(result.partial, false);
    assert.equal(result.failedCount, 2);
    assert.ok(result.results.every((row) => !row.ok && row.error));
    if (name === 'skillhub') {
      assert.ok(result.results.every((row) => row.error === 'skillhub_signature_invalid'));
      assert.equal(installers.counts.prepare, 0);
    }
    assert.equal(installers.counts.download, 1);
    for (const target of [peer, silly]) assert.equal(existsSync(path.join(target.workspacePath, 'skills')), false);
  });

  test(`${name}: reports failures for disconnected or unsafe targets and retries only the recovered target`, async (t) => {
    const current = fixture(t);
    const { peer, silly, missing, other, dataHome } = current;
    const symlinkRoot = path.join(silly.workspacePath, 'skills');
    const unselectedSkills = path.join(other.workspacePath, 'skills');
    mkdirSync(unselectedSkills);
    symlinkSync(unselectedSkills, symlinkRoot, 'junction');
    const installers = marketInstallers(current);
    const result = await installers[name].install({ ...identity, scope: 'workspace', targets: [peer, missing, silly] });
    assert.equal(result.ok, false);
    assert.equal(result.partial, true);
    assert.equal(result.succeededCount, 1);
    assert.equal(result.failedCount, 2);
    assert.deepEqual(result.results.map((item) => item.ok ? 'ok' : item.error),
      ['ok', 'workspace_install_target_missing', 'skill_install_path_conflict']);
    assert.equal(existsSync(installedFile(other.workspacePath)), false);
    assert.equal(existsSync(installedFile(dataHome)), false);
    assert.equal(existsSync(path.join(missing.workspacePath, 'skills')), false);
    writeFileSync(installedFile(peer.workspacePath), 'first target preserved');
    rmSync(symlinkRoot);
    const recovered = await installers[name].install({ ...identity, scope: 'workspace', targets: [silly] });
    assert.equal(recovered.ok, true);
    assert.equal(readFileSync(installedFile(peer.workspacePath), 'utf8'), 'first target preserved');
  });

  test(`${name}: legacy workspacePath passes through the same current admission, with no fallback`, async (t) => {
    const current = fixture(t);
    const { peer, archived, missing, dataHome } = current;
    const installers = marketInstallers(current);
    await assert.rejects(installers[name].install({ ...identity, scope: 'workspace' }), /workspace_install_target_required/);
    await assert.rejects(installers[name].install({ ...identity, scope: 'workspace', workspacePath: archived.workspacePath }), /workspace_install_target_not_registered/);
    await assert.rejects(installers[name].install({ ...identity, scope: 'workspace', workspacePath: missing.workspacePath }), /workspace_install_target_missing/);
    await assert.rejects(installers[name].install({ ...identity, targets: [peer] }), /workspace_install_target_required/);
    assert.equal(installers.counts.download, 0);
    const legacy = await installers[name].install({ ...identity, scope: 'workspace', workspacePath: peer.workspacePath });
    assert.equal(legacy.ok, true);
    assert.equal(legacy.scope, 'workspace');
    assert.equal(legacy.results, undefined);
    assert.ok(existsSync(installedFile(peer.workspacePath)));
    assert.equal(existsSync(installedFile(dataHome)), false);
  });
}

test('registration change during download fails that Bot without recreating its old directory or writing to the new one', async (t) => {
  const current = fixture(t);
  const { root, peer, silly, registry, settings } = current;
  const moved = path.join(root, 'moved');
  settings.workspaces.push({ path: peer.workspacePath, id: peer.workspaceId });
  const { skillhub } = marketInstallers(current, { beforeDownload() {
    renameSync(peer.workspacePath, moved);
    assert.equal(registry.recordMove(peer.workspaceId, moved).ok, true);
  } });
  const result = await skillhub.install({ ...skillHubIdentity, scope: 'workspace', targets: [peer, silly] });
  assert.equal(result.partial, true);
  assert.equal(result.results[0].error, 'workspace_install_target_changed');
  assert.ok(result.results[1].ok);
  assert.equal(existsSync(peer.workspacePath), false);
  assert.equal(existsSync(installedFile(moved)), false);
  assert.equal(current.targetDirectory.resolve([{ workspacePath: peer.workspacePath }])[0].error, 'workspace_install_target_not_registered');
});
