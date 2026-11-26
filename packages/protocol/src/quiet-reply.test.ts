import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isQuietReply, parseQuietReply, withoutGrowingQuietMarker } from './quiet-reply.ts';

test('quiet reply follows the shared 12-case Rust and TS contract', () => {
  const cases = JSON.parse(readFileSync(new URL('../contracts/native-cli/quiet-reply.json', import.meta.url), 'utf8')) as
    [string, boolean, boolean, string, string][];
  assert.equal(cases.length, 12);
  for (const [raw, isQuiet, isPureQuiet, leadingText, streaming] of cases) {
    assert.deepEqual(parseQuietReply(raw), { isQuiet, isPureQuiet, leadingText }, raw);
    assert.equal(isQuietReply(raw), isQuiet, raw);
    assert.equal(withoutGrowingQuietMarker(raw), streaming, raw);
  }
});
