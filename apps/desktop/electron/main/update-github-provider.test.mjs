import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PeerGitHubProvider, installPeerGitHubProvider, isStrictlyNewerUpdate } from './update-github-provider.mjs';

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('electron-updater/package.json'));
const semver = sdkRequire('semver');
const { AppUpdater } = require('electron-updater/out/AppUpdater.js');
const { createClient } = require('electron-updater/out/providerFactory.js');
const hash = Buffer.alloc(64, 7).toString('base64');
// Released Linux target is x64; retain the SDK's explicit cross-platform test seam.
process.env.TEST_UPDATER_ARCH = 'x64';

function fixture({ current = '0.1.0-beta.5', channel = 'beta', platform = 'darwin',
  tags = ['v0.1.0-rc.3', 'v0.1.0-beta.5', 'v0.0.18'], latest = 'v0.0.18', manifestVersion } = {}) {
  const requests = [];
  const suffix = platform === 'darwin' ? '-mac' : platform === 'linux' ? '-linux' : '';
  const updater = { channel, allowPrerelease: channel === 'beta', currentVersion: semver.parse(current), fullChangelog: false };
  const feed = `<feed>${tags.map(tag => `<entry><title>${tag}</title><link href="https://github.com/example/project/releases/tag/${tag}"/><content>Notes ${tag}</content></entry>`).join('')}</feed>`;
  const executor = { async request(options) {
    requests.push(options.path);
    if (options.path === '/example/project/releases.atom') return feed;
    if (options.path === '/example/project/releases/latest') return JSON.stringify({ tag_name: latest });
    const match = /^\/example\/project\/releases\/download\/([^/]+)\/((?:beta|latest).*\.yml)$/.exec(options.path);
    if (!match) throw new Error(`Unexpected request: ${options.path}`);
    const tag = match[1];
    const version = tag.replace(/^v/, '');
    const expected = `${semver.prerelease(version) ? 'beta' : 'latest'}${suffix}.yml`;
    if (match[2] !== expected) throw new Error(`Missing manifest: ${match[2]}`);
    return JSON.stringify({ version: manifestVersion ?? version,
      files: [{ url: `Peer-Agent-${version}.zip`, sha512: hash, size: 17 }] });
  } };
  const provider = new PeerGitHubProvider({ provider: 'custom', owner: 'example', repo: 'project' }, updater,
    { platform, executor, isUseMultipleRangeRequest: true });
  return { provider, updater, requests };
}

test('Beta5 discovers RC3 in the existing beta-mac manifest', async () => {
  const { provider, requests } = fixture();
  const info = await provider.getLatestVersion();
  assert.equal(info.version, '0.1.0-rc.3');
  assert.equal(info.tag, 'v0.1.0-rc.3');
  assert.ok(requests.includes('/example/project/releases/download/v0.1.0-rc.3/beta-mac.yml'));
  assert.equal(requests.some(path => path.includes('/rc-mac.yml')), false);
  const [file] = provider.resolveFiles(info);
  assert.equal(file.url.href, 'https://github.com/example/project/releases/download/v0.1.0-rc.3/Peer-Agent-0.1.0-rc.3.zip');
  assert.equal(file.info.sha512, hash);
});

test('RC3 remains current instead of offering Beta5 as a downgrade', async () => {
  const { provider, updater } = fixture({ current: '0.1.0-rc.3' });
  const info = await provider.getLatestVersion();
  assert.equal(info.version, '0.1.0-rc.3');
  assert.equal(await AppUpdater.prototype.isUpdateAvailable.call({ ...updater, allowDowngrade: false,
    isUpdateSupported: () => true, isUserWithinRollout: () => true }, info), false);
});

test('unordered releases choose the highest valid preview and ignore custom or malformed tags', async () => {
  const { provider } = fixture({ tags: ['v0.1.0-beta.5', 'notes', 'v1.0.0-canary.99', 'v0.1.0-rc.3', 'v0.1.0-rc.4', 'v9.0.0', 'v0.1.0-rc.04'] });
  assert.equal((await provider.getLatestVersion()).version, '0.1.0-rc.4');
});

test('a newer release line Beta is a valid upgrade from an older RC', async () => {
  const { provider } = fixture({ current: '0.1.0-rc.3', tags: ['v0.1.1-beta.1', 'v0.1.0-rc.3'] });
  assert.equal((await provider.getLatestVersion()).version, '0.1.1-beta.1');
});

test('explicit preview preference does not graduate to stable', async () => {
  const { provider } = fixture({ tags: ['v0.1.0', 'v0.1.0-rc.3'], latest: 'v0.1.0' });
  assert.equal((await provider.getLatestVersion()).version, '0.1.0-rc.3');
});

test('stable channel excludes previews and supports stable releases outside the Atom window', async () => {
  const { provider, requests } = fixture({ channel: 'latest', latest: 'v0.1.0', tags: ['v0.1.1-rc.1'] });
  assert.equal((await provider.getLatestVersion()).version, '0.1.0');
  assert.ok(requests.includes('/example/project/releases/download/v0.1.0/latest-mac.yml'));
});

test('manifest version must match the actual selected release tag', async () => {
  const { provider } = fixture({ manifestVersion: '0.1.0-beta.5' });
  await assert.rejects(provider.getLatestVersion(), /manifest.*version.*tag/i);
});

test('stable endpoint cannot inject a preview into stable channel', async () => {
  const { provider } = fixture({ channel: 'latest', latest: 'v0.1.0-rc.3' });
  await assert.rejects(provider.getLatestVersion(), /stable.*tag/i);
});

for (const [platform, name] of [['darwin', 'beta-mac.yml'], ['win32', 'beta.yml'], ['linux', 'beta-linux.yml']]) {
  test(`${platform} keeps SDK platform manifest naming and checksum resolution`, async () => {
    const { provider, requests } = fixture({ platform });
    const info = await provider.getLatestVersion();
    assert.ok(requests.at(-1).endsWith(`/${name}`));
    assert.equal(provider.resolveFiles(info)[0].info.sha512, hash);
    assert.equal(provider.isUseMultipleRangeRequest, false);
  });
}

test('installation uses the SDK custom factory and packaged host/repo/cache configuration', async () => {
  const { updater } = fixture();
  const options = { provider: 'github', host: 'releases.example.org', owner: 'original', repo: 'source', updaterCacheDirName: 'original-cache' };
  let applied;
  updater.configOnDisk = { value: Promise.resolve(options) };
  updater.setFeedURL = value => { applied = value; };
  assert.equal(await installPeerGitHubProvider(updater), true);
  assert.equal(applied.owner, options.owner); assert.equal(applied.repo, options.repo);
  assert.equal(applied.host, options.host); assert.equal(applied.updaterCacheDirName, options.updaterCacheDirName);
  assert.ok(createClient(applied, updater, { platform: 'darwin', executor: {} }) instanceof PeerGitHubProvider);
});

test('other providers and private/token GitHub configuration retain their original adapter', async () => {
  for (const options of [{ provider: 'generic' }, { provider: 'github', private: true }, { provider: 'github', token: 'fixture-token' }]) {
    let applied = false;
    assert.equal(await installPeerGitHubProvider({ configOnDisk: { value: Promise.resolve(options) }, setFeedURL: () => { applied = true; } }), false);
    assert.equal(applied, false);
  }
});

test('missing newest manifest fails without falling back to an older package', async () => {
  const { provider, requests } = fixture();
  provider.executor.request = async options => {
    requests.push(options.path);
    if (options.path.endsWith('.atom')) return '<feed><entry><link href="https://github.com/example/project/releases/tag/v0.1.0-rc.3"/></entry></feed>';
    throw new Error('fixture missing manifest');
  };
  await assert.rejects(provider.getLatestVersion(), /missing manifest/);
  assert.equal(requests.some(path => path.includes('/v0.1.0-beta.5/')), false);
});

test('only a complete newer semver is eligible, including a newer core Beta after RC', () => {
  for (const version of ['0.1.0-beta.5', '0.1.0-rc.3', '0.1.0-rc.3+build', '999', 'invalid', undefined]) {
    assert.equal(isStrictlyNewerUpdate(version, '0.1.0-rc.3'), false);
  }
  assert.equal(isStrictlyNewerUpdate('0.1.1-beta.1', '0.1.0-rc.3'), true);
  assert.equal(isStrictlyNewerUpdate('0.1.0', '0.1.0-rc.3'), true);
});
