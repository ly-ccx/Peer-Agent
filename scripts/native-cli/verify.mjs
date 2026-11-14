#!/usr/bin/env node
// Development verification uses TS as the conformance reference. The built
// peer-native executable does not spawn this script, Node, or Bun.
import { execFileSync } from 'node:child_process';
import { existsSync,mkdirSync,mkdtempSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'peer-native-check-'));
const run = (command, args,extraEnv) => execFileSync(command, args, { cwd: root, stdio: 'inherit',env:extraEnv?{...process.env,...extraEnv}:process.env });
const episodes=join(output,'episodes');mkdirSync(episodes,{recursive:true});writeFileSync(join(episodes,'.native-cli-fixture'),'isolated');
if(!existsSync(join(root,'packages/runtime-core/dist/index.js')))run('pnpm',['--filter','@peer-agent/runtime-core','build']);
run('bun', ['scripts/native-cli/contracts.ts']);
run('bun', ['scripts/native-cli/control-contracts.ts']);
run('bun', ['scripts/native-cli/work-contracts.ts']);
run('bun', ['scripts/native-cli/kernel-contracts.ts']);
run('bun', ['scripts/native-cli/goal-contracts.ts']);
run('bun', ['scripts/native-cli/admission-contracts.ts']);
run('bun', ['scripts/native-cli/history-plan-contracts.ts']);
run('bun', ['scripts/native-cli/access-policy-contracts.ts']);
run('bun', ['scripts/native-cli/context-contracts.ts']);
run('node', ['scripts/native-cli/check-boundaries.mjs']);
run('cargo', ['fmt', '--all', '--check']);
run('cargo', ['clippy', '--locked', '-p', 'peer-cli', '-p', 'peer-protocol', '-p', 'peer-tui', '-p', 'peer-store', '-p', 'peer-runtime', '--all-targets', '--features', 'peer-cli/test-fixtures,peer-store/test-fixtures', '--', '-D', 'warnings']);
run('cargo', ['test', '--locked', '--workspace', '--all-targets', '--features', 'peer-cli/test-fixtures,peer-store/test-fixtures'],{PEER_NATIVE_P3_EVIDENCE_ROOT:episodes});
run('bun',['scripts/native-cli/episode-conformance.ts',episodes]);
run('cargo', ['build', '--release', '--locked', '-p', 'peer-cli', '--bins', '--examples']);
run('cargo', ['build', '--locked', '-p', 'peer-store', '--example', 'conformance']);
run('bun', ['scripts/native-cli/store-conformance.ts', 'target/debug/examples/conformance']);
run('bun', ['scripts/native-cli/policy-initialization.ts', 'target/debug/examples/conformance']);
run('cargo', ['build', '--locked', '-p', 'peer-store', '--example', 'lease-conformance']);
run('bun', ['scripts/native-cli/lease-conformance.ts', 'target/debug/examples/lease-conformance']);
run('cargo', ['build', '--locked', '-p', 'peer-store', '--example', 'transcript-conformance']);
run('bun', ['scripts/native-cli/transcript-conformance.ts', 'target/debug/examples/transcript-conformance']);
run('cargo', ['build', '--locked', '-p', 'peer-store', '--features', 'test-fixtures', '--example', 'fence-conformance']);
run('bun', ['scripts/native-cli/fence-conformance.ts', 'target/debug/examples/fence-conformance']);
run('cargo', ['build', '--locked', '-p', 'peer-store', '--features', 'test-fixtures', '--example', 'resource-conformance']);
run('bun', ['scripts/native-cli/resource-conformance.ts', 'target/debug/examples/resource-conformance']);
run('node', ['--test', 'packages/runtime-node/src/project-agent/execution-resources.test.mjs']);
run('cargo', ['build', '--locked', '-p', 'peer-store', '--features', 'test-fixtures', '--example', 'durable-conformance']);
run('bun', ['scripts/native-cli/durable-conformance.ts', 'target/debug/examples/durable-conformance']);
run('node', ['--test', 'packages/runtime-node/src/project-agent/approval-store.test.mjs']);
run('node', ['--test', 'packages/runtime-node/src/goal-plan-evidence.native-lock.test.mjs', 'packages/runtime-node/src/goal-plan-store.desktop-preview-evidence.test.mjs', 'packages/runtime-node/src/goal-plan-store.ui-completion.test.mjs', 'packages/runtime-node/src/project-agent/tool-result-evidence-preview.test.mjs']);
run('cargo', ['build', '--locked', '-p', 'peer-runtime', '--features', 'peer-runtime/test-fixtures,peer-store/test-fixtures', '--example', 'coordination-conformance']);
run('bun', ['scripts/native-cli/coordination-conformance.ts', 'target/debug/examples/coordination-conformance']);
run('bun', ['scripts/native-cli/kernel-store-conformance.ts', 'target/debug/examples/coordination-conformance']);
run('cargo', ['build', '--locked', '-p', 'peer-runtime', '--features', 'test-fixtures', '--example', 'goal-conformance']);
run('bun', ['scripts/native-cli/goal-store-conformance.ts', 'target/debug/examples/goal-conformance']);
run('cargo', ['build', '--locked', '-p', 'peer-runtime', '--features', 'test-fixtures', '--example', 'goal-mirror-conformance']);
run('bun', ['scripts/native-cli/goal-mirror-conformance.ts', 'target/debug/examples/goal-mirror-conformance']);
run('node', ['--test', 'packages/runtime-node/src/goal-plan-transactions.test.mjs', 'packages/runtime-node/src/goal-plan-closure-mirror.test.mjs']);
run('cargo', ['build', '--locked', '-p', 'peer-credential-helper', '--bin', 'peer-credential-helper']);
run('cargo', ['build', '--locked', '-p', 'peer-runtime', '--example', 'helper-probe']);
execFileSync(join(root, 'target/debug/examples/helper-probe'), [join(root, 'target/debug/peer-credential-helper')], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PATH: '/nonexistent' },
});
run('python3', ['scripts/native-cli/pty_checks.py', '--binary', 'target/release/peer-native',
  '--fixture', 'target/release/examples/terminal-lifecycle', '--output', join(output, 'pty')]);
process.stdout.write(`Native scoped verification passed; PTY evidence: ${output}\n`);
