import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotProfile, ProjectModelPolicy } from '@peer-agent/protocol';
import { botModelPolicyKey, createBotDetailsReader, createBotModelState } from './botModelState.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const policy: ProjectModelPolicy = { overrides: { project_agent: { mode: 'fixed', modelProviderId: 'a', reasoningEffort: 'low' } } };
const next: ProjectModelPolicy = { overrides: { project_agent: { mode: 'fixed', modelProviderId: 'b', reasoningEffort: 'high' } } };
const profile = (modelPolicy: ProjectModelPolicy) => ({ workspaceId: 'bot-a', modelPolicy }) as BotProfile;
const details = { ok: true, modelOptions: [], modelViews: {} };
function fixture() {
  const read = deferred<typeof details>(), write = deferred<{ ok: boolean; profile?: BotProfile; code?: string }>();
  const busy: boolean[] = [], saved: BotProfile[] = [], errors: string[] = [], data: unknown[] = [];
  let writes = 0, reads = 0, current = policy;
  const state = createBotModelState({
    read: () => { reads++; return read.promise; },
    write: () => { writes++; return write.promise; }, policy: () => current,
    onProfile: value => { current = value.modelPolicy!; saved.push(value); },
    onData: value => data.push(value), onBusy: value => busy.push(value),
    onReadError: () => {}, onSaveError: value => errors.push(value),
  });
  return { state, read, write, busy, saved, errors, data, counts: () => ({ writes, reads }) };
}

test('list and controls share in-flight facts, but the next event always reads current facts', async () => {
  const pending = deferred<number>(); let calls = 0;
  const read = createBotDetailsReader(async () => { calls++; return pending.promise; });
  const list = read('a'), controls = read('a'), other = read('b');
  assert.equal(list, controls); assert.notEqual(other, controls);
  await Promise.resolve(); assert.equal(calls, 2);
  pending.resolve(1); await Promise.all([list, controls, other]);
  await read('a'); assert.equal(calls, 3);
});

test('a failed detail request can be retried and does not stay cached', async () => {
  let calls = 0;
  const read = createBotDetailsReader(async () => { if (++calls === 1) throw Error('unavailable'); return 2; });
  await assert.rejects(read('a'), /unavailable/);
  assert.equal(await read('a'), 2);
});

test('committed model releases the controls before a slow catalogue read finishes', async () => {
  const f = fixture();
  const saving = f.state.save(next);
  assert.deepEqual(f.busy, [true]); assert.deepEqual(f.saved, []);
  f.write.resolve({ ok: true, profile: profile(next) }); await saving;
  assert.deepEqual(f.busy, [true, false]);
  assert.deepEqual(f.saved, [profile(next)]); assert.deepEqual(f.data, []);
  assert.deepEqual(f.counts(), { writes: 1, reads: 1 });
  f.read.resolve(details); await f.state.refresh();
  assert.ok(f.data.length > 0); f.state.stop();
});

test('saving the same policy, including a reordered clone, never writes or refreshes', async () => {
  const f = fixture();
  const clone: ProjectModelPolicy = { overrides: { project_agent: { reasoningEffort: 'low', modelProviderId: 'a', mode: 'fixed' } } };
  assert.equal(botModelPolicyKey(clone), botModelPolicyKey(policy));
  await f.state.save(clone);
  assert.deepEqual(f.counts(), { writes: 0, reads: 0 }); assert.deepEqual(f.busy, []);
});

test('failed saves retain the committed profile and remain visible after a notification refresh', async () => {
  const f = fixture(); const saving = f.state.save(next);
  f.write.resolve({ ok: false, code: 'CONTROLLED_SAVE_FAILURE' }); await saving;
  f.read.resolve(details); await f.state.refresh();
  assert.deepEqual(f.saved, []); assert.deepEqual(f.busy, [true, false]);
  assert.equal(f.errors.at(-1), 'CONTROLLED_SAVE_FAILURE'); f.state.stop();
});

test('switching bots drops the old in-flight save and read results', async () => {
  const f = fixture(); const reading = f.state.refresh(), saving = f.state.save(next);
  f.state.stop(); f.write.resolve({ ok: true, profile: profile(next) }); f.read.resolve(details);
  await Promise.all([saving, reading]);
  assert.deepEqual(f.saved, []); assert.deepEqual(f.data, []); assert.deepEqual(f.busy, [true]);
});

test('another click during a pending write cannot start a competing policy save', async () => {
  const f = fixture(); const saving = f.state.save(next); await f.state.save(policy);
  assert.equal(f.counts().writes, 1);
  f.write.reject(Error('offline')); await saving;
  assert.equal(f.errors.at(-1), 'FAILED'); f.state.stop();
});
