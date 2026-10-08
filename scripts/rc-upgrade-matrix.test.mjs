import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runUpgradeMatrix } from './rc-upgrade-matrix.mjs';

test('all real tagged upgrade, downgrade, recovery and updater matrix rows pass', { timeout: 60000 }, async () => {
  const report = await runUpgradeMatrix();
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(row => !row.ok)) + (report.setupError || ''));
  const candidate = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
  const published = execFileSync('git', ['tag', '--list', `v${candidate.split('-')[0]}-rc.*`], { encoding: 'utf8' })
    .trim().split('\n').filter(ref => /^v\d+\.\d+\.\d+-rc\.\d+$/.test(ref)).map(ref => ref.slice(1));
  const updaterRows = report.checks.filter(row => row.name.endsWith('auto -> GA stable updater graduation'));
  const expectedVersions = new Set([...Array.from({ length: 5 }, (_, i) => `0.1.0-beta.${i + 1}`), ...published, candidate]);
  assert.equal(report.checks.length, 13 + expectedVersions.size);
  assert.equal(report.tags.length, 6);
  assert.deepEqual(new Set(updaterRows.map(row => row.name.split(' ')[0])), expectedVersions);
  assert.equal(report.fixtureRemoved, true);
  assert.ok(report.tags.every(tag => /^[0-9a-f]{40}$/.test(tag.commit) && tag.sourceFiles.length >= 20 && tag.sourceFiles.every(file => /^[0-9a-f]{64}$/.test(file.sha256))));
  assert.equal(report.checks.filter(row => row.details?.realCrashRecovery).length, 4);
});
