import { INTERACTIVE_TOOL_DEFINITIONS, interactiveCapabilitiesForProfile } from '@peer-agent/runtime-node/interactive-results';
import { createFailedClientToolResult } from '../runtime-gateway/tool-result-factory.mjs';

let current = null;

/** Installed only by the composition root that owns the canonical stores and lease. */
export function installDesktopInteractiveRuntime(port) {
  current = port;
  return () => { if (current === port) current = null; };
}
export function desktopInteractiveToolDefinitions(profile) {
  if (!profile?.workspaceId || current?.enabled(profile.workspaceId) !== true) return [];
  const allowed = interactiveCapabilitiesForProfile(profile);
  return INTERACTIVE_TOOL_DEFINITIONS.filter(tool => allowed.includes(tool.capabilityId));
}
export function interactiveMaterialCaptureEnabled(toolContext) {
  return toolContext?.turnProfile?.agentKind === 'worker'
    && desktopInteractiveToolDefinitions(toolContext.turnProfile).some(tool => tool.capabilityId === 'local.interactive.publish');
}
export function captureDesktopInteractiveExecution(execution, toolContext) {
  return current?.runtime.captureExecution(execution, toolContext) ?? execution;
}
export function desktopInteractiveUserMaterials(toolContext) {
  return interactiveMaterialCaptureEnabled(toolContext) ? current.runtime.userMaterialNotices(toolContext) : [];
}
export function createDesktopInteractiveProvider() {
  return { providerId: 'desktop-interactive-results', capabilityIds: INTERACTIVE_TOOL_DEFINITIONS.map(tool => tool.capabilityId),
    executeCapability(request, context) {
      if (current) return current.runtime.provider.executeCapability(request, context);
      return { call: request.call, result: createFailedClientToolResult({ call: request.call, locale: context?.locale ?? 'zh-CN', reason: 'interactive_authority_unavailable', status: 'denied' }) };
    } };
}
