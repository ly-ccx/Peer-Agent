import { describe, expect, test } from 'bun:test';

import { createTuiShutdown } from './tui-shutdown.ts';

describe('TUI shutdown', () => {
  test('unmounts, restores the terminal, and exits in order', () => {
    const calls: string[] = [];
    const shutdown = createTuiShutdown({
      unmount: () => calls.push('unmount'),
      destroyRenderer: () => calls.push('destroy'),
      exitProcess: (code) => calls.push(`exit:${code}`),
    });

    shutdown();

    expect(calls).toEqual(['unmount', 'destroy', 'exit:0']);
  });

  test('is idempotent and still exits if cleanup throws', () => {
    const calls: string[] = [];
    const shutdown = createTuiShutdown({
      unmount: () => { calls.push('unmount'); throw new Error('unmount failed'); },
      destroyRenderer: () => calls.push('destroy'),
      exitProcess: (code) => calls.push(`exit:${code}`),
    });

    expect(() => shutdown()).toThrow('unmount failed');
    shutdown();

    expect(calls).toEqual(['unmount', 'destroy', 'exit:0']);
  });
});
