import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOUD_CONTRACT_BLOCKER_CLASSES,
  classifyCloudContractStatus,
  createCloudContractProbes,
  createExpectedCloudContractProbeContracts,
} from './cloud-contract-probe.mjs';

test('classifyCloudContractStatus separates route existence from blockers', () => {
  assert.equal(classifyCloudContractStatus(200), 'ok');
  assert.equal(classifyCloudContractStatus(302), 'redirect');
  assert.equal(classifyCloudContractStatus(400), 'route_exists');
  assert.equal(classifyCloudContractStatus(401), 'route_exists');
  assert.equal(classifyCloudContractStatus(403), 'route_exists');
  assert.equal(classifyCloudContractStatus(405), 'route_exists');
  assert.equal(classifyCloudContractStatus(422), 'route_exists');
  assert.equal(classifyCloudContractStatus(426), 'route_exists');
  assert.equal(classifyCloudContractStatus(404), 'missing');
  assert.equal(classifyCloudContractStatus(501), 'not_implemented');
  assert.equal(classifyCloudContractStatus(500), 'server_error');
});

test('CLOUD_CONTRACT_BLOCKER_CLASSES matches production acceptance blockers', () => {
  assert.deepEqual(
    Array.from(CLOUD_CONTRACT_BLOCKER_CLASSES).sort(),
    ['missing', 'not_implemented', 'server_error', 'unexpected', 'unreachable'].sort(),
  );
  assert.equal(CLOUD_CONTRACT_BLOCKER_CLASSES.has('ok'), false);
  assert.equal(CLOUD_CONTRACT_BLOCKER_CLASSES.has('route_exists'), false);
  assert.equal(CLOUD_CONTRACT_BLOCKER_CLASSES.has('redirect'), false);
});

test('createExpectedCloudContractProbeContracts exposes the route contract audited by completion checks', () => {
  assert.deepEqual(createExpectedCloudContractProbeContracts(), [
    { id: 'clientRuntimeTasksPoll', method: 'POST', path: '/api/client/runtime/tasks/poll' },
    { id: 'clientToolResultReport', method: 'POST', path: '/api/chat/client-tool/result' },
    { id: 'runtimeProjectionPublish', method: 'POST', path: '/api/client/runtime/projection' },
    { id: 'runtimeGatewayWs', method: 'GET', path: '/api/client/runtime/ws' },
    { id: 'chatStatisticsExport', method: 'POST', path: '/api/chat/statistics/export' },
    { id: 'openClawGovernanceCatalog', method: 'GET', path: '/api/openclaw-governance/catalog' },
    {
      id: 'openClawConversationEffectiveConfig',
      method: 'GET',
      path: '/api/openclaw-governance/effective-agent-config/resolve-conversation?conversationId=0',
    },
    { id: 'openClawStudioCurrentScene', method: 'GET', path: '/api/openclaw-studio/scene/current' },
  ]);
});

test('createCloudContractProbes applies local proxy route overrides to runtime handoff probes', () => {
  const probes = createCloudContractProbes({
    ZEUS_ATLAS_CLIENT_TOOL_POLL_PATH: '/custom/runtime/tasks/poll',
    ZEUS_ATLAS_CLIENT_TOOL_RESULT_PATH: '/custom/client-tool/result',
    ZEUS_ATLAS_RUNTIME_PROJECTION_PATH: '/custom/runtime/projection',
    ZEUS_ATLAS_RUNTIME_GATEWAY_WS_PATH: '/custom/runtime/ws',
  }, '2026-05-14T00:00:00.000Z');

  assert.equal(probes.find((probe) => probe.id === 'clientRuntimeTasksPoll')?.path, '/custom/runtime/tasks/poll');
  assert.equal(probes.find((probe) => probe.id === 'clientToolResultReport')?.path, '/custom/client-tool/result');
  assert.equal(probes.find((probe) => probe.id === 'runtimeProjectionPublish')?.path, '/custom/runtime/projection');
  assert.equal(probes.find((probe) => probe.id === 'runtimeGatewayWs')?.path, '/custom/runtime/ws');
  assert.equal(probes.find((probe) => probe.id === 'chatStatisticsExport')?.path, '/api/chat/statistics/export');
});
