import { createPermissionGrant } from './tool-result-factory.mjs';

export function createLocalHealthProvider({ workspaceRoot, runHealthStub }) {
  async function executeCapability(request, context = {}) {
    const call = request.call;
    const locale = context.locale ?? 'zh-CN';
    const result = await runHealthStub({
      workspaceRoot,
      toolCallId: call.toolCallId,
      locale,
    });
    return {
      call,
      grant: createPermissionGrant({
        toolCallId: call.toolCallId,
        granted: result.status === 'success',
        scope: 'local.health',
      }),
      result,
    };
  }

  return {
    providerId: 'local.health',
    capabilityIds: ['local.health'],
    executeCapability,
  };
}
