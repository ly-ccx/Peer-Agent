import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_EXIT } from '../../apps/tui/src/cli-exit.ts';
import { resolvePeerDataHome } from '../../apps/tui/src/cli-data-home.ts';
import { digestApprovalArgs } from '../../packages/runtime-node/src/project-agent/permission-operation.mjs';

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
