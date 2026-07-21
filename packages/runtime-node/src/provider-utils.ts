import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  appendEvidenceRecords,
  appendHookEvidence,
  createEvidenceBundle,
  type PermissionGrant,
  type RuntimeDecision,
  type RuntimeToolResult,
} from '@peer-agent/runtime-core';
import type {
  RuntimeSdkHookRecord,
  RuntimeSdkToolCall,
  RuntimeSdkToolResult,
} from '@peer-agent/runtime-sdk';

export interface NodeProviderRuntimeClock {
  readonly now: () => string;
  readonly idFactory: () => string;
}

export type NodeProviderToolResult = RuntimeToolResult
  & RuntimeSdkToolResult
  & Readonly<Record<string, unknown>>;

export function createProviderRuntimeClock(options: {
  readonly now?: () => string;
  readonly idFactory?: () => string;
} = {}): NodeProviderRuntimeClock {
  return {
    now: options.now ?? (() => new Date().toISOString()),
    idFactory: options.idFactory ?? randomUUID,
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Resolve a tool path against the session workspace root.
 *
 * Product decision (2026-07-21): no path hard sandbox.
 * - Relative paths stay workspace-relative (default productivity anchor).
 * - Absolute paths may point anywhere on the machine; permission gates still apply upstream.
 * - Does NOT throw `path_outside_workspace`.
 */
export function resolveWorkspacePath(workspaceRoot: string, inputPath: unknown): string {
  const root = resolve(workspaceRoot);
  const candidate = typeof inputPath === 'string' && inputPath.trim()
    ? inputPath.trim()
    : '.';
  // path.resolve: absolute candidate ignores root; relative candidate joins under root.
  return resolve(root, candidate);
}

export function createNodePermissionGrant({
  clock,
  call,
  decision,
  reason,
  metadata,
}: {
  readonly clock: NodeProviderRuntimeClock;
  readonly call: RuntimeSdkToolCall;
  readonly decision: RuntimeDecision;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): PermissionGrant {
  return {
    grantId: clock.idFactory(),
    capabilityId: call.capabilityId,
    decision,
    grantedAt: clock.now(),
    source: 'runtime-node',
    ...(reason ? { reason } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function createNodeToolResult({
  clock,
  call,
  status,
  summary,
  output,
  outputPreview,
  grant,
  error,
  dataLevel = 'D1_internal',
  artifactRefs = [],
  metadata,
}: {
  readonly clock: NodeProviderRuntimeClock;
  readonly call: RuntimeSdkToolCall;
  readonly status: RuntimeToolResult['status'];
  readonly summary: string;
  readonly output?: unknown;
  readonly outputPreview?: unknown;
  readonly grant?: PermissionGrant;
  readonly error?: RuntimeToolResult['error'];
  readonly dataLevel?: string;
  readonly artifactRefs?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}): NodeProviderToolResult {
  const result: NodeProviderToolResult = {
    toolCallId: call.toolCallId,
    capabilityId: call.capabilityId,
    status,
    ...(output === undefined ? {} : { output }),
    ...(outputPreview === undefined ? {} : { outputPreview }),
    ...(grant ? { permissionGrant: grant } : {}),
    evidence: createEvidenceBundle({
      evidenceId: clock.idFactory(),
      toolCallId: call.toolCallId,
      summary,
      dataLevel,
      artifactRefs,
      metadata: {
        capabilityId: call.capabilityId,
        status,
        ...(metadata ?? {}),
      },
    }) as RuntimeToolResult['evidence'],
    ...(error ? { error } : {}),
    ...(metadata ? { metadata } : {}),
  };
  return result;
}

export function createNodeResultFactory(clock: NodeProviderRuntimeClock) {
  return {
    createPermissionGrant({
      toolCallId,
      granted,
      scope,
    }: {
      readonly toolCallId: string;
      readonly granted: boolean;
      readonly scope: string;
    }) {
      return {
        grantId: clock.idFactory(),
        toolCallId,
        capabilityId: scope,
        decision: granted ? 'allow' : 'deny',
        granted,
        grantedAt: clock.now(),
        source: 'runtime-node',
      };
    },
    createFailedResult({
      call,
      reason,
      dataLevel,
    }: {
      readonly call: RuntimeSdkToolCall;
      readonly reason: string;
      readonly dataLevel: unknown;
    }): RuntimeSdkToolResult {
      return createNodeToolResult({
        clock,
        call,
        status: reason.includes('denied') ? 'denied' : 'failed',
        summary: `Node capability failed: ${reason}.`,
        error: { code: reason, message: reason, recoverable: true },
        dataLevel: typeof dataLevel === 'string' ? dataLevel : 'D1_internal',
      });
    },
  };
}

export function appendNodeHookEvidence(
  result: RuntimeSdkToolResult,
  records: readonly RuntimeSdkHookRecord[],
  finalDecision: RuntimeDecision,
  clock: NodeProviderRuntimeClock,
): RuntimeSdkToolResult {
  const withRecords = appendEvidenceRecords(
    result,
    records.map((record) => ({
      kind: 'hook',
      source: 'runtime-node-hook',
      createdAt: clock.now(),
      capabilityId: typeof record.capabilityId === 'string' ? record.capabilityId : undefined,
      message: typeof record.reason === 'string' ? record.reason : undefined,
      data: record,
    })),
  );
  return appendHookEvidence(withRecords, records, finalDecision, { recordedAt: clock.now() });
}
