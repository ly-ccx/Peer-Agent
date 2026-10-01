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

test('asynchronous shutdown drains execution before restoring the terminal and exits once',async()=>{
  const {createAsyncTuiShutdown}=await import('./tui-shutdown.ts');
  const events:string[]=[];let release!:()=>void;
  const stopped=new Promise<void>(resolve=>{release=resolve;});
  const shutdown=createAsyncTuiShutdown({dispose:async()=>{events.push('drain');await stopped;events.push('stopped');},
    unmount:()=>events.push('unmount'),destroyRenderer:()=>events.push('destroy'),exitProcess:code=>events.push(`exit:${code}`),onError:()=>events.push('error')});
  const first=shutdown();expect(shutdown()).toBe(first);expect(events).toEqual(['drain']);
  release();await first;expect(events).toEqual(['drain','stopped','unmount','destroy','exit:0']);
});
test('failed asynchronous shutdown restores the terminal and exits unsuccessfully',async()=>{
  const {createAsyncTuiShutdown}=await import('./tui-shutdown.ts');const events:string[]=[];
  await createAsyncTuiShutdown({dispose:async()=>{throw Error('failed');},onError:()=>events.push('error'),unmount:()=>events.push('unmount'),
    destroyRenderer:()=>events.push('destroy'),exitProcess:code=>events.push(`exit:${code}`)})();
  expect(events).toEqual(['error','unmount','destroy','exit:1']);
});
