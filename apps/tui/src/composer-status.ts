import type { LocalAccessLevel } from '@peer-agent/protocol';

import { permissionPolicyLabels } from './tui-permission-policy.ts';
import type { TuiMode } from './tui-mode.ts';
import { tuiModeOption } from './tui-mode.ts';
import { languageOption, type TuiLocale } from './tui-language.ts';

export interface ComposerUsageSnapshot {
  readonly inputTokens?: number;
  readonly cacheReadTokens?: number;
}

export interface ComposerStatusInput {
  readonly workspaceRoot: string;
  readonly mode: TuiMode;
  readonly accessLevel?: LocalAccessLevel;
  readonly locale?: TuiLocale;
  readonly modelLabel: string;
  readonly reasoningEffort?: string;
  readonly contextWindow?: number;
  readonly usage?: ComposerUsageSnapshot;
  /** Estimated input tokens for the next final provider request. */
  readonly nextRequestInputTokens?: number;
}

export interface ComposerStatus {
  readonly workspace: string;
  readonly workspaceShort: string;
  readonly mode: string;
  readonly permission: string;
  readonly permissionShort: string;
  readonly language: string;
  readonly languageShort: string;
  readonly model: string;
  readonly reasoning: string;
  readonly context: string;
  readonly contextShort: string;
  readonly contextPercent?: number;
}

const KNOWN_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  'gpt-5.5': 258_000,
  'gpt-5.6-sol': 353_000,
  'gpt-5.6-terra': 353_000,
  'gpt-5.6-luna': 353_000,
});

function cleanPath(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, '');
  return normalized || path.trim() || '.';
}

export function compactWorkspacePath(workspaceRoot: string): string {
  return cleanPath(workspaceRoot)
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~');
}

export function workspaceBasename(workspaceRoot: string): string {
  const compact = compactWorkspacePath(workspaceRoot);
  return compact.split(/[\\/]/).filter(Boolean).at(-1) ?? compact;
}

export function modelIdFromLabel(modelLabel: string): string {
  return modelLabel.split(' · ', 1)[0]?.trim() || 'model not configured';
}

export function contextWindowForModel(modelLabel: string): number | undefined {
  return KNOWN_CONTEXT_WINDOWS[modelIdFromLabel(modelLabel).toLowerCase()];
}

function safeTokenCount(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 0;
}

export function contextTokensFromUsage(usage: ComposerUsageSnapshot | undefined): number {
  return safeTokenCount(usage?.inputTokens) + safeTokenCount(usage?.cacheReadTokens);
}

function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  const unit = tokens >= 1_000_000 ? 1_000_000 : 1_000;
  const suffix = unit === 1_000_000 ? 'm' : 'k';
  const scaled = tokens / unit;
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`;
}

export function contextStatus(
  usage: ComposerUsageSnapshot | undefined,
  contextWindow: number | undefined,
  nextRequestInputTokens?: number,
): Pick<ComposerStatus, 'context' | 'contextShort' | 'contextPercent'> {
  // Display the next final request projection. Provider usage is only a fallback
  // for legacy/restored snapshots that do not yet carry the projection.
  const usageTokens = contextTokensFromUsage(usage);
  const tokens = Number.isFinite(nextRequestInputTokens) && (nextRequestInputTokens as number) >= 0
    ? Math.floor(nextRequestInputTokens as number)
    : usageTokens;
  if (!Number.isFinite(contextWindow) || contextWindow! <= 0) {
    return {
      context: `context ${compactTokens(tokens)} / ?`,
      contextShort: `ctx ${compactTokens(tokens)} / ?`,
    };
  }

  const rawPercent = (tokens / contextWindow!) * 100;
  const percent = Math.min(100, Math.max(0, Math.round(rawPercent)));
  const displayPercent = tokens > 0 && rawPercent < 1 ? '<1%' : `${percent}%`;
  return {
    context: `context ${displayPercent}`,
    contextShort: `ctx ${displayPercent}`,
    contextPercent: percent,
  };
}

export function createComposerStatus(input: ComposerStatusInput): ComposerStatus {
  const mode = tuiModeOption(input.mode);
  const permission = mode.readOnly
    ? permissionPolicyLabels('read_only')
    : permissionPolicyLabels(input.accessLevel ?? 'ask_before_local');
  const context = contextStatus(
    input.usage,
    input.contextWindow ?? contextWindowForModel(input.modelLabel),
    input.nextRequestInputTokens,
  );
  const language = languageOption(input.locale ?? 'zh-CN');
  return {
    workspace: compactWorkspacePath(input.workspaceRoot),
    workspaceShort: workspaceBasename(input.workspaceRoot),
    mode: mode.label.toLowerCase(),
    permission: permission.label,
    permissionShort: permission.shortLabel,
    language: language.label,
    languageShort: language.locale === 'zh-CN' ? 'zh' : 'en',
    model: modelIdFromLabel(input.modelLabel),
    reasoning: `reasoning ${input.reasoningEffort?.trim() || 'auto'}`,
    ...context,
  };
}
