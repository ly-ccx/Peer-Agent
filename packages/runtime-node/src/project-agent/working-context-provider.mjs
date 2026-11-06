import { createEvidenceBundle } from '@peer-agent/runtime-core';
import { createPermissionGrant } from '../tool-result-factory.mjs';
import { executionView } from './execution-context.mjs';
import { createWorkingContext } from './working-context.mjs';
import { CONTINUITY_TOOL_SPECS } from './working-context-specs.mjs';

export function createWorkingContextProvider(options = {}) {
  const context = createWorkingContext(options);
  return { providerId: 'local.continuity', capabilityIds: CONTINUITY_TOOL_SPECS.map(spec => spec.capabilityId),
    async executeCapability(request, hostContext = {}) {
      const call = request.call, spec = CONTINUITY_TOOL_SPECS.find(item => item.capabilityId === call.capabilityId);
      const view = executionView(hostContext);
      const locale = hostContext.locale === 'en-US' ? 'en-US' : 'zh-CN';
      let output, status;
      try {
        const input = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments || {};
        if (!spec || !input || typeof input !== 'object' || Array.isArray(input)
          || (spec.inputSchema.required || []).some(key => !Object.hasOwn(input, key))
          || Object.keys(input).some(key => !Object.hasOwn(spec.inputSchema.properties, key))
          || Object.entries(input).some(([key, value]) => {
            const schema = spec.inputSchema.properties[key];
            return schema.type === 'string' ? typeof value !== 'string' || value.length > schema.maxLength
              : schema.type === 'integer' ? !Number.isSafeInteger(value) || value < (schema.minimum || 0) || value > (schema.maximum ?? Infinity)
                : !Array.isArray(value) || value.length > schema.maxItems || value.some(item => typeof item !== 'string' || item.length > schema.items.maxLength);
          })) throw new Error('working_context_input_invalid');
        output = await context.execute(spec.name, input, view, `${view.turnId}:${call.toolCallId}`);
        status = 'success';
      } catch (error) { status = 'failed'; output = { ok: false, error: error.code || error.message }; }
      return { call, grant: { ...createPermissionGrant({ toolCallId: call.toolCallId, granted: status === 'success', scope: call.capabilityId }), reason: 'scoped_working_context' },
        result: { toolCallId: call.toolCallId, capabilityId: call.capabilityId, status, output,
          outputPreview: { status, tool: spec?.name || 'working_context', legacyResult: { success: status === 'success', output: JSON.stringify(output) } },
          evidence: createEvidenceBundle({ evidenceId: `working-context:${call.toolCallId}`, toolCallId: call.toolCallId,
            summary: `${spec?.name || 'working_context'}: ${output.error || status}`, locale, returnedToCloud: false, dataLevel: 'D1_internal' }),
          completedAt: new Date().toISOString() } };
    } };
}
