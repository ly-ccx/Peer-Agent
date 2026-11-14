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
run('node', ['scripts/native-cli/check-boundaries.mjs']);
run('cargo', ['fmt', '--all', '--check']);
run('cargo', ['clippy', '--locked', '-p', 'peer-cli', '-p', 'peer-protocol', '-p', 'peer-tui', '--all-targets', '--', '-D', 'warnings']);
run('cargo', ['test', '--locked', '--workspace', '--all-targets']);
run('cargo', ['build', '--release', '--locked', '-p', 'peer-cli', '--bins', '--examples']);
run('python3', ['scripts/native-cli/pty_checks.py', '--binary', 'target/release/peer-native',
  '--fixture', 'target/release/examples/terminal-lifecycle', '--output', join(output, 'pty')]);
process.stdout.write(`Native scoped verification passed; PTY evidence: ${output}\n`);
