import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import AdmZip from 'adm-zip';
import { computeSkillHubContentHash, createSkillHubVerifiedInstaller } from './skillhub-verified-installer.mjs';

const identity = { namespace: 'owner', slug: 'demo', version: '1.0.0' };
function md5(value) { return createHash('md5').update(value).digest('hex'); }
function makeZip(skill = '# Skill', extra = 'hello') {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(skill));
  zip.addFile('README.md', Buffer.from(extra));
  zip.addFile('_meta.json', Buffer.from('{}'));
  return zip.toBuffer();
}
function fixture({ zipBuffer = makeZip(), keyId = 'platform-v1', overridePayload = {}, tamperSignature = false } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const calculated = computeSkillHubContentHash(new AdmZip(zipBuffer).getEntries());
  const payload = JSON.stringify({ content_hash: calculated.contentHash, file_count: calculated.fileCount, issuer: 'skillhub.cn', package_md5: md5(zipBuffer), publisher_user_name: identity.namespace, skill_slug: identity.slug, skill_version: identity.version, v: 1, ...overridePayload });
  const signature = sign(null, Buffer.from(payload), privateKey);
  if (tamperSignature) signature[0] ^= 0xff;
  return {
    zipBuffer, apiClient: {
      getVersionSignature: async () => ({ signed: true, content_hash: calculated.contentHash, hash_version: 1, key_id: keyId, payload, signature: signature.toString('base64') }),
      getPlatformKeys: async () => ({ keys: [{ key_id: 'platform-v1', algorithm: 'Ed25519', status: 'active', issuer: 'skillhub.cn', public_key_raw_b64: rawKey }] }),
      downloadSkill: async () => zipBuffer,
    },
  };
}

test('verifies Ed25519, MD5 and content hash before entering the existing Skill Store', async () => {
  const value = fixture();
  let installed;
  let installOptions;
  const installer = createSkillHubVerifiedInstaller({
    apiClient: value.apiClient,
    installSkillFromZip: async (zip, options) => {
      installed = zip;
      installOptions = options;
      return { id: 'demo' };
    },
  });
  const result = await installer.install(identity);
  assert.equal(result.ok, true);
  assert.equal(result.skillId, 'demo');
  assert.equal(result.scope, 'global');
  assert.equal(installed, value.zipBuffer);
  assert.deepEqual(installOptions, {
    scope: 'global',
    workspacePath: null,
    source: 'skillhub',
    iconUrl: null,
    meta: {
      source: 'skillhub',
      namespace: 'owner',
      slug: 'demo',
      version: '1.0.0',
    },
  });
});

test('forwards install scope to Skill Store and echoes it in the result', async () => {
  const value = fixture();
  let installOptions;
  const installer = createSkillHubVerifiedInstaller({
    apiClient: value.apiClient,
    installSkillFromZip: async (_zip, options) => {
      installOptions = options;
      return { id: 'demo' };
    },
  });
  const result = await installer.install({
    ...identity,
    scope: 'workspace',
    workspacePath: '/Users/demo/other',
    iconUrl: 'https://example.com/icon.png',
  });
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'workspace');
  assert.deepEqual(installOptions, {
    scope: 'workspace',
    workspacePath: '/Users/demo/other',
    source: 'skillhub',
    iconUrl: 'https://example.com/icon.png',
    meta: {
      source: 'skillhub',
      namespace: 'owner',
      slug: 'demo',
      version: '1.0.0',
    },
  });
});

test('rejects an invalid signature, unknown key id, and untrusted key issuer before installation', async () => {
  const untrusted = fixture();
  const untrustedKeys = await untrusted.apiClient.getPlatformKeys();
  const untrustedIssuer = {
    ...untrusted,
    apiClient: {
      ...untrusted.apiClient,
      getPlatformKeys: async () => ({ keys: untrustedKeys.keys.map((key) => ({ ...key, issuer: 'attacker.example' })) }),
    },
  };
  for (const value of [fixture({ tamperSignature: true }), fixture({ keyId: 'unknown' }), untrustedIssuer]) {
    let installs = 0;
    const installer = createSkillHubVerifiedInstaller({ apiClient: value.apiClient, installSkillFromZip: () => { installs += 1; } });
    await assert.rejects(() => installer.install(identity), /signature_(invalid|key_unknown|key_untrusted)/);
    assert.equal(installs, 0);
  }
});

test('rejects a tampered ZIP, wrong content hash, coordinate substitution, and unknown hash version', async () => {
  const signed = fixture();
  const tampered = makeZip('# Changed');
  const unknownVersion = fixture();
  const unknownSignature = await unknownVersion.apiClient.getVersionSignature();
  const variants = [
    [{ ...signed.apiClient, downloadSkill: async () => tampered }, /(package_md5)_mismatch/],
    [fixture({ overridePayload: { content_hash: '0'.repeat(64) } }).apiClient, /(content_hash)_mismatch/],
    [fixture({ overridePayload: { skill_slug: 'another' } }).apiClient, /(identity)_mismatch/],
    [fixture({ overridePayload: { publisher_user_name: 'another' } }).apiClient, /(identity)_mismatch/],
    [{ ...unknownVersion.apiClient, getVersionSignature: async () => ({ ...unknownSignature, hash_version: 2 }) }, /hash_version_unsupported/],
  ];
  for (const [apiClient, expected] of variants) {
    const installer = createSkillHubVerifiedInstaller({ apiClient, installSkillFromZip: () => { throw new Error('must not install'); } });
    await assert.rejects(() => installer.install(identity), expected);
  }
});

test('accepts standard directory entries while preserving archive safety checks', async () => {
  const zip = new AdmZip();
  zip.addFile('demo/', Buffer.alloc(0));
  zip.addFile('demo/SKILL.md', Buffer.from('# Skill'));
  const value = fixture({ zipBuffer: zip.toBuffer() });
  const installer = createSkillHubVerifiedInstaller({ apiClient: value.apiClient, installSkillFromZip: () => ({ id: 'demo' }) });
  const result = await installer.install(identity);
  assert.equal(result.skillId, 'demo');
});

test('content hash follows SkillHub v1 path ordering and ignores metadata files', () => {
  const first = new AdmZip();
  first.addFile('b.txt', Buffer.from('b'));
  first.addFile('a.txt', Buffer.from('a'));
  first.addFile('_meta.json', Buffer.from('one'));
  const second = new AdmZip();
  second.addFile('_meta.json', Buffer.from('changed'));
  second.addFile('a.txt', Buffer.from('a'));
  second.addFile('b.txt', Buffer.from('b'));
  assert.deepEqual(computeSkillHubContentHash(first.getEntries()), computeSkillHubContentHash(second.getEntries()));
  assert.equal(computeSkillHubContentHash(first.getEntries()).fileCount, 2);
});

test('rejects unsafe archives and missing SKILL.md', async () => {
  const zip = new AdmZip();
  zip.addFile('README.md', Buffer.from('x'));
  const value = fixture({ zipBuffer: zip.toBuffer() });
  const installer = createSkillHubVerifiedInstaller({ apiClient: value.apiClient, installSkillFromZip: () => ({ id: 'x' }) });
  await assert.rejects(() => installer.install(identity), /missing_skill/);
});
