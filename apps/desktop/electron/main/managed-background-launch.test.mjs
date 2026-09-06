import assert from 'node:assert/strict';
import test from 'node:test';
import { createLegacyLlmLocalToolProvider } from './runtime-gateway/legacy-llm-local-tool-provider.mjs';
import { LEGACY_LOCAL_TOOL_DEFINITIONS } from './tools/legacy-local-tool-definitions.mjs';

test('background receipt preserves task identity and evidence without a false failure', async () => {
  const provider = createLegacyLlmLocalToolProvider({ shellProvider: {
    async executeCapability() {
      return { result: { status: 'success', toolCallId: 'inner-call',
        evidence: [{ summary: 'accepted' }],
        outputPreview: { status: 'running', backgroundTaskId: 'managed-task', cwd: '/tmp' },
      } };
    },
  } });
  const execution = await provider.executeCapability({ call: {
    toolCallId: 'outer-call', capabilityId: 'legacy.local.shell.exec',
    arguments: { command: 'service', runInBackground: true },
  } });
  const receipt = JSON.parse(execution.result.outputPreview.legacyResult.output);
  assert.equal(receipt.status, 'running');
  assert.equal(receipt.taskId, 'managed-task');
  assert.equal(receipt.toolCallId, 'inner-call');
  assert.deepEqual(receipt.evidence, [{ summary: 'accepted' }]);
  assert.equal(receipt.reason, undefined);
});

test('legacy shell forwards source, cancellation and follow-up context', async () => {
  const controller = new AbortController();
  const followUp = () => {};
  let received;
  const provider = createLegacyLlmLocalToolProvider({ shellProvider: {
    async executeCapability(_request, context) {
      received = context;
      return { result: { status: 'denied', outputPreview: {} } };
    },
  } });
  await provider.executeCapability({ call: {
    toolCallId: 'source-test', capabilityId: 'legacy.local.shell.exec', arguments: { command: 'pwd' },
  } }, { conversationId: 'A', signal: controller.signal, emitFollowUpExecution: followUp, workspaceRoot: '/tmp' });
  assert.equal(received.conversationId, 'A');
  assert.equal(received.signal, controller.signal);
  assert.equal(received.emitFollowUpExecution, followUp);
  assert.equal(received.workspaceRoot, '/tmp');
});

// Execution mode × adapter result: preserve both foreground defaults and failures.
for (const background of [false, true]) {
  for (const status of ['success', 'denied']) {
    test(`launch_${background ? 'background' : 'foreground'}_${status}_argument_forwarding`, async () => {
      let received;
      const provider = createLegacyLlmLocalToolProvider({
        shellProvider: {
          async executeCapability(request) {
            received = request.call;
            return { result: { status, outputPreview: { reason: 'test result' } } };
          },
        },
      });
      await provider.executeCapability({ call: {
        toolCallId: 'launch-test', capabilityId: 'legacy.local.shell.exec',
        arguments: { command: 'pwd', ...(background ? { runInBackground: true } : {}) },
      } });
      assert.deepEqual(received.arguments, { command: 'pwd', ...(background ? { runInBackground: true } : {}) });
      assert.deepEqual(received.argumentsPreview, received.arguments);
      assert.equal(received.capabilityId, 'local.shell.exec');
    });
  }
}

test('bash projection exposes optional managed background launch', () => {
  const definition = LEGACY_LOCAL_TOOL_DEFINITIONS.find((item) => item.name === 'bash');
  assert.equal(definition.inputSchema.properties.runInBackground.type, 'boolean');
  assert.deepEqual(definition.inputSchema.required, ['command']);
  assert.equal(definition.inputSchema.additionalProperties, false);
});
