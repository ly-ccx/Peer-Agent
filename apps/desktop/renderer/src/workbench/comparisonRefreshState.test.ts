import assert from 'node:assert/strict';
import test from 'node:test';
import { createComparisonRefreshReader } from './comparisonRefreshState.ts';

type Result = Awaited<ReturnType<Parameters<typeof createComparisonRefreshReader>[0]>>;
const value = (body: string): Result => ({ ok: true, status: 'ok', diffText: body, workspaceRoot: '/synthetic/repo', fromRef: 'a'.repeat(40) });
test('automatic observations preserve accepted reading until the user adopts a confirmed candidate', async () => {
  let current = value('old'); const reader = createComparisonRefreshReader(async () => current);
  await reader.reload(); const accepted = reader.snapshot().value;
  await reader.observe(); assert.equal(reader.snapshot().candidate, null);
  current = value('new'); await reader.observe(); assert.equal(reader.snapshot().value, accepted); assert.equal(reader.snapshot().candidate, current);
  reader.adopt(); assert.equal(reader.snapshot().value, current); assert.equal(reader.snapshot().candidate, null);
});
test('failed refresh and changed source never replace the accepted comparison or leave an adoptable candidate', async () => {
  let current = value('old'); const reader = createComparisonRefreshReader(async () => current); await reader.reload(); const accepted = reader.snapshot().value;
  current = { ...value('new'), workspaceRoot: '/other/repo' }; await reader.observe(); reader.adopt();
  assert.equal(reader.snapshot().value, accepted); assert.equal(reader.snapshot().error, true); assert.equal(reader.snapshot().candidate, null);
  current = { ok: false, status: 'error', diffText: '', error: 'permission_denied' }; await reader.reload();
  assert.equal(reader.snapshot().value, accepted); assert.equal(reader.snapshot().failure?.error, 'permission_denied');
});
test('one in-flight read per active generation; cancellation retires late results and skips not-yet-started reads', async () => {
  let finish!: (result: Result) => void, reads = 0;
  const reader = createComparisonRefreshReader(() => { reads++; return new Promise(done => { finish = done; }); });
  const first = reader.reload(); assert.equal(reader.observe(), first); await Promise.resolve(); assert.equal(reads, 1);
  reader.cancel(); finish(value('late')); await first; assert.equal(reader.snapshot().value, null);
  const cancelledBeforeStart = reader.reload(); reader.cancel(); await cancelledBeforeStart; assert.equal(reads, 1);
  const next = reader.reload(); await Promise.resolve(); finish(value('current')); await next; assert.equal(reader.snapshot().value?.diffText, 'current');
});
test('a newer failed observation invalidates a candidate instead of applying an older observation', async () => {
  let current = value('old'); const reader = createComparisonRefreshReader(async () => current); await reader.reload();
  current = value('candidate'); await reader.observe();
  current = { ok: false, status: 'error', diffText: '', error: 'scope_denied' }; await reader.observe(); reader.adopt();
  assert.equal(reader.snapshot().value?.diffText, 'old'); assert.equal(reader.snapshot().candidate, null);
});


test('an unconfirmed successful result without its repository cannot become an accepted comparison', async () => {
  const reader = createComparisonRefreshReader(async () => ({ ok: true, status: 'ok', diffText: 'unbound' }));
  await reader.reload(); assert.equal(reader.snapshot().value, null); assert.equal(reader.snapshot().error, true);
});
