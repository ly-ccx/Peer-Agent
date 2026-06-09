import type { ClientToolCall, ClientToolResult, LocaleCode } from '@peer-agent/protocol';

export function markClientToolResultReturnedToCloud(result: ClientToolResult): ClientToolResult {
  if (result.evidence.returnedToCloud) return result;
  return {
    ...result,
    evidence: {
      ...result.evidence,
      returnedToCloud: true,
    },
  };
}

export function createFailedClientToolResult(params: {
  readonly call: ClientToolCall;
  readonly locale: LocaleCode;
  readonly message: string;
  readonly completedAt?: string;
}): ClientToolResult {
  const completedAt = params.completedAt ?? new Date().toISOString();
  return {
    toolCallId: params.call.toolCallId,
    status: 'failed',
    outputPreview: {
      status: 'client_execution_failed',
      capabilityId: params.call.capabilityId,
      message: params.message,
    },
    evidence: {
      evidenceId: `evidence_${params.call.toolCallId}_${Date.now()}`,
      toolCallId: params.call.toolCallId,
      summary: params.locale === 'zh-CN'
        ? `本地能力 ${params.call.capabilityId} 执行失败：${params.message}`
        : `Local capability ${params.call.capabilityId} failed: ${params.message}`,
      locale: params.locale,
      returnedToCloud: false,
      dataLevel: params.call.dataLevel,
      redactions: [],
      artifactRefs: [],
    },
    completedAt,
  };
}

export function createDeniedClientToolResult(params: {
  readonly call: ClientToolCall;
  readonly locale: LocaleCode;
  readonly completedAt?: string;
}): ClientToolResult {
  const completedAt = params.completedAt ?? new Date().toISOString();
  return {
    toolCallId: params.call.toolCallId,
    status: 'denied',
    outputPreview: {
      status: 'client_denied_by_user',
      capabilityId: params.call.capabilityId,
    },
    evidence: {
      evidenceId: `evidence_${params.call.toolCallId}_${Date.now()}`,
      toolCallId: params.call.toolCallId,
      summary: params.locale === 'zh-CN'
        ? `用户拒绝执行本地能力 ${params.call.capabilityId}。`
        : `The user denied local capability ${params.call.capabilityId}.`,
      locale: params.locale,
      returnedToCloud: false,
      dataLevel: params.call.dataLevel,
      redactions: [],
      artifactRefs: [],
    },
    completedAt,
  };
}
