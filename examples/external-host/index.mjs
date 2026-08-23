/**
 * Minimal external host for Peer Agent open runtime.
 *
 * Install (workspace / local packs):
 *   pnpm --filter @peer-agent/protocol build
 *   pnpm --filter @peer-agent/runtime-core build
 *   pnpm --filter @peer-agent/runtime-sdk build
 *   cd examples/external-host && npm install && npm start
 *
 * Or after packages are on npm (same VERSION as product):
 *   npm install @peer-agent/runtime-sdk
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
import {
  createCapabilityProviderRegistry,
  createEvidenceExportDocument,
} from '@peer-agent/runtime-core';

assert.equal(typeof RUNTIME_EVENT_PROTOCOL_VERSION, 'number');
assert.equal(typeof createCapabilityProviderRegistry, 'function');

function echoProvider(summary) {
  return {
    providerId: 'local.example',
    capabilityIds: ['local.example.echo'],
    async execute(request) {
      return {
        toolCallId: request.toolCall.toolCallId,
        capabilityId: request.capabilityId,
        status: 'completed',
        outputPreview: { text: request.input?.text, summary },
        evidence: {
          evidenceId: `evidence:${request.toolCall.toolCallId}`,
          summary,
        },
      };
    },
  };
}

const registry = createCapabilityProviderRegistry([echoProvider('before replace')]);
registry.replace(echoProvider('after replace'));
const providerResult = await registry.execute({
  capabilityId: 'local.example.echo',
  input: { text: 'hello open runtime' },
  toolCall: {
    toolCallId: 'tool-1',
    capabilityId: 'local.example.echo',
    input: { text: 'hello open runtime' },
  },
}, { runId: 'external-host-session' });
assert.equal(providerResult.status, 'completed');
assert.equal(providerResult.evidence.summary, 'after replace');

const evidenceExport = createEvidenceExportDocument({
  source: {
    toolCallId: 'tool-1',
    capabilityId: 'local.example.echo',
  },
  summary: providerResult.evidence.summary,
  refs: ['tool-result://tool-1'],
});
assert.equal(evidenceExport.kind, 'peer.evidence.export');
assert.deepEqual(evidenceExport.refs, ['tool-result://tool-1']);

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
      replacedProviderSummary: providerResult.evidence.summary,
      evidenceExportKind: evidenceExport.kind,
      evidenceExportRefs: evidenceExport.refs,
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
