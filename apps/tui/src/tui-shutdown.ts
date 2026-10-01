export interface TuiShutdownDependencies {
  readonly unmount: () => void;
  readonly destroyRenderer: () => void;
  readonly exitProcess: (code: number) => void;
}

/** Restores terminal state before ending the process. Safe to invoke more than once. */
export function createTuiShutdown(dependencies: TuiShutdownDependencies): () => void {
  let shuttingDown = false;
  return () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      dependencies.unmount();
    } finally {
      try {
        dependencies.destroyRenderer();
      } finally {
        dependencies.exitProcess(0);
      }
    }
  };
}

/** Keep the terminal alive until local execution drains, then restore it once. */
export function createAsyncTuiShutdown(dependencies: TuiShutdownDependencies & {
  readonly dispose: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}): () => Promise<void> {
  let flight: Promise<void> | null = null;
  return () => {
    if (flight) return flight;
    flight = (async () => {
      let exitCode = 0;
      try { await dependencies.dispose(); }
      catch (error) { exitCode = 1; dependencies.onError(error); }
      createTuiShutdown({ ...dependencies, exitProcess: () => dependencies.exitProcess(exitCode) })();
    })();
    return flight;
  };
}
