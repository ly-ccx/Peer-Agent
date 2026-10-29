import { RESOURCE_FILE_REPLACE_CAPABILITY, RESOURCE_FILE_REPLACE_PROVIDER, RESOURCE_FILE_REPLACE_TOOL } from '@peer-agent/protocol';
import { createToolRegistry } from '../tools/tool-registry.mjs';
import { createRuntimeProjectionFromToolRegistry } from '../tools/runtime-projection-tool-materializer.mjs';
const inputSchema = { type: 'object', properties: {
  requestId: { type: 'string', maxLength: 256 }, target: { type: 'object' }, content: { type: 'string', maxLength: 1048576 }, proposedVersion: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
}, required: ['requestId', 'target', 'content', 'proposedVersion'], additionalProperties: false };
export const RESOURCE_FILE_REPLACE_MANIFEST = Object.freeze({
  capabilityId: RESOURCE_FILE_REPLACE_CAPABILITY, providerId: RESOURCE_FILE_REPLACE_PROVIDER, name: RESOURCE_FILE_REPLACE_TOOL,
  description: 'Replace the current owned UTF-8 file under an exact base version, only for a host-journaled explicit human resource edit. Never grants model write access.',
  localizedName: { 'zh-CN': '提交已核对的文件草稿', 'en-US': 'Apply a versioned file draft' },
  source: 'native', riskLevel: 'L2_local_write', dataLevel: 'D2_sensitive', health: 'needs_permission', inputSchema,
  evidencePolicy: { returnMode: 'diff', maxChars: 4000, redactSensitive: true },
});
/** Deliberately absent from createDefaultToolRegistry/createRuntimeToolRegistry and model projections. */
export function createResourceFileReplaceProjection({ requestId, conversationId, sessionId, accessLevel = 'ask_before_local' }) {
  const registry = createToolRegistry({ tools: [{ name: RESOURCE_FILE_REPLACE_TOOL, capabilityId: RESOURCE_FILE_REPLACE_CAPABILITY,
    runtime: { adapter: 'runtime-gateway.local-conditional-file-provider', executorCapabilityId: RESOURCE_FILE_REPLACE_CAPABILITY },
    permissionPolicy: { kind: 'file-write', requiresReviewForWrites: true }, manifest: RESOURCE_FILE_REPLACE_MANIFEST,
    inputSchema, prompt: () => RESOURCE_FILE_REPLACE_MANIFEST.description }] });
  const projection = createRuntimeProjectionFromToolRegistry(registry, { projectionId: `resource-edit:${requestId}`, sessionId: sessionId ?? conversationId, accessLevel });
  return { registry, projection };
}
