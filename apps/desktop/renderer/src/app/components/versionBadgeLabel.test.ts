import assert from 'node:assert/strict';
import test from 'node:test';
import { versionBadgeLabel } from './versionBadgeLabel.ts';

test('candidate labels retain the exact release stage and sequence', () => {
  assert.deepEqual(versionBadgeLabel('0.1.0-rc.5'), { version: 'v0.1.0', stage: 'RC 5' });
  assert.deepEqual(versionBadgeLabel('0.1.0-beta.12'), { version: 'v0.1.0', stage: 'BETA 12' });
  assert.deepEqual(versionBadgeLabel('2.0.0-alpha.1'), { version: 'v2.0.0', stage: 'ALPHA 1' });
});

test('stable, custom and metadata-bearing versions retain their complete identity', () => {
  for (const version of ['0.1.0', '0.1.0-preview.5', '0.1.0-rc.5+local', 'custom-dev']) {
    assert.deepEqual(versionBadgeLabel(version), { version: `v${version}` });
  }
});
