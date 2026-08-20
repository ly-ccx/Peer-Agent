import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { packageCliArchive, parseTargetSpec } from './package-cli-archive.mjs';

describe('parseTargetSpec', () => {
  it('splits linux-x64 and darwin-arm64', () => {
    assert.deepEqual(parseTargetSpec('linux-x64'), ['linux', 'x64']);
    assert.deepEqual(parseTargetSpec('darwin-arm64'), ['darwin', 'arm64']);
  });

  it('keeps win32 as the platform', () => {
    assert.deepEqual(parseTargetSpec('win32-x64'), ['win32', 'x64']);
  });
});

describe('packageCliArchive', () => {
  it('builds peer-linux-x64.tar.gz with peer + helper side by side', () => {
    const root = mkdtempSync(join(tmpdir(), 'peer-cli-pkg-'));
    const distDir = join(root, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'peer'), '#!/bin/sh\necho peer\n');
    writeFileSync(join(distDir, 'peer-credential-helper'), '#!/bin/sh\necho helper\n');
    chmodSync(join(distDir, 'peer'), 0o755);
    chmodSync(join(distDir, 'peer-credential-helper'), 0o755);

    const result = packageCliArchive({
      targetSpec: 'linux-x64',
      repositoryRoot: root,
      distDir,
      stageDir: join(root, 'cli-stage'),
      outputDir: join(root, 'cli-dist'),
    });

    assert.equal(result.archive, 'peer-linux-x64.tar.gz');
    assert.equal(result.folder, 'peer-linux-x64');
    assert.match(result.archivePath, /peer-linux-x64\.tar.gz$/);

    const tar = spawnSync('tar', ['-tzf', result.archivePath], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    assert.match(tar.stdout, /peer-linux-x64\/peer$/m);
    assert.match(tar.stdout, /peer-linux-x64\/peer-credential-helper$/m);
  });
});
