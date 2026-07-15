import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCredentialHelper,
  copyCredentialHelperArtifact,
  credentialHelperArtifactPath,
  credentialHelperFilename,
} from './build-credential-helper.mjs';

test('uses platform-specific helper filenames and Cargo profile layouts', () => {
  const root = path.join(os.tmpdir(), 'peer-helper-root');

  assert.equal(credentialHelperFilename('darwin'), 'peer-credential-helper');
  assert.equal(credentialHelperFilename('linux'), 'peer-credential-helper');
  assert.equal(credentialHelperFilename('win32'), 'peer-credential-helper.exe');
  assert.equal(
    credentialHelperArtifactPath({ repositoryRoot: root, profile: 'debug', platform: 'linux' }),
    path.join(root, 'target', 'debug', 'peer-credential-helper'),
  );
  assert.equal(
    credentialHelperArtifactPath({ repositoryRoot: root, profile: 'release', platform: 'win32' }),
    path.join(root, 'target', 'release', 'peer-credential-helper.exe'),
  );
});

test('builds the helper with a locked Cargo dependency graph and copies it for consumers', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-helper-build-'));
  const destination = path.join(root, 'apps', 'tui', 'dist');
  const source = credentialHelperArtifactPath({
    repositoryRoot: root,
    profile: 'release',
    platform: 'linux',
  });
  let invocation;

  const result = buildCredentialHelper({
    repositoryRoot: root,
    profile: 'release',
    platform: 'linux',
    destinationDirectories: [destination],
    runner(command, args, options) {
      invocation = { command, args, options };
      mkdirSync(path.dirname(source), { recursive: true });
      writeFileSync(source, 'helper-binary', { mode: 0o755 });
      return { status: 0, signal: null, error: undefined };
    },
  });

  assert.equal(invocation.command, 'cargo');
  assert.deepEqual(invocation.args, [
    'build',
    '--locked',
    '--package',
    'peer-credential-helper',
    '--release',
  ]);
  assert.equal(invocation.options.cwd, root);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(result.artifactPath, source);
  assert.deepEqual(result.copiedPaths, [path.join(destination, 'peer-credential-helper')]);
  assert.equal(readFileSync(result.copiedPaths[0], 'utf8'), 'helper-binary');
  assert.equal(statSync(result.copiedPaths[0]).mode & 0o777, 0o755);
});

test('copies the Windows helper name without relying on Unix executable bits', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-helper-copy-'));
  const source = credentialHelperArtifactPath({
    repositoryRoot: root,
    profile: 'debug',
    platform: 'win32',
  });
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, 'windows-helper');

  const copied = copyCredentialHelperArtifact({
    repositoryRoot: root,
    profile: 'debug',
    platform: 'win32',
    destinationDirectory: 'consumer/bin',
  });

  assert.equal(copied, path.join(root, 'consumer', 'bin', 'peer-credential-helper.exe'));
  assert.equal(readFileSync(copied, 'utf8'), 'windows-helper');
});

test('rejects missing build artifacts and unsupported profiles', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-helper-failure-'));

  assert.throws(
    () => credentialHelperArtifactPath({ repositoryRoot: root, profile: 'optimized' }),
    /Unsupported credential helper build profile/,
  );
  assert.throws(
    () => buildCredentialHelper({
      repositoryRoot: root,
      profile: 'debug',
      runner: () => ({ status: 0, signal: null, error: undefined }),
    }),
    /build completed without producing/,
  );
});
