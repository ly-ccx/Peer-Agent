import { randomUUID } from 'node:crypto';
import { createEvidenceBundle } from '@peer-agent/runtime-core';

export function nowIso() {
  return new Date().toISOString();
}

export function createPermissionGrant({
  toolCallId,
  granted,
  scope,
  duration = granted ? 'once' : 'denied',
}) {
  return {
    grantId: randomUUID(),
    toolCallId,
    granted: Boolean(granted),
    duration,
    scope,
    decidedAt: nowIso(),
  };
}

export function createFailedClientToolResult({
  call,
  locale,
  reason,
  dataLevel = 'D0_public',
  status = 'failed',
}) {
  return {
    toolCallId: call.toolCallId,
    status,
    outputPreview: {
      status,
      reason,
      capabilityId: call.capabilityId,
    },
    evidence: createEvidenceBundle({
      evidenceId: randomUUID(),
      toolCallId: call.toolCallId,
      summary: locale === 'zh-CN'
        ? `本地能力执行失败：${reason}。`
        : `Local capability failed: ${reason}.`,
      locale,
      dataLevel,
    }),
    completedAt: nowIso(),
  };
}
