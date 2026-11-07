import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setJsonWriteObserver, writeJsonAtomic } from './goal-plan-files.mjs';

test('plan body writes still persist while the observer sees only phase, time, and bytes', () => {
  const secret = 'super-secret-plan-body';
  const seen = [];
  const previous = setJsonWriteObserver((sample) => seen.push(sample));
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-write-'));
  const file = path.join(dir, 'plan.json');
  try {
    writeJsonAtomic(file, { goal: secret, tasks: [{ title: 'keep' }] });
    assert.deepEqual(seen.map((sample) => sample.phase), ['stringify', 'write']);
    assert.equal(JSON.stringify(seen).includes(secret), false);
    assert.ok(seen.every((sample) => sample.bytes > 0 && sample.ms >= 0));
    assert.equal(readFileSync(file, 'utf8').includes(secret), true);
  } finally {
    setJsonWriteObserver(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
