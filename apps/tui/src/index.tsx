#!/usr/bin/env bun

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import os from 'node:os';
import path from 'node:path';

import { App } from './app.tsx';
import {
  formatPeerHelp,
  parsePeerArgv,
  shouldRefuseInteractiveTui,
} from './cli-argv.ts';
import { runPeerExec } from './cli-exec.ts';
import { CLI_EXIT } from './cli-exit.ts';
import { handleCliVersionArgs } from './cli-version.ts';
import { createCliUpdateController } from './cli-update.ts';
import { createTuiLocalAccessStore } from './tui-local-access-store.ts';
import { createTuiRuntime } from './tui-runtime.ts';
import { createTuiShutdown } from './tui-shutdown.ts';
import { flushTuiPerfSync } from './tui-perf.ts';
import { formatTerminalTitle } from './terminal-title.ts';

const argv = process.argv.slice(2);
if (handleCliVersionArgs(argv)) {
  process.exit(0);
}

const command = parsePeerArgv(argv);
if (command.kind === 'help') {
  console.log(formatPeerHelp(command.topic));
  process.exit(0);
}
if (command.kind === 'error') {
  console.error(command.message);
  process.exit(command.exitCode);
}
if (command.kind === 'exec') {
  process.exit(await runPeerExec(command.options));
}
if (shouldRefuseInteractiveTui(process.stdout.isTTY)) {
  console.error('peer: refusing to start the interactive TUI without a TTY. Use `peer exec`.');
  process.exit(CLI_EXIT.usage);
}

const workspaceRoot = process.env.PEER_WORKSPACE_ROOT ?? process.cwd();
const userDataPath = process.env.PEER_USER_DATA_PATH ?? path.join(os.homedir(), '.peer-agent');
const localAccessStore = createTuiLocalAccessStore({ userDataPath });
const runtime = createTuiRuntime({
  workspaceRoot,
  userDataPath,
  accessLevel: localAccessStore.getAccessLevel(),
  persistAccessLevel: (accessLevel) => localAccessStore.setAccessLevel(accessLevel),
});
const renderer = await createCliRenderer({ exitOnCtrlC: false });
renderer.setTerminalTitle(formatTerminalTitle(workspaceRoot));
const cliUpdate = createCliUpdateController();
const root = createRoot(renderer);
const shutdown = createTuiShutdown({
  unmount: () => root.unmount(),
  destroyRenderer: () => renderer.destroy(),
  exitProcess: (code) => {
    void runtime.dispose();
    flushTuiPerfSync();
    process.exit(code);
  },
});

root.render(
  <App
    host={runtime.host}
    model={runtime.model}
    modelLabel={runtime.modelConfig.modelLabel}
    modelSelection={runtime.modelSelection}
    languageStore={runtime.languageStore}
    themeStore={runtime.themeStore}
    cliUpdate={cliUpdate}
    onQuit={shutdown}
  />,
);
queueMicrotask(() => void cliUpdate.check());
