#!/usr/bin/env node
// Development verification uses TS as the conformance reference. The built
// peer-native executable does not spawn this script, Node, or Bun.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'peer-native-check-'));
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
run('bun', ['scripts/native-cli/contracts.ts']);
run('bun', ['scripts/native-cli/control-contracts.ts']);
run('node', ['scripts/native-cli/check-boundaries.mjs']);
run('cargo', ['fmt', '--all', '--check']);
run('cargo', ['clippy', '--locked', '-p', 'peer-cli', '-p', 'peer-protocol', '-p', 'peer-tui', '-p', 'peer-store', '-p', 'peer-runtime', '--all-targets', '--features', 'peer-runtime/test-fixtures,peer-store/test-fixtures', '--', '-D', 'warnings']);
run('cargo', ['test', '--locked', '--workspace', '--all-targets', '--features', 'peer-runtime/test-fixtures,peer-store/test-fixtures']);
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
run('cargo', ['build', '--locked', '-p', 'peer-credential-helper', '--bin', 'peer-credential-helper']);
run('cargo', ['build', '--locked', '-p', 'peer-runtime', '--example', 'helper-probe']);
execFileSync(join(root, 'target/debug/examples/helper-probe'), [join(root, 'target/debug/peer-credential-helper')], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PATH: '/nonexistent' },
});
run('python3', ['scripts/native-cli/pty_checks.py', '--binary', 'target/release/peer-native',
  '--fixture', 'target/release/examples/terminal-lifecycle', '--output', join(output, 'pty')]);
process.stdout.write(`Native scoped verification passed; PTY evidence: ${output}\n`);
