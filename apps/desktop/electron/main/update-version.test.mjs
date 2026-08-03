import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compareVersions,
  isNewerVersion,
  isPrerelease,
} from './update-version.mjs';

describe('update-version semver helpers', () => {
  describe('compareVersions', () => {
    it('orders core versions numerically', () => {
      assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
      assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
      assert.equal(compareVersions('1.1.0', '1.0.9'), 1);
      assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
      assert.equal(compareVersions('0.0.9', '0.1.0'), -1);
    });

    it('treats missing minor/patch as zero', () => {
      assert.equal(compareVersions('1.0', '1.0.0'), 0);
      assert.equal(compareVersions('1', '1.0.0'), 0);
      assert.equal(compareVersions('1.1', '1.0.9'), 1);
    });

    it('accepts a leading v prefix', () => {
      assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
      assert.equal(compareVersions('V1.0.1', 'v1.0.0'), 1);
    });

    it('ignores build metadata', () => {
      assert.equal(compareVersions('1.0.0+build.1', '1.0.0'), 0);
      assert.equal(compareVersions('1.0.0-beta.1+b.2', '1.0.0-beta.1'), 0);
    });

    it('ranks release above prerelease with same core (semver §11)', () => {
      assert.equal(compareVersions('1.0.0', '1.0.0-beta.5'), 1);
      assert.equal(compareVersions('1.0.0-beta.5', '1.0.0'), -1);
      assert.equal(compareVersions('1.0.0', '1.0.0-alpha.1'), 1);
      assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
    });

    it('compares numeric prerelease identifiers numerically', () => {
      assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.9'), 1);
      assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
    });

    it('compares alphanumeric prerelease identifiers by precedence rules', () => {
      // numeric identifier < alphanumeric identifier
      assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
      // alphanumeric identifiers compare lexically
      assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
      assert.equal(compareVersions('1.0.0-beta', '1.0.0-alpha'), 1);
      // fewer fields < more fields when all preceding are equal
      assert.equal(compareVersions('1.0.0-beta', '1.0.0-beta.1'), -1);
    });

    it('throws on invalid versions', () => {
      assert.throws(() => compareVersions('not-a-version', '1.0.0'));
      assert.throws(() => compareVersions('1.0.0', ''));
      assert.throws(() => compareVersions('1.x.0', '1.0.0'));
      assert.throws(() => compareVersions('1.0.0-beta.01', '1.0.0'));
    });
  });

  describe('isNewerVersion — graduation signal (ADR-61)', () => {
    it('graduates: stable 1.0.0 is newer than installed 1.0.0-beta.5', () => {
      assert.equal(isNewerVersion('1.0.0', '1.0.0-beta.5'), true);
    });

    it('graduates: stable 1.1.0 is newer than installed 1.0.0-beta.3', () => {
      assert.equal(isNewerVersion('1.1.0', '1.0.0-beta.3'), true);
    });

    it('does not graduate: stable 1.0.0 is older than installed 1.1.0-beta.3', () => {
      assert.equal(isNewerVersion('1.0.0', '1.1.0-beta.3'), false);
    });

    it('does not graduate: same prerelease version is not strictly newer', () => {
      assert.equal(isNewerVersion('1.0.0-beta.5', '1.0.0-beta.5'), false);
    });

    it('graduates: next beta is newer than current beta', () => {
      assert.equal(isNewerVersion('1.0.0-beta.6', '1.0.0-beta.5'), true);
    });

    it('handles v-prefixed versions', () => {
      assert.equal(isNewerVersion('v1.0.0', 'v1.0.0-beta.5'), true);
      assert.equal(isNewerVersion('v0.9.9', 'v1.0.0-beta.5'), false);
    });
  });

  describe('isPrerelease', () => {
    it('detects prerelease suffixes', () => {
      assert.equal(isPrerelease('1.0.0-beta.5'), true);
      assert.equal(isPrerelease('1.0.0-alpha.1'), true);
      assert.equal(isPrerelease('1.0.0-rc.2'), true);
      assert.equal(isPrerelease('v1.0.0-beta.1'), true);
    });

    it('rejects stable versions', () => {
      assert.equal(isPrerelease('1.0.0'), false);
      assert.equal(isPrerelease('v1.2.3'), false);
      assert.equal(isPrerelease('1.0.0+build.5'), false);
    });

    it('returns false for unparseable input', () => {
      assert.equal(isPrerelease('nope'), false);
      assert.equal(isPrerelease(''), false);
    });
  });
});
