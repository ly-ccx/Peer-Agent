import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GIT_BRANCH_PREFIX,
  readGitBranchPrefixFromSettings,
  resolveGitBranchPrefix,
} from './gitBranchPrefix.ts';

describe('resolveGitBranchPrefix', () => {
  it('falls back to default for null / undefined / non-string', () => {
    assert.equal(resolveGitBranchPrefix(null), DEFAULT_GIT_BRANCH_PREFIX);
    assert.equal(resolveGitBranchPrefix(undefined), DEFAULT_GIT_BRANCH_PREFIX);
    assert.equal(resolveGitBranchPrefix(42), DEFAULT_GIT_BRANCH_PREFIX);
    assert.equal(resolveGitBranchPrefix({}), DEFAULT_GIT_BRANCH_PREFIX);
  });

  it('falls back to default for empty or whitespace-only strings', () => {
    assert.equal(resolveGitBranchPrefix(''), DEFAULT_GIT_BRANCH_PREFIX);
    assert.equal(resolveGitBranchPrefix('   '), DEFAULT_GIT_BRANCH_PREFIX);
    assert.equal(resolveGitBranchPrefix('\t\n'), DEFAULT_GIT_BRANCH_PREFIX);
  });

  it('returns trimmed custom prefix', () => {
    assert.equal(resolveGitBranchPrefix('feature/'), 'feature/');
    assert.equal(resolveGitBranchPrefix('  acme/  '), 'acme/');
  });

  it('keeps explicit default value as-is after trim', () => {
    assert.equal(resolveGitBranchPrefix('PeerAgent/'), 'PeerAgent/');
    assert.equal(resolveGitBranchPrefix('  PeerAgent/  '), 'PeerAgent/');
  });
});

describe('readGitBranchPrefixFromSettings', () => {
  it('reads gitBranchPrefix and applies the same resolution', () => {
    assert.equal(readGitBranchPrefixFromSettings(null), DEFAULT_GIT_BRANCH_PREFIX);
    assert.equal(readGitBranchPrefixFromSettings({}), DEFAULT_GIT_BRANCH_PREFIX);
    assert.equal(
      readGitBranchPrefixFromSettings({ gitBranchPrefix: '' }),
      DEFAULT_GIT_BRANCH_PREFIX,
    );
    assert.equal(
      readGitBranchPrefixFromSettings({ gitBranchPrefix: '  team/' }),
      'team/',
    );
  });
});
