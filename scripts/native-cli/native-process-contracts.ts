// Development oracle only; never executed by the native product.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { nativeProcessesInWork } from '../../packages/protocol/src/native-process.ts';
const execution = { planId: 'p', sessionId: 's', executionEpoch: 'epoch', generation: 'g', goalRevision: 2 };
const owner = { bootId: 'b', pid: 101, pidStart: 'start', hostId: 'host', acquiredAt: '2026-11-17T00:00:00.000Z' };
const childFact = { schemaVersion: 1, kind: 'command', handleId: 'git-h', toolCallId: 'call', dispatchId: 'dispatch', execution, generation: 0, state: 'not_started', owner };
const row = { toolCallId: 'call', dispatchId: 'dispatch', nativeRecorder: { schemaVersion: 1, runtime: 'peer-native', recorder: owner, execution }, nativeProcess: childFact, future: { keep: true } };
const work = { workId: 'native-child', state: 'running', budget: { attempts: { a: { pendingTools: [row] } }, uncertainDispatches: [] }, opaque: { evidence: ['unchanged'] } };
const cases: any[] = [];
function add(name: string, modify: (w: any, p: any) => void, count: number | null = 1) {
  // Canonical JSON has separate values, never JavaScript object aliases.
  const input = JSON.parse(JSON.stringify(work)); modify(input, input.budget.attempts.a.pendingTools[0].nativeProcess);
  const before = JSON.stringify(input);
  if (count === null) assert.throws(() => nativeProcessesInWork(input), /native_process_invalid/, name);
  else assert.equal(nativeProcessesInWork(input).length, count, name);
  assert.equal(JSON.stringify(input), before, 'shape validation must not mutate canonical facts');
  cases.push({ name, input, expected: count === null ? { ok: false, code: 'native_process_invalid' } : { ok: true, count } });
}
add('not-started', () => {});
add('starting', (_, p) => Object.assign(p, { state: 'starting', generation: 1 }));
add('running', (_, p) => Object.assign(p, { state: 'running', generation: 1, child: { ...owner, pid: 102, pidStart: 'child-start' } }));
add('owned-completion-no-child', (_, p) => Object.assign(p, { state: 'ended', stopObservation: 'owned_completion' }));
add('owner-dead-not-started', (_, p) => Object.assign(p, { state: 'ended', stopObservation: 'owner_dead_not_started' }));
add('owner-dead-group-absent', (_, p) => Object.assign(p, { state: 'ended', generation: 64, child: { ...owner, pid: 102 }, stopObservation: 'owner_dead_group_absent' }));
add('uncertain-row-retained', w => { w.budget.uncertainDispatches = w.budget.attempts.a.pendingTools; w.budget.attempts.a.pendingTools = []; });
add('opaque-owner-facts-retained', (_, p) => { p.owner.futureIdentity = { keep: true }; });
add('normalized-execution-order', (_, p) => { p.execution = { goalRevision: 2, generation: 'g', executionEpoch: 'epoch', sessionId: 's', planId: 'p' }; });
add('no-process-old-work', w => { delete w.budget.attempts.a.pendingTools[0].nativeProcess; }, 0);
for (const [name, modify] of [
  ['unknown-version', (_: any, p: any) => { p.schemaVersion = 2; }],
  ['unknown-kind', (_: any, p: any) => { p.kind = 'future'; }],
  ['unknown-field', (_: any, p: any) => { p.future = true; }],
  ['null-process', (w: any) => { w.budget.attempts.a.pendingTools[0].nativeProcess = null; }],
  ['bad-owner-pid', (_: any, p: any) => { p.owner.pid = 0; }],
  ['large-owner-pid', (_: any, p: any) => { p.owner.pid = 2147483648; }],
  ['empty-owner-boot', (_: any, p: any) => { p.owner.bootId = ''; }],
  ['changed-owner', (w: any) => { w.budget.attempts.a.pendingTools[0].nativeRecorder.recorder.hostId = 'other'; }],
  ['changed-execution', (_: any, p: any) => { p.execution.goalRevision = 3; }],
  ['missing-recorded-execution', (w: any) => { delete w.budget.attempts.a.pendingTools[0].nativeRecorder.execution; }],
  ['changed-call', (_: any, p: any) => { p.toolCallId = 'other'; }],
  ['changed-dispatch', (_: any, p: any) => { p.dispatchId = 'other'; }],
  ['empty-handle', (_: any, p: any) => { p.handleId = ''; }],
  ['byte-limit-handle', (_: any, p: any) => { p.handleId = '🦀'.repeat(51); }],
  ['generation-negative', (_: any, p: any) => { p.generation = -1; }],
  ['generation-fraction', (_: any, p: any) => { p.generation = .5; }],
  ['generation-limit', (_: any, p: any) => { p.generation = 65; }],
  ['not-started-positive-generation', (_: any, p: any) => { p.generation = 1; }],
  ['starting-zero-generation', (_: any, p: any) => { p.state = 'starting'; }],
  ['running-no-child', (_: any, p: any) => { p.state = 'running'; p.generation = 1; }],
  ['running-wrong-child-boot', (_: any, p: any) => Object.assign(p, { state: 'running', generation: 1, child: { ...owner, pid: 102, bootId: 'other' } })],
  ['running-with-stop', (_: any, p: any) => Object.assign(p, { state: 'running', generation: 1, child: { ...owner, pid: 102 }, stopObservation: 'owned_completion' })],
  ['ended-no-stop', (_: any, p: any) => { p.state = 'ended'; }],
  ['ended-unknown-stop', (_: any, p: any) => Object.assign(p, { state: 'ended', stopObservation: 'guessed' })],
  ['not-started-stop-after-launch', (_: any, p: any) => Object.assign(p, { state: 'ended', generation: 1, stopObservation: 'owner_dead_not_started' })],
  ['group-absent-no-child', (_: any, p: any) => Object.assign(p, { state: 'ended', generation: 1, stopObservation: 'owner_dead_group_absent' })],
  ['duplicate-across-pending-unknown', (w: any) => { w.budget.uncertainDispatches.push(structuredClone(w.budget.attempts.a.pendingTools[0])); }],
] as const) add(name, modify, null);
const file = new URL('../../packages/protocol/contracts/native-cli/native-process.json', import.meta.url);
const encoded = JSON.stringify({ version: 1, semanticFloor: 13, cases }, null, 2) + '\n';
if (process.argv.includes('--write')) writeFileSync(file, encoded);
else assert.equal(readFileSync(file, 'utf8'), encoded, 'native child TS/Rust fixture drift');
console.log(`${cases.length} native process shape vectors match the TypeScript oracle.`);
