import { DESKTOP_PREVIEW_CAPABILITY, DESKTOP_PREVIEW_TOOL } from '@peer-agent/protocol';

export const DESKTOP_PREVIEW_TOOL_DEFINITIONS = [{
  name: DESKTOP_PREVIEW_TOOL,
  capabilityId: DESKTOP_PREVIEW_CAPABILITY,
  availableInModes: ['chat', 'goal'],
  runtime: { adapter: 'runtime-gateway.local-desktop-preview-provider', executorCapabilityId: DESKTOP_PREVIEW_CAPABILITY },
  // A build and child process are effects; never project as read-only browser work.
  permissionPolicy: { kind: 'shell', requiresReviewForWrites: true },
  prompt: () => 'Build and open (open), capture (observe), or close (close) a separate Peer Desktop development preview. Chat and Goal may both call this, but planId is required and must belong to the current conversation. Empty test data; never controls the running host or arbitrary windows. Open builds the workspace. Observe returns a validated PNG artifact; the host starts independent visual review afterwards. A screenshot, chat reply, or empty judgment is not a pass. Close only releases this owned instance. Requires explicit local permission; not available in packaged builds.',
  inputSchema: { type: 'object', properties: {
    planId: { type: 'string', description: 'Existing plan that belongs to this conversation. Required for open, observe, and close.' },
    action: { type: 'string', enum: ['open', 'observe', 'close'] },
    scene: { type: 'string', enum: ['application', 'background-runtime'], description: 'Observe only. background-runtime opens the real background runs panel in the owned preview; no tasks are started or stopped. Omit for a general window capture.' },
  }, required: ['planId', 'action'], additionalProperties: false },
}];
