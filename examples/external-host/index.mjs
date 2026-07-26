/**
 * Minimal external host for Peer Agent open runtime.
 *
 * Install (workspace / local packs):
 *   pnpm --filter @peer-agent/protocol build
 *   pnpm --filter @peer-agent/runtime-core build
 *   pnpm --filter @peer-agent/runtime-sdk build
 *   cd examples/external-host && npm install && npm start
 *
 * Or after packages are on npm (same VERSION as product, e.g. 0.0.1-beta.41):
 *   npm install @peer-agent/runtime-sdk@0.0.1-beta.41
 *   node index.mjs
 *
 * This example must NOT import Electron, apps/desktop, or @peer-agent/cli.
 */
import assert from 'node:assert/strict';
import {
  RUNTIME_EVENT_PROTOCOL_VERSION,
  createRuntimePipeline,
  createRuntimeSdk,
  createRuntimeSessionController,
} from '@peer-agent/runtime-sdk';
import { createCapabilityProviderRegistry } from '@peer-agent/runtime-core';

assert.equal(typeof RUNTIME_EVENT_PROTOCOL_VERSION, 'number');
assert.equal(typeof createCapabilityProviderRegistry, 'function');

// Host supplies environment-specific execution. The open runtime owns ordering,
// session/turn lifecycle, and event emission — not filesystem/network/UI.
const host = {
  executeProvider: async ({ call }) => ({
    result: {
      toolCallId: call.toolCallId,
      status: 'completed',
      evidence: {
        evidenceId: `evidence:${call.toolCallId}`,
        summary: 'external host executed provider',
      },
    },
  }),
  createBlockedExecution: ({ request, reason }) => ({
    call: request.call,
    grant: { granted: false },
    result: {
      toolCallId: request.call.toolCallId,
      status: 'failed',
      reason,
    },
  }),
  appendHookEvidence: (result) => result,
};

const runtime = createRuntimeSdk({ host });
const events = [];
const unsubscribe = runtime.subscribe((event) => {
  events.push(event.type);
});

const execution = await runtime.execute({
  sessionId: 'external-host-session',
  call: {
    toolCallId: 'tool-1',
    capabilityId: 'local.example.echo',
    arguments: { text: 'hello open runtime' },
  },
});
assert.equal(execution.result.status, 'completed');
unsubscribe();

const sessions = createRuntimeSessionController();
const turn = sessions.start({
  sessionId: 'external-host-session',
  conversationId: 'external-host-conversation',
  streamId: 'stream-1',
});
const session = turn.complete();
assert.equal(session.status, 'idle');
assert.equal(session.lastTurn?.status, 'completed');

const pipeline = createRuntimePipeline({
  model: {
    initialize: ({ input }) => ({ transcript: [String(input)] }),
    runTurn: async (state) => ({
      kind: 'completed',
      state,
      output: `echo:${state.transcript[0] ?? ''}`,
    }),
    applyToolResults: (state) => state,
  },
  tools: {
    execute: async () => {
      throw new Error('no tools in this minimal example');
    },
  },
});

const pipelineResult = await pipeline.run({
  sessionId: 'external-host-session',
  streamId: 'stream-1',
  input: 'hello open runtime',
});

console.log(
  JSON.stringify(
    {
      ok: true,
      runtimeEventProtocol: RUNTIME_EVENT_PROTOCOL_VERSION,
      toolResultStatus: execution.result.status,
      sessionStatus: session.status,
      pipelineStatus: pipelineResult.status,
      pipelineOutput: pipelineResult.output,
      observedEventTypes: events,
    },
    null,
    2,
  ),
);
