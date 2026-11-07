import path from 'node:path';
import { createLocalToolHost } from '../runtime-gateway/local-tool-host.mjs';
import { createProjectAgentApplicationService } from './project-agent-application-service.mjs';
import { installDelegation, liveDelegationSupervisor } from './delegation-port.mjs';
import { rehearseLegacyObligations } from '../../../../../packages/runtime-node/src/project-agent/obligation-legacy-rehearsal.mjs';

/**
 * Same three legacy records, through the desktop supervisor bridge and local tool host.
 * The card list and confirm use the application service, which is what the renderer IPC calls.
 */
export async function rehearseLegacyObligationsOnDesktop({ rootDir }) {
  let uninstall = () => {};
  let host = null;
  try {
    return await rehearseLegacyObligations({
      rootDir,
      bridgeSupervisor(raw) {
        uninstall = installDelegation({ supervisor: raw });
        host = createLocalToolHost({
          workspaceRoot: path.join(rootDir, 'workspace'),
          userDataPath: rootDir,
          sessionStore: { getSession: () => ({ locale: 'zh-CN' }) },
          hookRunner: { runPreToolUse: async () => [], runPostToolUse: async () => [] },
        });
        return liveDelegationSupervisor();
      },
      executeTool({ capabilityId, args, toolCallId }) {
        return host.execute({
          sessionId: 'parent',
          projectionId: 'projection-legacy',
          conversationId: 'parent',
          call: { toolCallId, capabilityId, arguments: args, dataLevel: 'D1_internal' },
        }, {
          mode: 'project_agent',
          role: 'project_agent',
          workspaceId: 'workspace',
          conversationId: 'parent',
          turnId: 'turn-legacy',
          toolCallOrdinal: 1,
        });
      },
      async confirmGrant({ raw, grantId }) {
        const app = createProjectAgentApplicationService({ enabled: () => true, sessions: raw });
        const listed = await app.listObligationGrants({ workspaceId: 'workspace' });
        const grants = Array.isArray(listed?.grants) ? listed.grants : [];
        const grant = grants.find(item => item.grantId === grantId && item.status === 'pending');
        if (!grant) return { ok: false, error: listed?.code || 'grant_not_listed', grants: grants.map(item => ({ grantId: item.grantId, status: item.status })) };
        const decided = await app.decideObligation({ workspaceId: 'workspace', grantId, decision: 'confirm' });
        const rejected = decided?.items?.find(item => item.result !== 'applied' && item.result !== 'replayed');
        return {
          ok: decided?.ok === true && !rejected,
          status: 'confirmed',
          error: rejected?.code || decided?.error || decided?.code || null,
          grant,
          grants: grants.map(item => ({ grantId: item.grantId, status: item.status, items: item.items?.length || 0 })),
          resolution: decided?.items?.map(item => item.result || item.code) || null,
        };
      },
    });
  } finally {
    host?.unsubscribeRuntimeEvents?.();
    uninstall();
  }
}
