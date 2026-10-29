#!/usr/bin/env bun

// ACP must branch before loading any terminal UI or local runtime modules.
if (process.argv[2] === 'acp') {
  const { runAcpStdio } = await import('./acp/stdio.ts');
  await runAcpStdio(process.argv.slice(3));
  process.exit(process.exitCode ?? 0);
}

import {
  formatPeerHelp,
  parsePeerArgv,
  shouldRefuseInteractiveTui,
} from './cli-argv.ts';
import { CLI_EXIT } from './cli-exit.ts';
import { handleCliVersionArgs } from './cli-version.ts';

const argv = process.argv.slice(2);
if (handleCliVersionArgs(argv)) {
  process.exit(0);
}

const command = parsePeerArgv(argv);
if (command.kind === 'version') process.exit(0);
if (command.kind === 'help') {
  console.log(formatPeerHelp(command.topic));
  process.exit(0);
}
if (command.kind === 'error') {
  console.error(command.message);
  process.exit(command.exitCode);
}
if (command.kind === 'exec') {
  const { runPeerExec } = await import('./cli-exec.ts');
  process.exit(await runPeerExec(command.options));
}
if (shouldRefuseInteractiveTui(process.stdout.isTTY)) {
  console.error('peer: refusing to start the interactive TUI without a TTY. Use `peer exec`.');
  process.exit(CLI_EXIT.usage);
}

const { runInteractiveTui } = await import('./interactive-entry.tsx');
await runInteractiveTui(command);
