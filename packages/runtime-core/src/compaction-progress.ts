import { CONTEXT_PROJECTION_CONFIG } from './context-projection.ts';

/**
 * Shared compaction UI progress estimator.
 *
 * percent = receivedChars / estimateSummaryChars(...)
 * This is the single source for Desktop banner + CLI/TUI compacting status.
 */
export const COMPACTION_PROGRESS_CONFIG = Object.freeze({
  // Semantic summary length ≈ input length × compression ratio.
  summaryCompressionRatio: 0.12,
  // Floor so tiny inputs do not instantly fill the bar.
  minEstimatedSummaryChars: 1_200,
  // When received approaches/overshoots the estimate, expand the denominator.
  expandFactor: 1.05,
  // Live streaming never reports 100%; only the done signal does.
  maxLivePercent: 99,
  // Fallback physical cap when caller omits maxSummaryChars.
  defaultMaxSummaryChars: 12_000 * CONTEXT_PROJECTION_CONFIG.charsPerToken,
  // Soft stage floors used before any summary tokens arrive.
  stageStartedPercent: 8,
  stagePreparedPercent: 15,
  stagePostProcessPercent: 99,
});

export type EstimateSummaryCharsInput = Readonly<{
  inputChars: number;
  maxSummaryChars: number;
  receivedChars?: number;
}>;

/**
 * Estimate the summary output length used as the progress bar denominator.
 *
 * - base = inputChars × summaryCompressionRatio
 * - clamp to [minEstimatedSummaryChars, maxSummaryChars]
 * - if receivedChars approaches/overshoots the estimate, expand the denominator
 *   so percent stays monotonic and does not hit 100% before done
 */
export function estimateSummaryChars(input: EstimateSummaryCharsInput): number {
  const safeInput = Number.isFinite(input.inputChars) && input.inputChars > 0 ? input.inputChars : 0;
  const minChars = COMPACTION_PROGRESS_CONFIG.minEstimatedSummaryChars;
  const upperBound =
    Number.isFinite(input.maxSummaryChars) && input.maxSummaryChars > minChars
      ? input.maxSummaryChars
      : Math.max(minChars, COMPACTION_PROGRESS_CONFIG.defaultMaxSummaryChars);

  let estimate = Math.round(safeInput * COMPACTION_PROGRESS_CONFIG.summaryCompressionRatio);
  estimate = Math.min(upperBound, Math.max(minChars, estimate));

  const receivedChars =
    Number.isFinite(input.receivedChars) && (input.receivedChars ?? 0) > 0
      ? Number(input.receivedChars)
      : 0;
  if (receivedChars > 0) {
    const expanded = Math.ceil(receivedChars * COMPACTION_PROGRESS_CONFIG.expandFactor);
    estimate = Math.min(upperBound, Math.max(estimate, expanded));
  }

  return Math.max(minChars, estimate);
}

export type EstimateCompactionProgressPercentInput = Readonly<{
  inputChars: number;
  maxSummaryChars: number;
  receivedChars: number;
  /** When true, always return 100. */
  done?: boolean;
  /**
   * Optional floor so pre-stream stage markers (started/prepared) do not
   * regress when the first streamed chars produce a lower percent.
   */
  minPercent?: number;
}>;

/**
 * Convert received/estimated summary chars into a 0–100 UI percent.
 * Live progress is capped at maxLivePercent; only `done` returns 100.
 */
export function estimateCompactionProgressPercent(
  input: EstimateCompactionProgressPercentInput,
): number {
  if (input.done) return 100;

  const received =
    Number.isFinite(input.receivedChars) && input.receivedChars > 0 ? input.receivedChars : 0;
  if (received <= 0) {
    const floor =
      typeof input.minPercent === 'number' && Number.isFinite(input.minPercent)
        ? Math.max(0, Math.min(COMPACTION_PROGRESS_CONFIG.maxLivePercent, Math.round(input.minPercent)))
        : 0;
    return floor;
  }

  const estimatedTotalChars = estimateSummaryChars({
    inputChars: input.inputChars,
    maxSummaryChars: input.maxSummaryChars,
    receivedChars: received,
  });
  const total = estimatedTotalChars > 0 ? estimatedTotalChars : 1;
  let percent = Math.min(
    COMPACTION_PROGRESS_CONFIG.maxLivePercent,
    Math.round((received / total) * 100),
  );

  if (typeof input.minPercent === 'number' && Number.isFinite(input.minPercent)) {
    percent = Math.max(
      Math.max(0, Math.min(COMPACTION_PROGRESS_CONFIG.maxLivePercent, Math.round(input.minPercent))),
      percent,
    );
  }

  return percent;
}

export function resolveMaxSummaryChars(input?: {
  maxOutputTokens?: number | null;
  charsPerToken?: number;
}): number {
  const charsPerToken =
    Number.isFinite(input?.charsPerToken) && (input?.charsPerToken ?? 0) > 0
      ? Number(input?.charsPerToken)
      : CONTEXT_PROJECTION_CONFIG.charsPerToken;
  const maxOutputTokens =
    Number.isFinite(input?.maxOutputTokens) && (input?.maxOutputTokens ?? 0) > 0
      ? Number(input?.maxOutputTokens)
      : 12_000;
  return Math.max(
    COMPACTION_PROGRESS_CONFIG.minEstimatedSummaryChars,
    Math.round(maxOutputTokens * charsPerToken),
  );
}
