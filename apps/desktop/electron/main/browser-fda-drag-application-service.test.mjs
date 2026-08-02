import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserFdaDragApplicationService } from './browser-fda-drag-application-service.mjs';

function createHarness(overrides = {}) {
  const calls = [];
  const scheduled = [];
  const icon = { kind: 'native-image' };
  const service = createBrowserFdaDragApplicationService({
    getPlatform: () => 'darwin',
    openSettings: async () => {
      calls.push(['open-settings']);
      return { ok: true, opened: true };
    },
    showFloat: (payload) => {
      calls.push(['show-float', payload]);
      return { ok: true, appPath: '/Applications/Peer Agent.app' };
    },
    hideFloat: () => {
      calls.push(['hide-float']);
    },
    setDragging: (dragging) => {
      calls.push(['set-dragging', dragging]);
    },
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
    },
    resolveDragTarget: () => {
      calls.push(['resolve-target']);
      return { ok: true, appPath: '/Applications/Peer Agent.app' };
    },
    pathSeparator: '/',
    pathExists: (filePath) => {
      calls.push(['path-exists', filePath]);
      return true;
    },
    getCachedDragIcon: (filePath) => {
      calls.push(['get-icon', filePath]);
      return icon;
    },
    startDrag: ({ sender, filePath, dragIcon }) => {
      calls.push(['start-drag', sender, filePath, dragIcon]);
      sender.startDrag({ file: filePath, icon: dragIcon });
    },
    resolveDragIconDataUrl: async (filePath) => {
      calls.push(['resolve-icon-data-url', filePath]);
      return 'data:image/png;base64,icon';
    },
    warn: (...args) => calls.push(['warn', ...args]),
    ...overrides,
  });
  return { service, calls, scheduled, icon };
}

test('open settings rejects unsupported platforms without host side effects', async () => {
  const { service, calls, scheduled } = createHarness({ getPlatform: () => 'linux' });

  assert.deepEqual(await service.openFullDiskAccessSettings({ isZh: true }), {
    ok: false,
    error: 'unsupported_platform',
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(scheduled, []);
});

test('open settings shows the float immediately and schedules all legacy retries', async () => {
  const { service, calls, scheduled } = createHarness();

  const result = await service.openFullDiskAccessSettings({ isZh: true });

  assert.deepEqual(result, {
    ok: true,
    opened: true,
    dragFloat: { ok: true, appPath: '/Applications/Peer Agent.app' },
  });
  assert.deepEqual(scheduled.map(({ delay }) => delay), [250, 500, 900, 1500, 2400]);
  assert.deepEqual(calls.slice(0, 3), [
    ['open-settings'],
    ['show-float', { isZh: true }],
    ['get-icon', '/Applications/Peer Agent.app'],
  ]);

  for (const { callback } of scheduled) callback();
  assert.equal(calls.filter(([name]) => name === 'show-float').length, 6);
  assert.equal(calls.filter(([name]) => name === 'get-icon').length, 6);
});

test('float show failures are contained without replacing the settings result', async () => {
  const { service, scheduled } = createHarness({
    showFloat: () => {
      throw new Error('float unavailable');
    },
  });

  const result = await service.openFullDiskAccessSettings({});

  assert.deepEqual(result, {
    ok: true,
    opened: true,
    dragFloat: { ok: false, error: 'float unavailable' },
  });
  assert.equal(scheduled.length, 5);
  assert.doesNotThrow(() => scheduled[0].callback());
});

test('open settings maps outer host failures', async () => {
  const { service } = createHarness({
    openSettings: async () => {
      throw new Error('settings denied');
    },
  });

  assert.deepEqual(await service.openFullDiskAccessSettings({}), {
    ok: false,
    error: 'settings denied',
  });
});

test('hide operations preserve async and synchronous result shapes', async () => {
  const success = createHarness();
  assert.deepEqual(await success.service.hideDragFloat(), { ok: true });
  const syncResult = success.service.hideDragFloatSync();
  assert.equal(syncResult instanceof Promise, false);
  assert.deepEqual(syncResult, { ok: true });

  const failure = createHarness({
    hideFloat: () => {
      throw new Error('cannot hide');
    },
  });
  assert.deepEqual(await failure.service.hideDragFloat(), {
    ok: false,
    error: 'cannot hide',
  });
  assert.deepEqual(failure.service.hideDragFloatSync(), {
    ok: false,
    error: 'cannot hide',
  });
});

test('dragging state is boolean-coerced and controller failures are ignored', () => {
  const { service, calls } = createHarness();
  assert.equal(service.setDragFloatDragging({ dragging: 'yes' }), undefined);
  assert.deepEqual(calls, [['set-dragging', true]]);

  const failure = createHarness({
    setDragging: () => {
      throw new Error('float gone');
    },
  });
  assert.doesNotThrow(() => failure.service.setDragFloatDragging({ dragging: 1 }));
});

test('start app drag remains synchronous and normalizes executable paths to app bundles', () => {
  const trace = [];
  const sender = {
    startDrag(options) {
      trace.push(['sender-start-drag', options]);
    },
  };
  const { service, calls, icon } = createHarness({
    pathExists: (filePath) => {
      trace.push(['path-exists', filePath]);
      return true;
    },
    getCachedDragIcon: (filePath) => {
      trace.push(['get-icon', filePath]);
      return { kind: 'native-image' };
    },
    startDrag: ({ sender: dragSender, filePath, dragIcon }) => {
      trace.push(['start-drag-port', filePath, dragIcon]);
      dragSender.startDrag({ file: filePath, icon: dragIcon });
    },
  });

  const result = service.startAppDrag(
    { appPath: ' /Applications/Peer Agent.app/Contents/MacOS/PeerAgent ' },
    sender,
  );

  assert.equal(result instanceof Promise, false);
  assert.deepEqual(result, { ok: true, filePath: '/Applications/Peer Agent.app' });
  assert.deepEqual(trace, [
    ['path-exists', '/Applications/Peer Agent.app'],
    ['get-icon', '/Applications/Peer Agent.app'],
    ['start-drag-port', '/Applications/Peer Agent.app', { kind: 'native-image' }],
    ['sender-start-drag', {
      file: '/Applications/Peer Agent.app',
      icon: { kind: 'native-image' },
    }],
  ]);
  assert.deepEqual(calls, [['resolve-target']]);
  assert.notEqual(icon, null);
});

test('start app drag uses the resolved fallback and reports validation failures synchronously', () => {
  const fallback = createHarness();
  assert.deepEqual(fallback.service.startAppDrag({}, { startDrag() {} }), {
    ok: true,
    filePath: '/Applications/Peer Agent.app',
  });

  const unsupported = createHarness({ getPlatform: () => 'win32' });
  assert.deepEqual(unsupported.service.startAppDrag({}, {}), {
    ok: false,
    error: 'unsupported_platform',
  });

  const missing = createHarness({ resolveDragTarget: () => ({ ok: false }) });
  assert.deepEqual(missing.service.startAppDrag({}, {}), {
    ok: false,
    error: 'app_path_missing',
  });

  const absent = createHarness({ pathExists: () => false });
  assert.deepEqual(absent.service.startAppDrag({}, {}), {
    ok: false,
    error: 'app_path_not_found',
  });
});

test('start app drag maps thrown host errors and reports them', () => {
  const { service, calls } = createHarness({
    getCachedDragIcon: () => {
      throw new Error('icon decode failed');
    },
  });

  assert.deepEqual(service.startAppDrag({}, {}), {
    ok: false,
    error: 'icon decode failed',
  });
  assert.equal(calls.some(([name]) => name === 'warn'), true);
});

test('get drag target preserves resolver failures and adds icon data on success', async () => {
  const success = createHarness();
  assert.deepEqual(await success.service.getAppDragTarget(), {
    ok: true,
    appPath: '/Applications/Peer Agent.app',
    iconDataUrl: 'data:image/png;base64,icon',
  });

  const resolvedFailure = { ok: false, error: 'app_path_not_found' };
  const failure = createHarness({ resolveDragTarget: () => resolvedFailure });
  assert.equal(await failure.service.getAppDragTarget(), resolvedFailure);

  const thrown = createHarness({
    resolveDragTarget: () => {
      throw new Error('resolver failed');
    },
  });
  assert.deepEqual(await thrown.service.getAppDragTarget(), {
    ok: false,
    error: 'resolver failed',
  });
});
