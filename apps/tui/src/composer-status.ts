import type {
  ContextAccountingSnapshot,
  LocalAccessLevel,
} from '@peer-agent/protocol';

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
  /**
   * Desktop TokenUsageDisplay.tokenUsage analogue: conversation lifetime totals.
   * Prefer this when available so multi-turn cache read accumulates like Desktop.
   */
  readonly lifetimeUsage?: ComposerUsageSnapshot;
  /**
   * Desktop activeUsage analogue: in-flight turn totals not yet folded into lifetime.
   * Also used as the sole cumulative source when lifetime is unavailable.
   */
  readonly usage?: ComposerUsageSnapshot;
  /** @deprecated Kept for callers; cache hit no longer uses last-request-only usage. */
  readonly lastRequestUsage?: ComposerUsageSnapshot;
  /** ADR 56: provider-backed accounting is the only capacity source. */
  readonly contextAccounting?: ContextAccountingSnapshot;
  /** A new session with no persisted conversation history starts at 0%. */
  readonly emptyContext?: boolean;
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
  /** Short effort level for footer display, e.g. high / low / auto. */
  readonly effort: string;
  readonly reasoning: string;
  readonly cache?: string;
  readonly cachePercent?: number;
  readonly context: string;
  readonly contextShort: string;
  readonly contextPercent?: number;
}

const KNOWN_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  'gpt-5.5': 272_000,
  'gpt-5.6-sol': 272_000,
  'gpt-5.6-terra': 272_000,
  'gpt-5.6-luna': 272_000,
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

/** Desktop-aligned: lifetime tokenUsage + in-flight activeUsage. */
export function combineComposerUsage(
  lifetime?: ComposerUsageSnapshot,
  active?: ComposerUsageSnapshot,
): ComposerUsageSnapshot | undefined {
  if (!lifetime && !active) return undefined;
  const inputTokens = safeTokenCount(lifetime?.inputTokens) + safeTokenCount(active?.inputTokens);
  const cacheReadTokens = safeTokenCount(lifetime?.cacheReadTokens) + safeTokenCount(active?.cacheReadTokens);
  if (inputTokens <= 0 && cacheReadTokens <= 0) return undefined;
  return {
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
  };
}

export function resolveComposerCacheUsage(input: Pick<
  ComposerStatusInput,
  'lifetimeUsage' | 'usage' | 'lastRequestUsage'
>): ComposerUsageSnapshot | undefined {
  const combined = combineComposerUsage(input.lifetimeUsage, input.usage);
  if (combined) return combined;
  // Legacy fallback only when no lifetime/active aggregate exists.
  return input.lastRequestUsage;
}

export function cacheHitPercent(usage?: ComposerUsageSnapshot): number | undefined {
  // Align Desktop TokenUsageDisplay: only show when cacheRead > 0.
  // Missing / zero cacheRead means "no positive hit to report", not a hard 0% badge.
  if (!usage) return undefined;
  const inputTokens = safeTokenCount(usage.inputTokens);
  const cacheReadTokens = safeTokenCount(usage.cacheReadTokens);
  if (cacheReadTokens <= 0) return undefined;
  const totalInputTokens = inputTokens + cacheReadTokens;
  if (totalInputTokens <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((cacheReadTokens / totalInputTokens) * 100)));
}

function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  const unit = tokens >= 1_000_000 ? 1_000_000 : 1_000;
  const suffix = unit === 1_000_000 ? 'm' : 'k';
  const scaled = tokens / unit;
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`;
}

export function contextStatus(
  accounting: ContextAccountingSnapshot | undefined,
  contextWindow?: number,
  emptyContext = false,
): Pick<ComposerStatus, 'context' | 'contextShort' | 'contextPercent'> {
  const window = accounting?.contextWindow ?? contextWindow;
  const tokens = accounting?.authoritativeInputTokens;
  const degraded = accounting?.counterStatus === 'degraded';
  const statusMark = degraded ? '!' : '';
  if (tokens == null) {
    if (emptyContext && accounting == null) {
      return {
        context: 'context 0%',
        contextShort: 'ctx 0%',
        contextPercent: 0,
      };
    }
    const suffix = statusMark ? ` ${statusMark}` : '';
    return {
      context: `context ?${suffix}`,
      contextShort: `ctx ?${suffix}`,
    };
  }
  if (!Number.isFinite(window) || window! <= 0) {
    const suffix = statusMark ? ` ${statusMark}` : '';
    return {
      context: `context ${compactTokens(tokens)} / ?${suffix}`,
      contextShort: `ctx ${compactTokens(tokens)} / ?${suffix}`,
    };
  }

  const rawPercent = accounting?.percent ?? 0;
  const percent = Math.min(100, Math.max(0, Math.round(rawPercent)));
  const displayPercent = tokens > 0 && rawPercent < 1 ? '<1%' : `${percent}%`;
  return {
    context: `context ${displayPercent}${statusMark}`,
    contextShort: `ctx ${displayPercent}${statusMark}`,
    contextPercent: percent,
  };
}

export function createComposerStatus(input: ComposerStatusInput): ComposerStatus {
  const mode = tuiModeOption(input.mode);
  const permission = mode.readOnly
    ? permissionPolicyLabels('read_only')
    : permissionPolicyLabels(input.accessLevel ?? 'ask_before_local');
  const context = contextStatus(
    input.contextAccounting,
    input.contextWindow ?? contextWindowForModel(input.modelLabel),
    input.emptyContext,
  );
  const language = languageOption(input.locale ?? 'zh-CN');
  // Desktop TokenUsageDisplay: (tokenUsage + activeUsage), hide when cacheRead == 0.
  const cachePercent = cacheHitPercent(resolveComposerCacheUsage(input));
  return {
    workspace: compactWorkspacePath(input.workspaceRoot),
    workspaceShort: workspaceBasename(input.workspaceRoot),
    mode: mode.label.toLowerCase(),
    permission: permission.label,
    permissionShort: permission.shortLabel,
    language: language.label,
    languageShort: language.locale === 'zh-CN' ? 'zh' : 'en',
    model: modelIdFromLabel(input.modelLabel),
    effort: input.reasoningEffort?.trim() || 'auto',
    reasoning: `reasoning ${input.reasoningEffort?.trim() || 'auto'}`,
    ...(cachePercent === undefined ? {} : { cache: `cache ${cachePercent}%`, cachePercent }),
    ...context,
  };
}
