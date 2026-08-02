import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const governanceScript = new URL('./check-architecture-governance.mjs', import.meta.url);

test('architecture governance gate passes for the repository', () => {
  const result = spawnSync(process.execPath, [governanceScript.pathname, 'desktop-main'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Architecture governance check passed\./);
});
