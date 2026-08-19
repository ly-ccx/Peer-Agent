import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listKnownTargets, releaseAssetUrl, resolvePlatformTarget } from '../lib/platform.mjs';

describe('resolvePlatformTarget', () => {
  it('maps darwin arm64 to the first-class archive', () => {
    const target = resolvePlatformTarget('darwin', 'arm64');
    assert.ok(target);
    assert.equal(target.archive, 'peer-darwin-arm64.tar.gz');
    assert.equal(target.supported, true);
  });

  it('maps linux x64 to the first-class archive', () => {
    const target = resolvePlatformTarget('linux', 'x64');
    assert.ok(target);
    assert.equal(target.archive, 'peer-linux-x64.tar.gz');
    assert.equal(target.supported, true);
  });

  it('returns null for unknown platform', () => {
    assert.equal(resolvePlatformTarget('aix', 'ppc64'), null);
  });

  it('marks windows as recognized but not yet supported', () => {
    const target = resolvePlatformTarget('win32', 'x64');
    assert.ok(target);
    assert.equal(target.supported, false);
    assert.equal(target.archive, 'peer-win32-x64.zip');
  });
});

describe('releaseAssetUrl', () => {
  it('builds the GitHub release download URL without double v', () => {
    const target = resolvePlatformTarget('darwin', 'arm64');
    assert.ok(target);
    assert.equal(
      releaseAssetUrl('0.0.1-beta.38', target, {
        owner: 'ly-ccx',
        repo: 'Peer-Agent',
      }),
      'https://github.com/ly-ccx/Peer-Agent/releases/download/v0.0.1-beta.38/peer-darwin-arm64.tar.gz',
    );
  });

  it('accepts a tag that already has v', () => {
    const target = resolvePlatformTarget('darwin', 'arm64');
    assert.ok(target);
    assert.match(releaseAssetUrl('v1.2.3', target), /\/v1\.2\.3\//);
  });
});

describe('listKnownTargets', () => {
  it('includes first-class darwin-arm64 and linux-x64 archives', () => {
    const archives = listKnownTargets().map((t) => t.archive);
    assert.ok(archives.includes('peer-darwin-arm64.tar.gz'));
    assert.ok(archives.includes('peer-linux-x64.tar.gz'));
  });
});
