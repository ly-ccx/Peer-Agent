import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { findBinaries, installBinary } from '../lib/install-binary.mjs';
import { helperBinaryPath, peerBinaryPath, vendorDir } from '../lib/paths.mjs';

describe('findBinaries', () => {
  it('finds peer + helper in a nested archive layout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peer-find-'));
    const nested = join(dir, 'peer-darwin-arm64');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'peer'), '#!/bin/sh\necho peer\n');
    writeFileSync(join(nested, 'peer-credential-helper'), '#!/bin/sh\necho helper\n');
    const found = findBinaries(dir);
    assert.ok(found.peer?.endsWith('/peer'));
    assert.ok(found.helper?.endsWith('/peer-credential-helper'));
  });
});

describe('installBinary', () => {
  const roots = [];
  after(() => {
    // temp dirs cleaned by OS; keep test simple
  });

  it('skips download when PEER_AGENT_SKIP_DOWNLOAD is set via options', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peer-install-'));
    roots.push(root);
    const result = await installBinary({
      version: '0.0.1-beta.38',
      root,
      skipDownload: true,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'skip-download');
  });

  it('downloads and extracts a mocked tar.gz archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peer-install-'));
    roots.push(root);
    const archiveDir = mkdtempSync(join(tmpdir(), 'peer-archive-'));
    const nested = join(archiveDir, 'peer-darwin-arm64');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'peer'), '#!/bin/sh\necho peer-bin\n');
    writeFileSync(join(nested, 'peer-credential-helper'), '#!/bin/sh\necho helper-bin\n');
    chmodSync(join(nested, 'peer'), 0o755);
    chmodSync(join(nested, 'peer-credential-helper'), 0o755);
    const tarPath = join(archiveDir, 'peer-darwin-arm64.tar.gz');
    const tar = spawnSync('tar', ['-czf', tarPath, '-C', archiveDir, 'peer-darwin-arm64'], {
      encoding: 'utf8',
    });
    assert.equal(tar.status, 0, tar.stderr);

    const archiveBytes = readFileSync(tarPath);
    const fetchImpl = async () =>
      new Response(archiveBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/gzip' },
      });

    const result = await installBinary({
      version: '0.0.1-beta.38',
      root,
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl,
      force: true,
      log: () => {},
    });

    assert.equal(result.skipped, false);
    assert.ok(existsSync(peerBinaryPath(root)));
    assert.ok(existsSync(helperBinaryPath(root)));
    assert.equal(
      readFileSync(join(vendorDir(root), '.peer-agent-version'), 'utf8').trim(),
      '0.0.1-beta.38',
    );

    // second install with same version should skip
    const again = await installBinary({
      version: '0.0.1-beta.38',
      root,
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: async () => {
        throw new Error('should not fetch again');
      },
      log: () => {},
    });
    assert.equal(again.skipped, true);
    assert.equal(again.reason, 'already-installed');
  });

  it('fails clearly for unsupported but known platforms', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peer-install-'));
    roots.push(root);
    await assert.rejects(
      () =>
        installBinary({
          version: '0.0.1-beta.38',
          root,
          platform: 'win32',
          arch: 'x64',
          log: () => {},
        }),
      /not yet published/,
    );
  });
});
