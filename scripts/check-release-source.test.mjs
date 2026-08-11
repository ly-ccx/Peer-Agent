import assert from 'node:assert/strict';
import test from 'node:test';

import { checkReleaseSource, parseReleaseTag } from './check-release-source.mjs';

function createGitRunner({ commitSha = 'release-sha', mainExists = true, contained = true } = {}) {
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD^{commit}') {
      return { status: 0, stdout: `${commitSha}\n`, stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return mainExists
        ? { status: 0, stdout: 'main-sha\n', stderr: '' }
        : { status: 128, stdout: '', stderr: 'unknown revision' };
    }
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      return { status: contained ? 0 : 1, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected git call: ${[command, ...args].join(' ')}`);
  };
  return { runner, calls };
}

test('parses stable and prerelease tags', () => {
  assert.deepEqual(parseReleaseTag('v1.2.3'), {
    tag: 'v1.2.3',
    version: '1.2.3',
    prerelease: false,
  });
  assert.deepEqual(parseReleaseTag('v1.2.3-beta.4'), {
    tag: 'v1.2.3-beta.4',
    version: '1.2.3-beta.4',
    prerelease: true,
  });
  assert.throws(() => parseReleaseTag('1.2.3'), /Unsupported release tag/);
  assert.throws(() => parseReleaseTag('v1.2'), /Unsupported release tag/);
});

test('accepts a stable release commit contained in main', () => {
  const { runner, calls } = createGitRunner({ contained: true });
  const result = checkReleaseSource({
    tag: 'v1.2.3',
    expectedVersion: '1.2.3',
    runner,
  });

  assert.equal(result.mainContained, true);
  assert.deepEqual(calls.at(-1), [
    'git',
    'merge-base',
    '--is-ancestor',
    'release-sha',
    'origin/main',
  ]);
});

test('blocks a stable release commit outside main', () => {
  const { runner } = createGitRunner({ contained: false });
  assert.throws(
    () => checkReleaseSource({
      tag: 'v1.2.3',
      expectedVersion: '1.2.3',
      runner,
    }),
    /not contained in origin\/main.*Merge the release commit into main before creating the stable tag/,
  );
});

test('allows a prerelease commit outside main', () => {
  const { runner, calls } = createGitRunner({ contained: false });
  const result = checkReleaseSource({
    tag: 'v1.2.3-beta.4',
    expectedVersion: '1.2.3-beta.4',
    runner,
  });

  assert.equal(result.prerelease, true);
  assert.equal(result.mainContained, null);
  assert.equal(calls.some((call) => call.includes('merge-base')), false);
});

test('blocks a tag whose version does not match VERSION', () => {
  const { runner, calls } = createGitRunner();
  assert.throws(
    () => checkReleaseSource({
      tag: 'v1.2.4',
      expectedVersion: '1.2.3',
      runner,
    }),
    /version 1\.2\.4, but VERSION is 1\.2\.3/,
  );
  assert.equal(calls.length, 0);
});

test('fails closed when the main reference is unavailable', () => {
  const { runner } = createGitRunner({ mainExists: false });
  assert.throws(
    () => checkReleaseSource({
      tag: 'v1.2.3',
      expectedVersion: '1.2.3',
      runner,
    }),
    /git rev-parse --verify origin\/main\^\{commit\} failed/,
  );
});
