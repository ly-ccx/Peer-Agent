import { LOCAL_IMAGE_CAPABILITY, LOCAL_IMAGE_TOOL } from '@peer-agent/protocol';

export const LOCAL_IMAGE_TOOL_DEFINITIONS = [{
  name: LOCAL_IMAGE_TOOL,
  capabilityId: LOCAL_IMAGE_CAPABILITY,
  availableInModes: ['chat', 'plan', 'goal', 'explorer', 'project_agent'],
  runtime: { adapter: 'runtime-node.local-image-provider', executorCapabilityId: LOCAL_IMAGE_CAPABILITY, resultReplay: 'fresh_read' },
  permissionPolicy: { kind: 'file-read', requiresReviewForWrites: false },
  prompt: () => 'Read a local PNG, JPEG, GIF or WebP image and send its actual pixels to the current vision model. Use this for existing screenshots and product regression packets, including in background work and independent review. Supply an absolute path or a path relative to the workspace. Each call reads one image (at most 8 MiB and 24 million pixels). Outside admitted read roots requires local authorization. The result contains metadata and a transient image; read_file only reads text. Re-read the source after checkpoint recovery. Inspect every required screenshot before writing review.json and running product verification; distinguish self-review from independent review.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
  manifest: {
    capabilityId: LOCAL_IMAGE_CAPABILITY, name: LOCAL_IMAGE_TOOL,
    description: 'Read an authorized local image as model visual context.', source: 'native',
    riskLevel: 'L1_local_read', dataLevel: 'D2_sensitive', health: 'available',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
    evidencePolicy: { returnMode: 'artifact_ref', maxChars: 4000, redactSensitive: true },
  },
}];
