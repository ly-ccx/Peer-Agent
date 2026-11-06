/**
 * local-git-provider.mjs 的类型声明。
 *
 * 该 provider 以 .mjs 实现（tsconfig.checkJs=false），没有声明文件时 TypeScript
 * 只能把导出推断成隐式 any，导致 git-provider.ts 的入参/返回值全部失去类型。
 *
 * 注意 status：.mjs 运行时返回的是 'success' | 'failed' | 'denied' | 'cancelled'
 * | 'timeout'，与 runtime-core 的 RuntimeToolStatus（'completed' | 'failed' | ...）
 * 不是同一套词表。git-provider.ts 已把它显式映射成 RuntimeToolStatus，所以这里
 * 如实声明调用方实际看到的原始词表，而不是强行套用上层契约——否则那段映射会被
 * TS 判成「不可能成立的分支」。
 */
import type { RuntimeEvidenceObject } from '@peer-agent/runtime-core';

/** .mjs 侧实际产生的状态词表（含非契约值 'success'）。 */
export type LocalGitProviderStatus = 'success' | 'failed' | 'denied' | 'cancelled' | 'timeout';

export interface LocalGitPermissionRequestInput {
  readonly filePath?: string;
  readonly [key: string]: unknown;
}

export interface LocalGitExecuteContext {
  readonly locale?: string;
  readonly toolContext?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly requestPermission?: (
    input: LocalGitPermissionRequestInput,
  ) => Promise<unknown> | unknown;
}

export interface LocalGitRawResult {
  readonly toolCallId: string;
  readonly capabilityId?: string;
  readonly status: LocalGitProviderStatus;
  readonly outputPreview?: unknown;
  readonly evidence?: RuntimeEvidenceObject;
  readonly completedAt?: string;
}

export interface LocalGitExecution {
  readonly call: readonly unknown[];
  readonly result: LocalGitRawResult;
  readonly grant: { readonly granted: boolean; readonly [key: string]: unknown };
}

export interface LocalGitProvider {
  readonly providerId: string;
  readonly capabilityIds: readonly string[];
  executeCapability(
    request: { readonly call: unknown },
    context?: LocalGitExecuteContext,
  ): Promise<LocalGitExecution | undefined>;
}

export interface CreateLocalGitProviderOptions {
  readonly workspaceRoot?: string;
  readonly artifactBaseDir?: string;
  readonly query?: (input: unknown, options?: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

export function createLocalGitProvider(
  options?: CreateLocalGitProviderOptions,
): LocalGitProvider;
