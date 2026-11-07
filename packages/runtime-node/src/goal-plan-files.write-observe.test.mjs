import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setJsonWriteObserver, writeJsonAtomic } from './goal-plan-files.mjs';

test('each plan write reports the serialized byte count, including a multi-megabyte body', () => {
  const secret = 'super-secret-plan-body';
  const seen = [];
  const previous = setJsonWriteObserver((sample) => seen.push({ ...sample }));
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-write-'));
  const file = path.join(dir, 'plan.json');
  const expectWrite = (obj) => {
    const expected = Buffer.byteLength(JSON.stringify(obj, null, 2));
    const before = seen.length;
    writeJsonAtomic(file, obj);
    const rows = seen.slice(before);
    assert.deepEqual(rows.map((sample) => sample.phase), ['stringify', 'write']);
    assert.equal(rows[0].bytes, expected);
    assert.equal(rows[1].bytes, expected);
    assert.equal(statSync(file).size, expected);
    assert.ok(rows.every((sample) => Number.isFinite(sample.ms) && sample.ms >= 0 && sample.ms < 60_000));
    assert.equal(JSON.stringify(rows).includes(secret), false);
    return expected;
  };
  try {
    const small = expectWrite({ goal: secret, tasks: [{ title: 'keep' }] });
    assert.ok(small < 1000);
    const large = expectWrite({ goal: secret, blob: 'x'.repeat(2_000_000) });
    assert.ok(large > 2_000_000);
    assert.equal(readFileSync(file, 'utf8').includes(secret), true);
  } finally {
    setJsonWriteObserver(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
