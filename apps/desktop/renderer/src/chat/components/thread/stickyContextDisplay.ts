/**
 * Presentation-only sticky display for context occupancy.
 * Live values still come only from shared contextAccounting; when a turn
 * temporarily drops percent/tokens to unknown, keep the lastKnown display
 * instead of flashing "?". Never invent a percentage without a prior live value.
 */
export function resolveStickyContextDisplay(input: Readonly<{
  livePercent: number | null;
  liveTokens: number | null;
  lastKnownPercent: number | null;
  lastKnownTokens: number | null;
}>): { readonly percent: number | null; readonly tokens: number | null } {
  return {
    percent: input.livePercent ?? input.lastKnownPercent,
    tokens: input.liveTokens ?? input.lastKnownTokens,
  };
}
