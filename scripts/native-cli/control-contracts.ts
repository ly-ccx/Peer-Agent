import { readFileSync, writeFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { controlDigest, reduceSessionControl } from '../../packages/runtime-node/src/project-agent/session-control-kernel.mjs';

const at = '2026-11-14T00:00:00.000Z';
const execution = { planId: 'p', sessionId: 's', executionEpoch: 'epoch', generation: 'g', goalRevision: 2 };
function operation(id: string, kind = 'pause', patch: any = {}) {
  const value = { operationId: id, kind, workspaceId: 'w', parentConversationId: 'bot', sessionId: 's', planId: 'p', authorityRef: 'local:synthetic',
    expectedExecution: execution, phase: 'recorded', revision: 1, updatedAt: at, hostEpoch: 'host', hostPid: 101,
    recorder: { bootId: 'b', pid: 101, pidStart: 'start', hostId: 'h', acquiredAt: at }, unproven: false, ...patch };
  return { ...value, requestDigest: controlDigest({ kind: value.kind, operationId: value.operationId, authorityRef: value.authorityRef, execution: value.expectedExecution }) };
}
function receipt(id: string) { return { receiptId: `stop-${id}`, operationId: id, execution, admissionClosed: true, runnerIdle: true, schedulerIdle: true,
  resourceClaims: [{ claimId: 'claim', revision: 1 }], unknownCalls: ['original-unknown'], completedAt: at, scope: 'managed_execution' }; }
const cases: any[] = [];
function transition(name: string, state: any, op: any, expectedRevision: number, expectedCurrentOperationId: string | null = null, minimumExecutorVersion: any = 9) {
  const entry = { operation: op, expectedRevision, expectedCurrentOperationId, minimumExecutorVersion };
  const before = JSON.stringify(state);
  let expected: any;
  try { expected = { ok: true, state: reduceSessionControl(state, entry) }; }
  catch (error) { expected = { ok: false, code: (error as Error).message }; }
  assert.equal(JSON.stringify(state), before, 'TS kernel mutated its input');
  cases.push({ name, state, entry, expected }); return expected.state;
}
const empty = { unrelated: { evidence: ['preserved'], permission: 'unchanged' } };
const recorded = transition('recorded', empty, operation('a'), 0);
const draining = transition('draining', recorded, operation('a', 'pause', { phase: 'draining', revision: 2 }), 1);
const reconciling = transition('reconciling', draining, operation('a', 'pause', { phase: 'reconciling', revision: 3 }), 2);
const settled = transition('settled-with-unknown-preserved', reconciling, operation('a', 'pause', { phase: 'settled', revision: 4, outcome: 'applied', stopReceipt: receipt('a') }), 3);
const resumed = transition('resume-recorded', settled, operation('b', 'resume', { priorStopReceiptId: 'stop-a' }), 0, 'a');
const resumeDrain = transition('resume-draining', resumed, operation('b', 'resume', { priorStopReceiptId: 'stop-a', phase: 'draining', revision: 2 }), 1);
const resumeDone = transition('resume-applied-shape-only', resumeDrain, operation('b', 'resume', { priorStopReceiptId: 'stop-a', phase: 'settled', revision: 3, outcome: 'applied' }), 2);
const cancelled = transition('cancel-supersedes-draining', draining, operation('c', 'cancel'), 0, 'a');
transition('cancel-blocks-later-resume', cancelled, operation('later', 'resume'), 0, 'c');
transition('cancel-can-supersede-cancel', cancelled, operation('new-cancel', 'cancel'), 0, 'c');
transition('later-cancel-after-resume', resumeDone, operation('c', 'cancel'), 0, 'b');
transition('stale-revision', draining, operation('a', 'pause', { phase: 'reconciling', revision: 3 }), 1);
transition('illegal-phase-jump', recorded, operation('a', 'pause', { phase: 'reconciling', revision: 2 }), 1);
transition('unknown-executor', empty, operation('a'), 0, null, 8);
transition('executor-seven', empty, operation('a'), 0, null, 7);
transition('wrong-request-digest', empty, { ...operation('a'), requestDigest: 'bad' }, 0);
transition('missing-outcome', draining, operation('a', 'pause', { phase: 'settled', revision: 3 }), 2);
transition('missing-stop-receipt', draining, operation('a', 'pause', { phase: 'settled', revision: 3, outcome: 'applied' }), 2);
transition('falsey-stop-receipt', draining, operation('a', 'pause', { phase: 'settled', revision: 3, outcome: 'applied', stopReceipt: 0 }), 2);
transition('invalid-stop-barrier', draining, operation('a', 'pause', { phase: 'settled', revision: 3, outcome: 'applied', stopReceipt: { ...receipt('a'), runnerIdle: false } }), 2);
transition('duplicate-resource-claim', draining, operation('a', 'pause', { phase: 'settled', revision: 3, outcome: 'applied', stopReceipt: { ...receipt('a'), resourceClaims: [{ claimId: 'x', revision: 1 }, { claimId: 'x', revision: 2 }] } }), 2);
transition('unknown-call-shape', draining, operation('a', 'pause', { phase: 'settled', revision: 3, outcome: 'applied', stopReceipt: { ...receipt('a'), unknownCalls: [1] } }), 2);
transition('host-epoch-changed', draining, operation('a', 'pause', { phase: 'reconciling', revision: 3, hostEpoch: 'other' }), 2);
transition('execution-revision-changed', draining, operation('a', 'pause', { phase: 'reconciling', revision: 3, expectedExecution: { ...execution, goalRevision: 3 } }), 2);
transition('recorder-order-is-immutable', draining, operation('a', 'pause', { phase: 'reconciling', revision: 3, recorder: { acquiredAt: at, hostId: 'h', pidStart: 'start', pid: 101, bootId: 'b' } }), 2);
transition('unknown-operation-kind', empty, operation('a', 'future'), 0);
transition('old-record-cannot-change-settled-operation', settled, operation('a', 'pause', { phase: 'settled', revision: 5, outcome: 'applied', stopReceipt: receipt('a') }), 4);
transition('current-head-mismatch', { ...draining, sessionControlHeads: { s: { operationId: 'other' } } }, operation('a', 'pause', { phase: 'reconciling', revision: 3 }), 2);
transition('unknown-existing-control-preserved', { sessionControls: { a: 'unknown-record' } }, operation('a'), 0);
const digestInputs = [
  { z: 1, a: 2 }, { a: 2, z: 1 }, { '10': 'ten', '2': 'two', a: 'last', '01': 'not-index' },
  { '4294967295': 'not-index', '4294967294': 'index', z: 'after' },
  { kind: 'pause', operationId: 'a', authorityRef: 'local:synthetic', execution },
  { kind: 'pause', operationId: 'a', authorityRef: 'local:synthetic', execution: { goalRevision: 2, generation: 'g', executionEpoch: 'epoch', sessionId: 's', planId: 'p' } },
  { small: 1e-7, big: 1e21, zero: -0, control: '\0\n"\\', unicode: '中文😀' },
];
const value = { version: 1, digestCases: digestInputs.map(input => ({ input, expected: controlDigest(input) })), cases };
const path = fileURLToPath(new URL('../../packages/protocol/contracts/native-cli/control-v1.json', import.meta.url));
const encoded = `${JSON.stringify(value, null, 2)}\n`;
if (process.argv.includes('--write')) writeFileSync(path, encoded);
else { assert.equal(readFileSync(path, 'utf8'), encoded, 'TS control reducer contract drift'); process.stdout.write(`${cases.length} TS control transitions and ${digestInputs.length} JSON.stringify digests match.\n`); }
