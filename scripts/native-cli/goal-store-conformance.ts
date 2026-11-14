import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGoalPlanStore } from '../../packages/runtime-node/src/goal-plan-store.mjs';
import { projectTuiGoalFacts } from './goal-reference.ts';

const binary = resolve(process.argv[2] ?? 'target/debug/examples/goal-conformance');
const root = mkdtempSync(join(tmpdir(), 'peer-native-goal-store-'));
const fixture = JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/goal-execution-facts.json', import.meta.url), 'utf8'));
let checked = 0;
function setup(name: string) {
  const home = join(root, name); mkdirSync(join(home, 'goal-plans'), { recursive: true });
  writeFileSync(join(home, '.native-cli-fixture'), 'isolated synthetic data\n');
  return home;
}
function native(home: string, input: any = {}) {
  const run = spawnSync(binary, [], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent', PEER_NATIVE_CONFORMANCE_ROOT: home } });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
for (const [i, c] of fixture.cases.entries()) {
  const home = setup(String(i)); const storeDir = join(home, 'goal-plans');
  writeFileSync(join(storeDir, 'p.json'), JSON.stringify(c.raw));
  if (c.progress) { mkdirSync(join(storeDir, 'runner-progress')); writeFileSync(join(storeDir, 'runner-progress/p.json'), JSON.stringify(c.progress)); }
  const before = readFileSync(join(storeDir, 'p.json'));
  const actual = native(home, { now: c.now });
  assert.equal(actual.ok, true, c.name); assert.deepEqual(actual.facts, c.expected, c.name);
  assert.deepEqual(readFileSync(join(storeDir, 'p.json')), before);
  // Bind the fingerprint to both canonical sources, including an ignored older sidecar.
  if (c.progress) {
    writeFileSync(join(storeDir, 'runner-progress/p.json'), JSON.stringify({ ...c.progress, extra: 'revision changed' }));
    assert.notEqual(native(home, { now: c.now }).sourceRevision, actual.sourceRevision);
  }
  checked++;
}
const base = fixture.cases[0].raw;
const largeHome = setup('large');
const large = { ...base, tasks: [{ status: 'pending', description: 'x'.repeat(16 * 1024 * 1024) }], runner: { status: 'paused', updatedAt: fixture.cases[0].now, contextCheckpoint: { body: 'x'.repeat(16 * 1024 * 1024) } } };
writeFileSync(join(largeHome, 'goal-plans/p.json'), JSON.stringify(large));
const ts = createGoalPlanStore({ storeDir: join(largeHome, 'goal-plans') }).getPlan('p');
const actual = native(largeHome);
assert.equal(actual.ok, true); assert.deepEqual(actual.facts, projectTuiGoalFacts(ts, true));
assert.ok(actual.sourceBytes > 32 * 1024 * 1024); checked++;
for (const [name, contents, expected] of [
  ['missing-id', JSON.stringify({ ...base, planId: 'other' }), 'GOAL_SOURCE_INVALID'],
  ['truncated', '{"planId":"p","ignored":', 'GOAL_SOURCE_INVALID'],
  ['wrong-shape', JSON.stringify({ ...base, tasks: 'x'.repeat(5 * 1024 * 1024) }), 'GOAL_SOURCE_LIMIT'],
] as const) {
  const home = setup(name); writeFileSync(join(home, 'goal-plans/p.json'), contents);
  const before = readFileSync(join(home, 'goal-plans/p.json'));
  assert.equal(native(home).code, expected, name);
  assert.deepEqual(readFileSync(join(home, 'goal-plans/p.json')), before); checked++;
}
const badSidecar = setup('bad-sidecar'); writeFileSync(join(badSidecar, 'goal-plans/p.json'), JSON.stringify(base));
mkdirSync(join(badSidecar, 'goal-plans/runner-progress')); writeFileSync(join(badSidecar, 'goal-plans/runner-progress/p.json'), JSON.stringify({ planId: 'other', runner: {} }));
assert.equal(native(badSidecar).code, 'GOAL_SOURCE_INVALID'); checked++;
const linked = setup('symlink'); symlinkSync(join(largeHome, 'goal-plans/p.json'), join(linked, 'goal-plans/p.json'));
assert.equal(native(linked).ok, false); checked++;
assert.equal(native(setup('missing')).ok, false); checked++;
assert.equal(native(largeHome, { id: '../p' }).code, 'GOAL_SOURCE_INVALID'); checked++;
const selection = setup('active-selection'); const selectedDir = join(selection, 'goal-plans');
const plans = [
  { ...base, planId: 'old', updatedAt: '2026-11-12T00:00:00.000Z' },
  { ...base, planId: 'current', updatedAt: '2026-11-14T03:00:00.000Z' },
  { ...base, planId: 'terminal', status: 'completed', updatedAt: '2026-11-14T04:00:00.000Z' },
  { ...base, planId: 'other', conversationId: 'other', updatedAt: '2026-11-14T04:00:00.000Z' },
];
for (const p of plans) writeFileSync(join(selectedDir, `${p.planId}.json`), JSON.stringify(p));
writeFileSync(join(selectedDir, 'index.jsonl'), plans.map(p => JSON.stringify({ ...p, title: p.planId, workflowKind: 'goal_self_driven' })).join('\n') + '\n');
const selected = native(selection, { conversation: 'c' });
assert.equal(selected.ok, true);
const selectedTs = createGoalPlanStore({ storeDir: selectedDir }).getActivePlanByConversation('c');
assert.equal(selectedTs.planId, 'current'); assert.deepEqual(selected.facts, projectTuiGoalFacts(selectedTs)); checked++;
assert.equal(native(selection, { conversation: 'absent' }).facts, null); checked++;
writeFileSync(join(selectedDir, 'old.json'), JSON.stringify({ ...plans[0], status: 'paused', future: 'preserved' }));
assert.notEqual(native(selection, { conversation: 'c' }).sourceRevision, selected.sourceRevision); checked++;
writeFileSync(join(selectedDir, 'current.json'), '{');
assert.equal(native(selection, { conversation: 'c' }).code, 'GOAL_SOURCE_INVALID'); checked++;
assert.equal(native(setup('missing-index'), { conversation: 'c' }).ok, false); checked++;
console.log(`${checked} canonical Goal source, sidecar, bounded-body and fail-closed cases passed: ${root}`);
