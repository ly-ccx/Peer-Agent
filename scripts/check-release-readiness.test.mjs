import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./check-release-readiness.mjs', import.meta.url);

function run(env) {
  return spawnSync(process.execPath, [script.pathname], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('release readiness fails closed when the tag differs from VERSION', () => {
  const result = run({ RELEASE_TAG: 'v999.0.0' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RELEASE_TAG v999\.0\.0 does not match VERSION/);
});
