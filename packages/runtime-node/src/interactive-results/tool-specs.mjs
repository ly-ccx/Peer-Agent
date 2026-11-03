import { INTERACTIVE_INSPECT_CAPABILITY as INSPECT, INTERACTIVE_INSPECT_TOOL, INTERACTIVE_PUBLISH_CAPABILITY as PUBLISH, INTERACTIVE_PUBLISH_TOOL, INTERACTIVE_RESULT_LIMITS as L } from '@peer-agent/protocol';

const token = { type: 'string', minLength: 1, maxLength: 256 };
const digest = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const owner = { type: 'object', properties: { workspaceId: token, conversationId: token }, required: ['workspaceId', 'conversationId'], additionalProperties: false };
const reference = { type: 'object', properties: { owner, resultId: token, contentVersion: digest }, required: ['owner', 'resultId', 'contentVersion'], additionalProperties: false };
const callReference = { type: 'object', properties: { owner, conversationId: token, toolCallId: token }, required: ['owner', 'conversationId', 'toolCallId'], additionalProperties: false };
const selector = { type: 'object', properties: {
  path: { type: 'array', items: { type: 'string' }, maxItems: 8 }, fields: { type: 'array', items: { type: 'string' }, maxItems: 32 },
  start: { type: 'integer', minimum: 0, maximum: 500 }, limit: { type: 'integer', minimum: 1, maximum: 500 },
}, additionalProperties: false };
export const INTERACTIVE_PUBLISH_SCHEMA = { type: 'object', properties: {
  publication: { oneOf: [
    { type: 'object', properties: { kind: { const: 'create' } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'revise' }, base: reference }, required: ['kind', 'base'], additionalProperties: false },
  ] },
  title: { type: 'string', minLength: 1, maxLength: 160 }, textFallback: { type: 'string', minLength: 1, maxLength: 32768 },
  program: { type: 'string', minLength: 1, maxLength: 65536 },
  inputs: { type: 'array', maxItems: 16, items: { type: 'object', properties: {
    bindingId: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }, selector,
    source: { oneOf: [
      { type: 'object', properties: { kind: { const: 'tool-result' }, conversationId: token, toolCallId: token, expectedContentVersion: digest }, required: ['kind', 'conversationId', 'toolCallId', 'expectedContentVersion'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'user-material' }, messageId: token, attachmentId: token, expectedContentVersion: digest }, required: ['kind', 'messageId', 'attachmentId', 'expectedContentVersion'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'model-data' }, value: { description: 'Bounded JSON; always model-constructed, never observed Evidence.' } }, required: ['kind', 'value'], additionalProperties: false },
    ] },
  }, required: ['bindingId', 'source'], additionalProperties: false } },
}, required: ['publication', 'title', 'textFallback', 'program', 'inputs'], additionalProperties: false };
export const INTERACTIVE_INSPECT_SCHEMA = { type: 'object', properties: {
  target: { oneOf: [
    { type: 'object', properties: { kind: { const: 'result' }, reference }, required: ['kind', 'reference'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'publication' }, reference: callReference }, required: ['kind', 'reference'], additionalProperties: false },
  ] },
  view: { type: 'string', enum: ['metadata', 'text', 'program', 'data', 'evaluate'] }, bindingId: token, selector,
  followupId: token, offset: { type: 'integer', minimum: 0, maximum: L.inputBytes }, limit: { type: 'integer', minimum: 1, maximum: 4000 },
}, required: ['target', 'view'], additionalProperties: false };
function definition(capabilityId, name, schema, modes, prompt, riskLevel) {
  return { name, capabilityId, availableInModes: modes,
    runtime: { adapter: 'runtime-node.interactive-results', executorCapabilityId: capabilityId, resultReplay: capabilityId === PUBLISH ? 'query_status' : 'fresh_read' },
    permissionPolicy: { kind: 'capability-approval', requiresReviewForWrites: capabilityId === PUBLISH },
    prompt: () => prompt, inputSchema: schema,
    manifest: { capabilityId, name, description: prompt, source: 'native', riskLevel, dataLevel: 'D2_sensitive', health: 'available', inputSchema: schema,
      evidencePolicy: { returnMode: 'artifact_ref', maxChars: 4000, redactSensitive: true } } };
}
export const INTERACTIVE_TOOL_DEFINITIONS = Object.freeze([
  definition(PUBLISH, INTERACTIVE_PUBLISH_TOOL, INTERACTIVE_PUBLISH_SCHEMA, ['goal'],
    'Publish a bounded Peer interactive result as an internal user artifact of this admitted worker. Use only the current admitted catalog, fixed materials, and an explicit create or revise base. This does not write project files, refresh data, approve actions or complete a task. ReadOnly workers may publish internally with the same scoped authorization. A pending/unknown receipt requires inspect by the original publication target; never change call ID to replay it. Model data stays labelled as assumptions.', 'L2_local_write'),
  definition(INSPECT, INTERACTIVE_INSPECT_TOOL, INTERACTIVE_INSPECT_SCHEMA, ['goal', 'project_agent', 'explorer'],
    'Read an admitted fixed result or original publication receipt. Main Bot can read metadata/text only. Workers and Verifiers can inspect actual program/data and bounded pure evaluation, with new read Evidence. User conditions require an explicitly admitted frozen followup; latest UI state is never read. No publishing, state saving, source refresh, network or tool execution.', 'L1_local_read'),
]);
