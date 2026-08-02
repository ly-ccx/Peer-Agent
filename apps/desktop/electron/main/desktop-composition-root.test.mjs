import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  bindDesktopAppLifecycle,
  createDesktopCompositionRoot,
} from './desktop-composition-root.mjs';

function createSilentLogger() {
  return { info() {}, warn() {}, error() {} };
}

class FakeElectronApp extends EventEmitter {
  constructor() {
    super();
    this.quitCalls = 0;
  }

  whenReady() {
    return Promise.resolve();
  }

  quit() {
    this.quitCalls += 1;
  }
}

test('starts declared phases in order and disposes every owner in reverse order', async () => {
  const events = [];
  const root = createDesktopCompositionRoot({
    initialOwners: [
      { name: 'trusted-window-registry', dispose: () => events.push('dispose:trusted') },
      { name: 'desktop-ipc', dispose: () => events.push('dispose:ipc') },
    ],
    phases: [
      {
        name: 'runtime-services',
        start: async () => {
          events.push('start:runtime');
          return () => events.push('dispose:runtime');
        },
      },
      {
        name: 'first-window',
        start: () => {
          events.push('start:window');
          return { dispose: () => events.push('dispose:window') };
        },
      },
    ],
  });

  assert.equal(await root.start(), true);
  assert.deepEqual(events, ['start:runtime', 'start:window']);
  assert.deepEqual(root.getActiveOwners(), [
    'trusted-window-registry',
    'desktop-ipc',
    'runtime-services',
    'first-window',
  ]);

  assert.equal(await root.dispose(), true);
  assert.deepEqual(events, [
    'start:runtime',
    'start:window',
    'dispose:window',
    'dispose:runtime',
    'dispose:ipc',
    'dispose:trusted',
  ]);
  assert.equal(await root.dispose(), false);
});

test('rolls back completed phases and adopted owners when a fatal phase fails', async () => {
  const events = [];
  const startupError = new Error('window failed');
  const root = createDesktopCompositionRoot({
    initialOwners: [
      { name: 'desktop-ipc', dispose: () => events.push('dispose:ipc') },
    ],
    phases: [
      {
        name: 'runtime-services',
        start: () => {
          events.push('start:runtime');
          return () => events.push('dispose:runtime');
        },
      },
      {
        name: 'first-window',
        start: () => {
          events.push('start:window');
          throw startupError;
        },
      },
      {
        name: 'never-started',
        start: () => events.push('start:never'),
      },
    ],
  });

  await assert.rejects(root.start(), (error) => error === startupError);
  assert.deepEqual(events, [
    'start:runtime',
    'start:window',
    'dispose:runtime',
    'dispose:ipc',
  ]);
  assert.equal(root.getStatus(), 'failed');
  assert.deepEqual(root.getActiveOwners(), []);
  assert.equal(await root.dispose(), false);
});

test('keeps optional startup failures degradable and continues later phases', async () => {
  const events = [];
  const optionalError = new Error('tray unavailable');
  const root = createDesktopCompositionRoot({
    logger: createSilentLogger(),
    phases: [
      {
        name: 'tray',
        fatal: false,
        start: () => {
          events.push('start:tray');
          throw optionalError;
        },
        onError: (error) => events.push(`warn:${error.message}`),
      },
      {
        name: 'first-window',
        start: () => {
          events.push('start:window');
        },
      },
    ],
  });

  assert.equal(await root.start(), true);
  assert.deepEqual(events, ['start:tray', 'warn:tray unavailable', 'start:window']);
  assert.equal(root.getStatus(), 'started');
});

test('continues all cleanup and reports multiple disposer failures together', async () => {
  const events = [];
  const firstError = new Error('second owner failed');
  const secondError = new Error('first owner failed');
  const root = createDesktopCompositionRoot({
    initialOwners: [
      {
        name: 'first',
        dispose: () => {
          events.push('dispose:first');
          throw secondError;
        },
      },
      {
        name: 'second',
        dispose: async () => {
          events.push('dispose:second');
          throw firstError;
        },
      },
      { name: 'third', dispose: () => events.push('dispose:third') },
    ],
  });

  await root.start();
  await assert.rejects(root.dispose(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [firstError, secondError]);
    return true;
  });
  assert.deepEqual(events, ['dispose:third', 'dispose:second', 'dispose:first']);
  assert.equal(root.getStatus(), 'disposed');
});

test('startup trace proves IPC readiness precedes services and the first window', async () => {
  const trace = [];
  const root = createDesktopCompositionRoot({
    trace: (event) => trace.push(`${event.type}:${event.owner ?? ''}`),
    phases: [
      { name: 'ipc-ready', start: () => {} },
      { name: 'runtime-services', start: () => {} },
      { name: 'first-window', start: () => {} },
    ],
  });

  await root.start();
  assert.deepEqual(
    trace.filter((event) => event.startsWith('phase:start')),
    [
      'phase:start:ipc-ready',
      'phase:start:runtime-services',
      'phase:start:first-window',
    ],
  );
});

test('binds one Electron lifecycle, awaits async cleanup, and avoids duplicate listeners', async () => {
  const app = new FakeElectronApp();
  let starts = 0;
  let disposals = 0;
  let activates = 0;
  let releaseDispose;
  const disposeGate = new Promise((resolve) => {
    releaseDispose = resolve;
  });
  const root = {
    async start() {
      starts += 1;
    },
    async dispose() {
      disposals += 1;
      await disposeGate;
    },
  };

  const binding = bindDesktopAppLifecycle({
    app,
    root,
    platform: 'darwin',
    onActivate: () => {
      activates += 1;
    },
    logger: createSilentLogger(),
  });

  await binding.ready;
  assert.equal(starts, 1);
  assert.equal(app.listenerCount('activate'), 1);
  assert.equal(app.listenerCount('window-all-closed'), 1);
  assert.equal(app.listenerCount('before-quit'), 1);
  assert.throws(
    () => bindDesktopAppLifecycle({ app, root, logger: createSilentLogger() }),
    /already bound/,
  );

  app.emit('activate');
  assert.equal(activates, 1);

  let prevented = 0;
  const quitEvent = { preventDefault: () => { prevented += 1; } };
  app.emit('before-quit', quitEvent);
  app.emit('before-quit', quitEvent);
  assert.equal(prevented, 2);
  assert.equal(disposals, 1);
  assert.equal(app.quitCalls, 0);

  releaseDispose();
  await binding.getShutdownPromise();
  assert.equal(disposals, 1);
  assert.equal(app.quitCalls, 1);
  assert.equal(app.listenerCount('activate'), 0);
  assert.equal(app.listenerCount('window-all-closed'), 0);
  assert.equal(app.listenerCount('before-quit'), 0);
});

test('allows a caller to resume a specialized quit action after cleanup', async () => {
  const app = new FakeElectronApp();
  const events = [];
  const root = {
    start: async () => {},
    dispose: async () => events.push('dispose'),
  };
  const binding = bindDesktopAppLifecycle({
    app,
    root,
    logger: createSilentLogger(),
  });
  await binding.ready;

  await binding.shutdown({ resume: () => events.push('install-update') });

  assert.deepEqual(events, ['dispose', 'install-update']);
  assert.equal(app.quitCalls, 0);
  assert.equal(app.listenerCount('before-quit'), 0);
});

test('quits after all windows close outside macOS', async () => {
  const app = new FakeElectronApp();
  const root = { start: async () => {}, dispose: async () => {} };
  const binding = bindDesktopAppLifecycle({
    app,
    root,
    platform: 'linux',
    logger: createSilentLogger(),
  });
  await binding.ready;

  app.emit('window-all-closed');
  assert.equal(app.quitCalls, 1);
  binding.unbind();
});
