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
