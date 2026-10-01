#!/usr/bin/env bun

// ACP must branch before loading any terminal UI or local runtime modules.
if (process.argv[2] === 'acp') {
  const { runAcpStdio } = await import('./acp/stdio.ts');
  await runAcpStdio(process.argv.slice(3));
  process.exit(process.exitCode ?? 0);
}

const { createCliRenderer } = await import('@opentui/core');
const { createRoot } = await import('@opentui/react');
import os from 'node:os';
import path from 'node:path';

const { App } = await import('./app.tsx');
import {
  formatPeerHelp,
  parsePeerArgv,
  shouldRefuseInteractiveTui,
} from './cli-argv.ts';
const { runPeerExec } = await import('./cli-exec.ts');
import { CLI_EXIT } from './cli-exit.ts';
import { handleCliVersionArgs } from './cli-version.ts';
import { createCliUpdateController } from './cli-update.ts';
import { createTuiLocalAccessStore } from './tui-local-access-store.ts';
const { createTuiRuntime } = await import('./tui-runtime.ts');
import { createAsyncTuiShutdown } from './tui-shutdown.ts';
import type { createTuiProjectHost } from './project-agent/tui-project-host.ts';
import type { createTuiProjectClient } from './project-agent/tui-project-client.ts';
import { projectEntry } from './project-agent/commands.ts';
import { flushTuiPerfSync } from './tui-perf.ts';
import { formatTerminalTitle } from './terminal-title.ts';

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
  process.exit(await runPeerExec(command.options));
}
if (shouldRefuseInteractiveTui(process.stdout.isTTY)) {
  console.error('peer: refusing to start the interactive TUI without a TTY. Use `peer exec`.');
  process.exit(CLI_EXIT.usage);
}

const workspaceRoot = process.env.PEER_WORKSPACE_ROOT ?? process.cwd();
const userDataPath = process.env.PEER_AGENT_HOME ?? process.env.PEER_USER_DATA_PATH ?? path.join(os.homedir(), '.peer-agent');
const localAccessStore = createTuiLocalAccessStore({ userDataPath });
let runtime: ReturnType<typeof createTuiRuntime> | null = null;
let projectHost: ReturnType<typeof createTuiProjectHost> | null = null;
let projectClient: ReturnType<typeof createTuiProjectClient> | null = null;
const renderer = await createCliRenderer({ exitOnCtrlC: false });
renderer.setTerminalTitle(formatTerminalTitle(workspaceRoot));
const cliUpdate = createCliUpdateController();
const root = createRoot(renderer);
const shutdown = createAsyncTuiShutdown({
  unmount: () => root.unmount(),
  destroyRenderer: () => renderer.destroy(),
  dispose: async () => { projectClient?.close(); await projectHost?.close(); await runtime?.dispose(); },
  onError: () => console.error('Peer could not finish stopping local execution.'),
  exitProcess: (code) => {
    flushTuiPerfSync();
    process.exit(code);
  },
});

async function openClassic() {
  projectClient?.close(); await projectHost?.close(); projectHost = null; projectClient = null;
  const classic = createTuiRuntime({ workspaceRoot, userDataPath, accessLevel: localAccessStore.getAccessLevel(),
    persistAccessLevel: accessLevel => localAccessStore.setAccessLevel(accessLevel) });
  runtime = classic;
  root.render(<App host={classic.host} model={classic.model} modelLabel={classic.modelConfig.modelLabel}
    modelSelection={classic.modelSelection} languageStore={classic.languageStore} themeStore={classic.themeStore} cliUpdate={cliUpdate}
    getSessionFastMode={() => classic.getSessionFastMode()} setSessionFastMode={value => classic.setSessionFastMode(value)}
    onQuit={() => { void shutdown(); }} />);
  queueMicrotask(() => void cliUpdate.check());
}
if (command.classic) await openClassic();
else {
  const { createTuiProjectHost } = await import('./project-agent/tui-project-host.ts');
  const { createTuiProjectClient } = await import('./project-agent/tui-project-client.ts');
  const { ProjectApp } = await import('./project-agent/ProjectApp.tsx');
  const { createTuiLanguageStore } = await import('./tui-language.ts');
  const { createTuiThemeStore } = await import('./tui-theme.ts');
  projectHost = createTuiProjectHost({dataHome:userDataPath,workspacePath:workspaceRoot});
  projectClient = createTuiProjectClient({dataHome:userDataPath,host:projectHost});
  const route = projectEntry(command, projectHost.profiles.read(projectHost.workspaceId())?.status === 'active');
  root.render(<ProjectApp host={projectHost} client={projectClient} initialView={route as 'bind'|'bots'|'conversation'}
    workspacePath={workspaceRoot} locale={createTuiLanguageStore({userDataPath}).getLocale()}
    themeStore={createTuiThemeStore({userDataPath})} onClassic={openClassic} onQuit={() => { void shutdown(); }} />);
}
