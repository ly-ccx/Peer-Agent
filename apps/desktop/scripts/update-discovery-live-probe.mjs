// Explicit live metadata probe: no installer download, app replacement or user data writes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PeerGitHubProvider, isStrictlyNewerUpdate } from '../electron/main/update-github-provider.mjs';

const require = createRequire(import.meta.url);
const { AppUpdater } = require('electron-updater/out/AppUpdater.js');
const yaml = require('yaml');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const configPath = args.includes('--config') && option('--config');
const candidate = args.includes('--candidate') && option('--candidate');
const output = args.includes('--output') && option('--output');
assert.ok(configPath && candidate && output, '--config packaged app-update.yml --candidate x.y.z-rc.N --output result.json are required');
const config = yaml.parse(readFileSync(configPath, 'utf8'));
assert.equal(config.provider, 'github');
assert.ok(!config.private && !config.token, 'probe supports the public packaged release source only');
process.env.TEST_UPDATER_ARCH = 'x64';
const report = { schemaVersion: 1, startedAt: new Date().toISOString(),
  scope: 'Real production Provider and SDK eligibility; Node HTTP adapter; real published metadata. Platform manifests are checked without downloading/installing executables or mutating user settings.',
  sdkVersion: require('electron-updater/package.json').version,
  providerSourceSha256: createHash('sha256').update(readFileSync(new URL('../electron/main/update-github-provider.mjs', import.meta.url))).digest('hex'),
  releaseSource: { owner: config.owner, repo: config.repo, host: config.host ?? 'github.com' }, requests: [], checks: [] };
const documents = new Map();
const executor = { async request(options, cancellationToken) {
  const url = `${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ''}${options.path}`;
  if (documents.has(url)) return documents.get(url);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  cancellationToken?.onCancel(cancel);
  try {
    const response = await fetch(url, { headers: options.headers,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
    const body = await response.text();
    report.requests.push({ url, status: response.status, sha256: createHash('sha256').update(body).digest('hex') });
    assert.ok(response.ok, `metadata HTTP ${response.status}: ${url}`);
    documents.set(url, body);
    return body;
  } finally { cancellationToken?.removeListener('cancel', cancel); }
} };

try {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const [current, channel] of [['0.1.0-beta.5', 'beta'], ['0.1.0-rc.2', 'beta'], [candidate, 'beta'], [candidate, 'latest']]) {
      const updater = new AppUpdater(undefined, { version: current });
      updater.channel = channel;
      updater.allowPrerelease = channel === 'beta';
      updater.allowDowngrade = false;
      updater.autoDownload = false;
      updater.isUserWithinRollout = () => true;
      const provider = new PeerGitHubProvider(config, updater, { platform, executor });
      const info = await provider.getLatestVersion();
      const eligible = await updater.isUpdateAvailable(info);
      const files = provider.resolveFiles(info).map(file => ({ url: file.url.href, sha512: file.info.sha512, size: file.info.size }));
      assert.equal(eligible, isStrictlyNewerUpdate(info.version, current));
      if (channel === 'beta') assert.equal(info.version, candidate);
      else assert.equal(info.version.includes('-'), false);
      for (const file of files) {
        assert.ok(file.sha512 && Buffer.from(file.sha512, 'base64').length === 64);
        assert.ok(new URL(file.url).pathname.startsWith(`/${config.owner}/${config.repo}/releases/download/${info.tag}/`));
      }
      report.checks.push({ platform, installedVersion: current, channel, allowDowngrade: updater.allowDowngrade,
        selectedTag: info.tag, manifestVersion: info.version, updateAvailable: eligible, files });
    }
  }
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.message; process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, output, error: report.error }));
}
