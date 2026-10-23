/**
 * local-git-tools.mjs 的类型声明。
 *
 * 与 local-git-provider.d.mts 同因：.mjs 没有声明时 TypeScript 会把导出当成
 * 隐式 any，LOCAL_GIT_TOOL_DEFINITIONS[0].prompt() 的返回也就失去类型，
 * 进而污染 git-provider.ts 的 manifest.description。
 */
import type { RuntimeModeScope } from '@peer-agent/runtime-core';

export interface LocalGitToolDefinition {
  readonly name: string;
  readonly capabilityId: string;
  readonly availableInModes: readonly string[];
  readonly runtime: Readonly<Record<string, unknown>>;
  readonly permissionPolicy: Readonly<Record<string, unknown>>;
  prompt(): string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly manifest: Readonly<Record<string, unknown>>;
}

export const LOCAL_GIT_SCHEMA: Readonly<Record<string, unknown>>;
export const LOCAL_GIT_MODES: readonly RuntimeModeScope[];
export const LOCAL_GIT_TOOL_DEFINITIONS: readonly LocalGitToolDefinition[];
