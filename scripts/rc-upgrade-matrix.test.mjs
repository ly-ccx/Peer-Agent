import test from 'node:test';
import assert from 'node:assert/strict';
import { runUpgradeMatrix } from './rc-upgrade-matrix.mjs';

test('all real tagged upgrade, downgrade, recovery and updater matrix rows pass', { timeout: 60000 }, async () => {
  const report = await runUpgradeMatrix();
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(row => !row.ok)) + (report.setupError || ''));
  assert.equal(report.checks.length, 23);
  assert.equal(report.tags.length, 6);
  assert.deepEqual(report.checks.filter(row => row.name.endsWith('auto -> GA stable updater graduation')).map(row => row.name.split(' ')[0]), ['0.1.0-beta.1', '0.1.0-beta.2', '0.1.0-beta.3', '0.1.0-beta.4', '0.1.0-beta.5', '0.1.0-rc.1', '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.4', '0.1.0-rc.5']);
  assert.equal(report.fixtureRemoved, true);
  assert.ok(report.tags.every(tag => /^[0-9a-f]{40}$/.test(tag.commit) && tag.sourceFiles.length >= 20 && tag.sourceFiles.every(file => /^[0-9a-f]{64}$/.test(file.sha256))));
  assert.equal(report.checks.filter(row => row.details?.realCrashRecovery).length, 4);
});
