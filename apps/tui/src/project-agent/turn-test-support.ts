import type { TuiRuntime } from '../tui-runtime.ts';

export type TestCleanup = () => unknown | Promise<unknown>;

export async function withinTestDeadline<T>(pending: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Observe turn rejection immediately; an entry latch alone cannot report setup failure. */
export function waitForTestStart(started: Promise<void>, turn: Promise<unknown>, label: string, timeoutMs?: number): Promise<void> {
  return withinTestDeadline(Promise.race([started, turn.then(() => {
    throw new Error(`${label} finished before entering the provider`);
  })]), label, timeoutMs);
}

/** LIFO ownership survives a failed or stalled disposer, including temporary-directory removal. */
export async function drainTestCleanup(cleanups: TestCleanup[], timeoutMs = 2_000): Promise<void> {
  const errors: unknown[] = [];
  while (cleanups.length) {
    const cleanup = cleanups.pop()!;
    try { await withinTestDeadline(Promise.resolve().then(cleanup), 'test resource cleanup', timeoutMs); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'TUI test resource cleanup failed');
}

/** A checked runtime adapter: turn ports are real; unexpected terminal-UI access fails explicitly. */
export function createTurnTestRuntime(ports: Pick<TuiRuntime, 'host' | 'model' | 'modelSelection'>,
  cleanups: TestCleanup[]): TuiRuntime {
  let fastMode = false;
  let disposed: Promise<void> | undefined;
  const dispose = () => disposed ??= Promise.resolve().then(() => ports.host.dispose());
  cleanups.push(dispose);
  return {
    ...ports,
    getSessionFastMode: () => fastMode,
    setSessionFastMode: value => { fastMode = value; },
    dispose,
    get contextSelection(): never { throw new Error('Turn fixture has no terminal context picker'); },
    get modelConfig(): never { throw new Error('Turn fixture has no terminal model configuration'); },
    get languageStore(): never { throw new Error('Turn fixture has no terminal language store'); },
    get themeStore(): never { throw new Error('Turn fixture has no terminal theme store'); },
  };
}
