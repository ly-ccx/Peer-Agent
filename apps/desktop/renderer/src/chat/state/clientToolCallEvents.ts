import type { ChatStreamEvent, ClientToolCall, ClientToolResult } from '@peer-agent/protocol';
import { isRecord } from '../utils/records.ts';

function readString(data: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function normalizeClientToolCall(event: ChatStreamEvent): ClientToolCall | null {
  // backend 实际推的事件名是 client_tool_dispatching(见 cbu-xiaoer-node-service
  // src/service/aiChat/runtime/ClientToolEventTypes.ts CLIENT_TOOL_EVENT_NAMES)。
  // client_tool_call / client_tool_call.created 是历史 v2 路径,保留兼容,
  // 但 v3 渲染层接管 dispatch 后这俩永远不会出现 —— v2 走的是 WS 直连 main 进程。
  if (
    event.event !== 'client_tool_dispatching' &&
    event.event !== 'client_tool_call' &&
    event.event !== 'client_tool_call.created'
  ) return null;
  if (!isRecord(event.data)) return null;

  console.log('[Step2 客户端接收 normalizeClientToolCall] 收到 client_tool_call 事件，原始数据:', JSON.stringify(event.data, null, 2));

  const raw = isRecord(event.data.call) ? event.data.call : event.data;
  // policy 容器名字两边不一致:v3 dispatching payload 用 policyContext,
  // v2 created 用 policySnapshot。两个都兜底,字段名(riskLevel/dataLevel)一致。
  const policy = isRecord(raw.policyContext)
    ? raw.policyContext
    : isRecord(raw.policySnapshot) ? raw.policySnapshot : {};
  const toolCallId = readString(raw, ['toolCallId', 'callId', 'id']);
  const capabilityId = readString(raw, ['capabilityId', 'toolName', 'name']);
  if (!toolCallId || !capabilityId) return null;

  console.log('[Step2 客户端接收 normalizeClientToolCall] 解析成功 → toolCallId:', toolCallId, 'capabilityId:', capabilityId);

  // arguments 是完整参数（后端 v3 dispatching 开始携带），shell 执行必须用它。
  // argumentsPreview 只是 UI 授权卡片展示用的预览。两者都保留：
  // - arguments 给 readShellArgs 执行用
  // - argumentsPreview 给 PermissionGateStrip 展示用
  const fullArguments = isRecord(raw.arguments) ? raw.arguments
    : isRecord(raw.args) ? raw.args
    : undefined;
  const preview = isRecord(raw.argumentsPreview) ? raw.argumentsPreview : {};

  return {
    toolCallId,
    capabilityId,
    displayName: readString(raw, ['displayName', 'toolName', 'name']) ?? capabilityId,
    reason: readString(raw, ['reason', 'description'])
      ?? readString(policy, ['reason'])
      ?? 'Cloud requested a local capability.',
    arguments: fullArguments,
    argumentsPreview: Object.keys(preview).length > 0 ? preview
      : fullArguments ?? {},
    riskLevel: readString(raw, ['riskLevel']) as ClientToolCall['riskLevel']
      ?? readString(policy, ['riskLevel', 'capabilityLevel']) as ClientToolCall['riskLevel']
      ?? 'L0_inert',
    dataLevel: readString(raw, ['dataLevel']) as ClientToolCall['dataLevel']
      ?? readString(policy, ['dataLevel']) as ClientToolCall['dataLevel']
      ?? 'D0_public',
    requestedAt: readString(raw, ['occurredAt']) ?? new Date().toISOString(),
  };
}

/**
 * 方案 A：兼容云端旧协议。
 * 当云端发 `tool_call_start` 事件且 toolName 是本地能力前缀（local_*），
 * 直接从事件提取 toolCallId / arguments 构造 ClientToolCall，不依赖 polling 接口。
 * toolName 里的 `_` 分隔符会转回 capabilityId 的 `.` 。
 */
export function normalizeClientToolCallFromToolCallStart(event: ChatStreamEvent): ClientToolCall | null {
  if (event.event !== 'tool_call_start' && event.event !== 'tool_start') return null;
  if (!isRecord(event.data)) return null;

  const data = event.data;
  const toolName = readString(data, ['toolName', 'name']);
  if (!toolName || !toolName.startsWith('local_')) return null;

  const toolCallId = readString(data, ['toolCallId', 'toolId', 'callId', 'id']);
  if (!toolCallId) return null;

  const capabilityId = decodeToolNameToCapabilityId(toolName);

  console.log('[Step2 客户端接收 normalizeClientToolCallFromToolCallStart] 收到 tool_call_start 事件 → toolCallId:', toolCallId, 'toolName:', toolName, '→ capabilityId:', capabilityId);

  return {
    toolCallId,
    capabilityId,
    displayName: readString(data, ['toolDisplayName', 'displayName']) ?? capabilityId,
    reason: 'Cloud requested a local capability (decoded from tool_call_start).',
    argumentsPreview: isRecord(data.arguments)
      ? data.arguments
      : isRecord(data.args)
        ? data.args
        : {},
    riskLevel: 'L0_inert',
    dataLevel: 'D0_public',
    requestedAt: new Date().toISOString(),
  };
}

function decodeToolNameToCapabilityId(toolName: string): string {
  if (toolName.startsWith('local_skill_')) {
    return 'local.skill.' + toolName.slice('local_skill_'.length);
  }
  if (toolName === 'local_shell_exec') return 'local.shell.exec';
  if (toolName === 'local_shell_stop') return 'local.shell.stop';
  if (toolName === 'local_health') return 'local.health';
  // fallback: 采用严格全部替换
  return toolName.replaceAll('_', '.');
}

export function createUnsupportedClientToolResult(call: ClientToolCall, locale: string): ClientToolResult {
  const completedAt = new Date().toISOString();
  return {
    toolCallId: call.toolCallId,
    status: 'denied',
    outputPreview: {
      status: 'capability_not_supported',
      capabilityId: call.capabilityId,
    },
    evidence: {
      evidenceId: `evidence_${call.toolCallId}_${Date.now()}`,
      toolCallId: call.toolCallId,
      summary: locale === 'zh-CN'
        ? `客户端尚不支持 ${call.capabilityId}，已拒绝执行。`
        : `The client does not support ${call.capabilityId}; execution was denied.`,
      locale: locale === 'en-US' ? 'en-US' : 'zh-CN',
      returnedToCloud: false,
      dataLevel: call.dataLevel,
      redactions: [],
      artifactRefs: [],
    },
    completedAt,
  };
}
