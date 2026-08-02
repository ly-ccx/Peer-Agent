import { randomUUID } from 'node:crypto';
import { callMcpTool } from './mcp-client.mjs';
import { createFailedClientToolResult, createPermissionGrant, nowIso } from './tool-result-factory.mjs';

const MCP_CAPABILITY_PREFIX = 'local.mcp.';
const MCP_RISK_ORDER = {
  L0_inert: 0,
  L1_local_read: 1,
  L2_local_write: 2,
  L3_external_write: 3,
  L4_privileged: 4,
  L5_destructive: 5,
};

function parseMcpCapabilityId(capabilityId) {
  if (!String(capabilityId ?? '').startsWith(MCP_CAPABILITY_PREFIX)) return null;
  const rest = capabilityId.slice(MCP_CAPABILITY_PREFIX.length);
  // capabilityId is built as `local.mcp.${server.id}.${toolName}` (see mcp-registry.mjs).
  // server.id is derived from the server host and may contain dots, while toolName does not,
  // so split on the LAST dot to keep the dotted server.id intact.
  const dotIndex = rest.lastIndexOf('.');
  if (dotIndex < 0) return null;
  return { serverId: rest.slice(0, dotIndex), toolName: rest.slice(dotIndex + 1) };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function previewText(text, max = 4_000) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;
}

function getAuthContext(server) {
  const auth = server?.auth && typeof server.auth === 'object' ? server.auth : { mode: 'none' };
  return {
    mode: typeof auth.mode === 'string' ? auth.mode : 'none',
    credentialRef: typeof auth.credentialRef === 'string' ? auth.credentialRef : undefined,
    headerName: typeof auth.headerName === 'string' ? auth.headerName : undefined,
    envName: typeof auth.envName === 'string' ? auth.envName : undefined,
    hasCredential: Boolean(auth.credentialRef),
  };
}

function findMcpTool(server, toolName) {
  return (server?.tools ?? []).find((candidate) => (candidate.name ?? candidate.toolName) === toolName) ?? null;
}

function normalizeRiskLevel(value, fallback = 'L3_external_write') {
  return Object.prototype.hasOwnProperty.call(MCP_RISK_ORDER, value) ? value : fallback;
}

function mcpEffectForRisk(riskLevel) {
  return (MCP_RISK_ORDER[riskLevel] ?? MCP_RISK_ORDER.L3_external_write) >= MCP_RISK_ORDER.L3_external_write
    ? 'mutation'
    : 'read';
}

function buildCallScope({ server, toolName, tool }) {
  const riskLevel = normalizeRiskLevel(tool?.riskLevel);
  return {
    kind: 'mcp-tool',
    serverId: server.id,
    serverName: server.displayName,
    toolName,
    transport: server.transport,
    authMode: getAuthContext(server).mode,
    locality: 'local',
    riskLevel,
    effect: mcpEffectForRisk(riskLevel),
  };
}

function isToolVisible(server, toolName) {
  const tool = findMcpTool(server, toolName);
  if (!tool) return false;
  return (server.toolVisibility?.[toolName] ?? server.policy?.visibleByDefault ?? true) !== false;
}

function permissionGrantFromDecision({ decision, fallbackGrant, call, scope }) {
  const candidate = decision?.permissionGrant ?? decision?.grant;
  if (candidate && typeof candidate === 'object') {
    return {
      ...fallbackGrant,
      ...candidate,
      toolCallId: candidate.toolCallId ?? call.toolCallId,
      scope: candidate.scope ?? scope,
      granted: Boolean(candidate.granted),
    };
  }
  if (decision && typeof decision === 'object' && Object.prototype.hasOwnProperty.call(decision, 'granted')) {
    return createPermissionGrant({
      toolCallId: call.toolCallId,
      granted: Boolean(decision.granted),
      scope,
    });
  }
  return fallbackGrant;
}

function createMcpEvidence({ call, server, toolName, result, locale, authContext }) {
  const isError = Boolean(result?.isError);
  const auth = authContext ?? getAuthContext(server);
  return {
    evidenceId: randomUUID(),
    toolCallId: call.toolCallId,
    summary: locale === 'zh-CN'
      ? `MCP 工具 ${server.displayName}/${toolName} 已${isError ? '返回错误' : '执行完成'}。`
      : `MCP tool ${server.displayName}/${toolName} ${isError ? 'returned an error' : 'completed'}.`,
    locale,
    returnedToCloud: true,
    dataLevel: 'D2_sensitive',
    redactions: [],
    artifactRefs: [],
    origin: {
      providerId: server.id,
      transport: server.transport,
      toolName,
      authMode: auth.mode ?? 'none',
      hasCredential: Boolean(auth.credentialRef || auth.hasCredential),
    },
  };
}

export function createLocalMcpProvider({ mcpRegistry, credentialResolver = null }) {
  async function executeCapability(request, context = {}) {
    const call = request?.call;
    const locale = context.locale ?? 'en-US';
    if (!call) return null;
    const parsed = parseMcpCapabilityId(call.capabilityId);
    if (!parsed) {
      return {
        call,
        result: createFailedClientToolResult({
          call,
          locale,
          reason: `Invalid MCP capability id: ${call.capabilityId}`,
          dataLevel: 'D0_public',
        }),
      };
    }

    const server = mcpRegistry?.getServer(parsed.serverId);
    if (!server) {
      return {
        call,
        result: createFailedClientToolResult({
          call,
          locale,
          reason: `MCP server not found: ${parsed.serverId}`,
          dataLevel: 'D0_public',
        }),
      };
    }
    if (server.enabled === false || server.policy?.trusted === false || server.health?.status === 'failed') {
      return {
        call,
        result: createFailedClientToolResult({
          call,
          locale,
          reason: `MCP server is not executable: ${server.displayName}`,
          dataLevel: 'D0_public',
          status: 'denied',
        }),
      };
    }
    if (!isToolVisible(server, parsed.toolName)) {
      return {
        call,
        result: createFailedClientToolResult({
          call,
          locale,
          reason: `MCP tool is not visible in Runtime Projection: ${parsed.toolName}`,
          dataLevel: 'D0_public',
          status: 'denied',
        }),
      };
    }

    const toolManifest = findMcpTool(server, parsed.toolName);
    const riskLevel = normalizeRiskLevel(toolManifest?.riskLevel);
    const dataLevel = typeof toolManifest?.dataLevel === 'string' && toolManifest.dataLevel.trim()
      ? toolManifest.dataLevel.trim()
      : 'D2_sensitive';
    const scope = buildCallScope({ server, toolName: parsed.toolName, tool: toolManifest });
    let permissionGrant = createPermissionGrant({
      toolCallId: call.toolCallId,
      granted: true,
      scope,
    });

    if (server.policy?.requirePermission !== false && typeof context.requestPermission === 'function') {
      const decision = await context.requestPermission({
        toolCallId: call.toolCallId,
        capabilityId: call.capabilityId,
        toolName: parsed.toolName,
        args: call.arguments ?? call.args ?? {},
        scope,
        riskLevel,
        dataLevel,
        reason: scope.effect === 'mutation'
          ? `MCP mutation tool ${server.displayName}/${parsed.toolName}`
          : `MCP read tool ${server.displayName}/${parsed.toolName}`,
      });
      permissionGrant = permissionGrantFromDecision({ decision, fallbackGrant: permissionGrant, call, scope });
      if (decision?.granted === false || permissionGrant?.granted === false) {
        return {
          call,
          permissionGrant,
          result: createFailedClientToolResult({
            call,
            locale,
            reason: `Permission denied for MCP tool ${server.displayName}/${parsed.toolName}`,
            dataLevel: 'D0_public',
            status: 'denied',
          }),
        };
      }
    }

    try {
      const result = await callMcpTool(server, parsed.toolName, call.arguments ?? call.args ?? {}, { credentialResolver });
      const outputText = result?.text || safeStringify(result?.content ?? result?.raw ?? '');
      const status = result?.isError ? 'failed' : 'success';
      return {
        call,
        permissionGrant,
        result: {
          toolCallId: call.toolCallId,
          status,
          outputPreview: {
            status,
            text: previewText(outputText),
            isError: Boolean(result?.isError),
            structuredContent: result?.structuredContent ?? null,
            capabilityId: call.capabilityId,
            serverId: server.id,
            toolName: parsed.toolName,
          },
          output: result?.structuredContent ?? result?.raw ?? result?.content ?? outputText,
          evidence: createMcpEvidence({ call, server, toolName: parsed.toolName, result, locale }),
          completedAt: nowIso(),
        },
      };
    } catch (error) {
      return {
        call,
        permissionGrant,
        result: createFailedClientToolResult({
          call,
          locale,
          reason: error?.message || `MCP tool ${parsed.toolName} execution failed`,
          dataLevel: 'D2_sensitive',
        }),
      };
    }
  }

  return {
    providerId: 'local-mcp',
    capabilityPrefix: MCP_CAPABILITY_PREFIX,
    executeCapability,
  };
}
