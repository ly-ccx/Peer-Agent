import os from 'node:os';
import path from 'node:path';
import type { parsePeerArgv } from './cli-argv.ts';
import type { createTuiProjectHost } from './project-agent/tui-project-host.ts';
import type { createTuiProjectClient } from './project-agent/tui-project-client.ts';

type InteractiveCommand = Exclude<ReturnType<typeof parsePeerArgv>, { kind: 'error' | 'exec' | 'version' | 'help' }>;

/** JSX and its runtime are loaded only after the lightweight command branches. */
export async function runInteractiveTui(command: InteractiveCommand) {
  const [{ createCliRenderer }, { createRoot }, { createCliUpdateController },
    { createTuiLocalAccessStore }, { createAsyncTuiShutdown }, { projectEntry },
    { flushTuiPerfSync }, { formatTerminalTitle }] = await Promise.all([
    import('@opentui/core'), import('@opentui/react'), import('./cli-update.ts'),
    import('./tui-local-access-store.ts'), import('./tui-shutdown.ts'), import('./project-agent/commands.ts'),
    import('./tui-perf.ts'), import('./terminal-title.ts'),
  ]);

  const workspaceRoot = process.env.PEER_WORKSPACE_ROOT ?? process.cwd();
  const userDataPath = process.env.PEER_AGENT_HOME ?? process.env.PEER_USER_DATA_PATH ?? path.join(os.homedir(), '.peer-agent');
  const localAccessStore = createTuiLocalAccessStore({ userDataPath });
  let runtime: ReturnType<typeof import('./tui-runtime.ts').createTuiRuntime> | null = null;
  let projectHost: ReturnType<typeof createTuiProjectHost> | null = null;
  let projectClient: ReturnType<typeof createTuiProjectClient> | null = null;
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  renderer.setTerminalTitle(formatTerminalTitle(workspaceRoot));
  const cliUpdate = createCliUpdateController();
  const root = createRoot(renderer);
  const shutdown = createAsyncTuiShutdown({
    unmount: () => root.unmount(),
    destroyRenderer: () => renderer.destroy(),
    dispose: async () => {
      try { await projectClient?.close(); }
      finally { try { await projectHost?.close(); } finally { await runtime?.dispose(); } }
    },
    onError: () => console.error('Peer could not finish stopping local execution.'),
    exitProcess: (code) => {
      flushTuiPerfSync();
      process.exit(code);
    },
  });

  let classicFlight: Promise<void> | null = null;
  function openClassic(): Promise<void> {
    if (classicFlight) return classicFlight;
    classicFlight = enterClassic().finally(() => { classicFlight = null; });
    return classicFlight;
  }
  async function enterClassic() {
    const [{ App }, { createTuiRuntime }] = await Promise.all([import('./app.tsx'), import('./tui-runtime.ts')]);
    await projectClient?.close();
    root.unmount();
    await projectHost?.close(); projectHost = null; projectClient = null;
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
    projectClient = createTuiProjectClient({dataHome:userDataPath,host:projectHost,autoStart:false});
    const route = projectEntry(command, projectHost.profiles.read(projectHost.workspaceId())?.status === 'active');
    root.render(<ProjectApp host={projectHost} client={projectClient} initialView={route as 'bind'|'bots'|'conversation'}
      workspacePath={workspaceRoot} locale={createTuiLanguageStore({userDataPath}).getLocale()}
      themeStore={createTuiThemeStore({userDataPath})} onClassic={openClassic} onQuit={() => { void shutdown(); }} />);
  }
}
