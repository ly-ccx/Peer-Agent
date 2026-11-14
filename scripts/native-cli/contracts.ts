import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_EXIT } from '../../apps/tui/src/cli-exit.ts';
import { resolvePeerDataHome } from '../../apps/tui/src/cli-data-home.ts';
import { digestApprovalArgs } from '../../packages/runtime-node/src/project-agent/permission-operation.mjs';
import { normalizeSessionExecutionIdentity, normalizeExecutionResourceScope } from '../../packages/protocol/src/session-control.ts';
import { collectToolEvidenceRefs } from '../../packages/runtime-core/src/evidence.ts';
import { resolvePermissionPrincipal, permissionOperationKey } from '../../packages/runtime-node/src/project-agent/permission-inheritance.mjs';
import { createOneTimeApprovalBook } from '../../packages/runtime-node/src/project-agent/one-time-approval.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const path = resolve(root, 'packages/protocol/contracts/native-cli/v1.json');
const inputs = [
  ['null', null], ['unordered', { z: 1, a: ['中文', true, null] }],
  ['unicode-key-order', { '\ue000': 'bmp', '𐀀': 'surrogate', a: 'normal' }],
  ['json-number-format', { small: 1e-7, boundary: 1e-6, big: 1e21, zero: -0, decimal: 1.25 }],
  ['operation-identity', { capabilityId: 'local.file.write', args: { path: '../other/file', content: 'a\nb\t"c"' }, conversationId: 'c', workspacePath: '/fixture', sessionId: 's', planId: null }],
] as const;
const dataHomeCases = [
  { env: { PEER_AGENT_HOME: '/fixture/custom', PEER_USER_DATA_PATH: '/fixture/legacy' }, expected: '/fixture/custom' },
  { env: { PEER_AGENT_HOME: ' ', PEER_USER_DATA_PATH: ' /fixture/legacy ' }, expected: '/fixture/legacy' },
  { env: { PEER_AGENT_HOME: '\ufeff/fixture/custom\ufeff' }, expected: '/fixture/custom' },
  { env: { PEER_AGENT_HOME: '/fixture/nel\u0085' }, expected: '/fixture/nel\u0085' },
].map(input => ({ ...input, home: '/fixture/home' }));
for (const input of dataHomeCases) {
  const actual = resolvePeerDataHome(input.env);
  if (actual !== input.expected) throw Error(`TS data home disagrees: ${actual}`);
}
const contract = {
  version: 1,
  governance: 'ADR 129–131 (review drafts 116–118)',
  exitCodes: CLI_EXIT,
  dataHomeCases,
  approvalDigestCases: inputs.map(([name, input]) => ({ name, input, expected: digestApprovalArgs(input) })),
  admission: { maxDigestBytes: 1048576, maxJsonDepth: 64, maxSafeInteger: 9007199254740991 },
};
const encoded = `${JSON.stringify(contract, null, 2)}\n`;
if (process.argv.includes('--write')) writeFileSync(path, encoded);
else if (readFileSync(path, 'utf8') !== encoded) throw Error('Native contract resources drifted from the real TypeScript interfaces; review then regenerate.');
else process.stdout.write('TS exit codes, data root and approval digest fixtures match.\n');

const baseIdentity = { planId: 'p', sessionId: 's', executionEpoch: 'host:epoch' };
const identityInputs = [baseIdentity, { ...baseIdentity, goalRevision: 0, generation: 'generation-1' },
  { ...baseIdentity, goalRevision: 1.5 }, { ...baseIdentity, goalRevision: 9007199254740992 },
  { ...baseIdentity, goalRevision: null }, { ...baseIdentity, generation: null }, { ...baseIdentity, future: true },
  { ...baseIdentity, planId: '../p' }, { ...baseIdentity, sessionId: '' }, { ...baseIdentity, executionEpoch: 'x\n' },
  { ...baseIdentity, executionEpoch: '😀'.repeat(256) }, { ...baseIdentity, executionEpoch: '😀'.repeat(257) }, null, [], {}];
const scopeInputs = [{ kind: 'directory', path: '/fixture' }, { kind: 'file', path: '😀'.repeat(1024) },
  { kind: 'file', path: '😀'.repeat(1025) }, { kind: 'file', path: 'x\u0000' }, { kind: 'file', path: '/x', extra: true },
  { kind: 'git_ref', ref: 'refs/heads/topic' }, { kind: 'git_ref', ref: 'refs/../main' },
  { kind: 'remote_object', ref: 'repo:pr/1' }, { kind: 'remote_object', ref: '#unsafe' }, { kind: 'future', ref: 'x' }, null];
const evidenceInputs = [
  { toolCallId: ' call ', execution: { result: { evidence: { refs: ['first', 'same', '', null], artifactRefs: ['same', 'second'] }, outputPreview: { artifactRef: 'third', artifactRefs: ['first', 1], localToolResultRef: { artifactRefs: ['fourth'] }, text: 'artifact://spoof' } } } },
  { toolCallId: '\ufeffcall\ufeff', execution: { result: { evidence: { refs: ['\ufefftrim\ufeff', '\u0085preserve\u0085'] } } } },
  { toolCallId: '', execution: { result: { output: { artifactRef: 'spoof' }, outputPreview: 'artifact://spoof' } } },
  { toolCallId: 'call', execution: { result: { evidence: { refs: 'tool-result://call' }, outputPreview: { localToolResultRef: { artifactRef: 'last' } } } } },
];
const plan = (conversationId: string, parent?: string, extra = {}) => ({ status: 'running', conversationId,
  ...(parent ? { delegationOrigin: { workspaceId: 'w', sessionId: conversationId, parentConversationId: parent } } : {}), ...extra });
const principalInputs = [
  { query: { workspaceId: ' w ', conversationId: '\ufeffbot\ufeff' }, plans: {} },
  { query: { conversationId: '' }, plans: {} },
  { query: { workspaceId: 'w', conversationId: 'goal', planId: 'p' }, plans: { p: plan('goal') } },
  { query: { workspaceId: 'w', conversationId: 'other', planId: 'p' }, plans: { p: plan('goal') } },
  { query: { workspaceId: 'w', conversationId: 'leaf', sessionId: 'leaf', planId: 'p' }, plans: { p: plan('leaf', 'parent'), a: plan('parent', 'bot') } },
  { query: { workspaceId: 'w', sessionId: 'leaf', planId: 'p' }, plans: { p: plan('leaf', 'bot') } },
  { query: { workspaceId: 'w', conversationId: 'leaf', sessionId: 'wrong', planId: 'p' }, plans: { p: plan('leaf', 'bot') } },
  { query: { workspaceId: 'w', conversationId: 'leaf', sessionId: 'leaf', planId: 'p' }, plans: { p: plan('leaf', 'parent'), a: plan('parent', 'bot', { status: 'paused' }) } },
  { query: { workspaceId: 'w', conversationId: 'leaf', sessionId: 'leaf', planId: 'p' }, plans: { p: plan('leaf', 'leaf') } },
  { query: { workspaceId: 'w', conversationId: 'leaf', sessionId: 'leaf', planId: 'missing' }, plans: {} },
  { query: { workspaceId: 'w', conversationId: 'goal', planId: 'p' }, plans: { p: plan('goal', undefined, { status: 'cancelled' }) } },
];
const principalCases = principalInputs.map(({ query, plans }) => {
  const entries = Object.entries(plans) as [string, any][];
  const goalPlanStore = { getPlan: (id: string) => (plans as any)[id], getActivePlanByConversation: (id: string) => entries.find(([, p]) => p.conversationId === id)?.[1] };
  // This is the Host plan projection input, not authority obtained by decoding JSON.
  const hostFacts = Object.fromEntries(entries.map(([id, p]) => [id, { conversationId: p.conversationId,
    inheritanceStopped: ['cancelled', 'paused', 'interrupted'].includes(p.status)
      || ['cancelled', 'paused', 'superseded'].includes(p.delegationOrigin?.phase) || Boolean(p.delegationOrigin?.supersededBy || p.delegationOrigin?.cancellation),
    delegation: p.delegationOrigin ? { workspaceId: p.delegationOrigin.workspaceId, sessionId: p.delegationOrigin.sessionId, parentConversationId: p.delegationOrigin.parentConversationId } : null }]));
  return { query, hostFacts, expected: resolvePermissionPrincipal({ ...query, goalPlanStore }) };
});
const common = { capabilityId: 'local.file.read', argsDigest: 'a'.repeat(64), sessionId: 's', workspaceId: 'w', policyRevision: 'bot:w:bot:1' };
const approvalSteps = [
  { op: 'remember', input: { ...common, at: 0 } },
  { op: 'match', input: { ...common, workspaceId: 'other', at: 1 } },
  { op: 'match', input: { ...common, policyRevision: 'bot:w:bot:2', at: 1 } },
  { op: 'match', input: { ...common, at: 1 } }, { op: 'match', input: { ...common, at: 1 } },
  { op: 'remember', input: { ...common, at: 1000 } }, { op: 'match', input: { ...common, at: 1_801_000 } },
  { op: 'remember', input: { ...common, argsDigest: 'bad', at: 1_801_001 } },
];
const book = createOneTimeApprovalBook();
const runtimeContract = { version: 1,
  identityCases: identityInputs.map(input => ({ input, expected: normalizeSessionExecutionIdentity(input) ?? null })),
  resourceScopeCases: scopeInputs.map(input => ({ input, expected: normalizeExecutionResourceScope(input) ?? null })),
  evidenceCases: evidenceInputs.map(input => ({ input, expected: collectToolEvidenceRefs(input) })), principalCases,
  operationCases: [ { capabilityId: 'local.file.read', args: { path: '中文\n\u0000' } },
    { capabilityId: 'local.shell.exec', args: { command: 'echo synthetic' }, workspacePath: '/fixture', conversationId: 'c', planId: 'p', sessionId: 's' } ]
    .map(input => ({ input, expected: permissionOperationKey(input) })),
  approvalSteps: approvalSteps.map(step => ({ ...step, expected: step.op === 'remember' ? book.remember(step.input) : book.match(step.input) })),
};
const runtimePath = resolve(root, 'packages/protocol/contracts/native-cli/runtime-v1.json');
const runtimeEncoded = `${JSON.stringify(runtimeContract, null, 2)}\n`;
if (process.argv.includes('--write')) writeFileSync(runtimePath, runtimeEncoded);
else if (readFileSync(runtimePath, 'utf8') !== runtimeEncoded) throw Error('Runtime identity / principal / approval / Evidence contract drifted.');
else process.stdout.write('TS execution identity, resource scope, principal, operation, one-time approval and Evidence fixtures match.\n');
