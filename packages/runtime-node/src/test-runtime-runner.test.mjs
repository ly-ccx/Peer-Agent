import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('the package runner executes the isolated phase after a behavioral failure and retains either phase failure', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'peer-runtime-test-runner-'));
  try {
    for (const directory of ['scripts', 'src', 'src/sqlite', 'src/memory', 'src/project-agent',
      'src/project-agent/probes', 'src/testing', 'src/interactive-results']) mkdirSync(path.join(root, directory), { recursive: true });
    const runner = path.join(root, 'scripts/test-runtime.mjs');
    writeFileSync(runner, readFileSync(new URL('../scripts/test-runtime.mjs', import.meta.url)));
    for (const [ordinaryFails, benchmarkFails] of [[true, false], [false, true], [false, false]]) {
      const marker = path.join(root, `benchmark-${ordinaryFails}-${benchmarkFails}`);
      writeFileSync(path.join(root, 'src/behavior.test.mjs'), `import test from 'node:test';test('behavior',()=>{if(${ordinaryFails})throw new Error('fixture failure');});`);
      writeFileSync(path.join(root, 'src/project-agent/watch-reconcile-scale.test.mjs'),
        `import test from 'node:test';import {writeFileSync} from 'node:fs';test('benchmark',()=>{writeFileSync(${JSON.stringify(marker)},'ran');if(${benchmarkFails})throw new Error('fixture benchmark failure');});`);
      const env = { ...process.env };
      // This fixture starts an independent runner, not a recursive node:test
      // invocation inside the current worker (which Node intentionally skips).
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [runner], { cwd: root, env, timeout: 10000, encoding: 'utf8' });
      assert.equal(result.error, undefined);
      assert.equal(result.status, ordinaryFails || benchmarkFails ? 1 : 0, result.stdout + result.stderr);
      assert.equal(existsSync(marker), true, 'a failed behavioral phase must not hide an unrun benchmark');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
