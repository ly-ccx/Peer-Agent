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
if (argv[0] === '__interactive-maintenance') {
  const { runInteractiveMaintenance } = await import('./cli-interactive-maintenance.ts');
  process.exit(runInteractiveMaintenance(argv.slice(1)));
}
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
if (command.kind === 'result-cleanup-receipt') {
  const { runInteractiveMaintenance } = await import('./cli-interactive-maintenance.ts');
  process.exit(runInteractiveMaintenance());
}
if (command.kind === 'result') {
  const { runPeerResult } = await import('./cli-result.ts');
  process.exit(runPeerResult(command));
}
if (command.kind === 'update') {
  const { runPeerUpdate } = await import('./cli-update.ts');
  process.exit(await runPeerUpdate({ checkOnly: command.checkOnly }));
}
if (command.kind === 'models') {
  const { runPeerModels } = await import('./cli-models.ts');
  process.exit(await runPeerModels());
}
if (command.kind === 'doctor') {
  const { runPeerDoctor } = await import('./cli-doctor.ts');
  process.exit(await runPeerDoctor());
}
if (command.kind === 'completions') {
  const { runPeerCompletions } = await import('./cli-completions.ts');
  process.exit(runPeerCompletions(command.shell));
}
if (command.kind === 'export') {
  const { runPeerExport } = await import('./cli-export.ts');
  process.exit(await runPeerExport({
    sessionId: command.sessionId,
    outputPath: command.outputPath,
    force: command.force,
  }));
}
if (command.kind === 'sessions' && command.sessions.action === 'resume') {
  if (process.stdout.isTTY !== true) {
    console.error('peer sessions resume needs a TTY. Use `peer exec` for a headless turn.');
    process.exit(CLI_EXIT.usage);
  }
  const { sessionIsStored } = await import('./cli-sessions.ts');
  if (!await sessionIsStored(command.sessions.id)) {
    console.error(`peer sessions: session not found: ${command.sessions.id}`);
    process.exit(CLI_EXIT.runtime);
  }
  const { runInteractiveTui } = await import('./interactive-entry.tsx');
  await runInteractiveTui({ kind: 'tui', classic: true, resumeConversationId: command.sessions.id });
  process.exit(process.exitCode ?? 0);
}
if (command.kind === 'sessions') {
  const { runPeerSessions } = await import('./cli-sessions.ts');
  process.exit(await runPeerSessions(command.sessions));
}
if (shouldRefuseInteractiveTui(process.stdout.isTTY)) {
  console.error('peer: refusing to start the interactive TUI without a TTY. Use `peer exec`.');
  process.exit(CLI_EXIT.usage);
}

const { runInteractiveTui } = await import('./interactive-entry.tsx');
await runInteractiveTui(command);
