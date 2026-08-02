import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostRestartApplicationService } from './host-restart-application-service.mjs';

test('restart handoff persists pending task before deriving and restarting the host', async () => {
  const calls = [];
  const service = createHostRestartApplicationService({
    workspaceRoot: '/work/peer-agent-lab',
    writePendingTask: (task) => calls.push(['persist', task]),
    reportPendingTaskError: (error) => calls.push(['report', error]),
    restartHost: async (options) => {
      calls.push(['restart', options]);
      return { ok: true, ...options };
    },
  });

  const result = await service.restart({
    pendingTask: { prompt: 'continue' },
    port: 5999,
  });

  assert.deepEqual(calls, [
    ['persist', { prompt: 'continue' }],
    ['restart', { hostDir: '/work/peer-agent', port: 5999 }],
  ]);
  assert.deepEqual(result, {
    ok: true,
    hostDir: '/work/peer-agent',
    port: 5999,
  });
});

test('explicit hostDir wins and pending-task persistence failure does not block restart', async () => {
  const calls = [];
  const persistError = new Error('disk full');
  const service = createHostRestartApplicationService({
    workspaceRoot: '/work/peer-agent-lab',
    writePendingTask: () => {
      calls.push(['persist']);
      throw persistError;
    },
    reportPendingTaskError: (error) => calls.push(['report', error]),
    restartHost: (options) => {
      calls.push(['restart', options]);
      return options;
    },
  });

  const result = service.restart({
    hostDir: '/explicit/host',
    pendingTask: { prompt: 'continue' },
  });

  assert.deepEqual(calls, [
    ['persist'],
    ['report', persistError],
    ['restart', { hostDir: '/explicit/host', port: undefined }],
  ]);
  assert.deepEqual(result, { hostDir: '/explicit/host', port: undefined });
});

test('workspace fallback remains unchanged when it is not a lab workspace', () => {
  const service = createHostRestartApplicationService({
    workspaceRoot: '/work/peer-agent',
    writePendingTask: () => assert.fail('no pending task should be persisted'),
    reportPendingTaskError: () => assert.fail('no persistence error should be reported'),
    restartHost: (options) => options,
  });

  assert.deepEqual(service.restart(), {
    hostDir: '/work/peer-agent',
    port: undefined,
  });
});
