const TOKENS_PER_MILLION = 1_000_000;
function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalPrice(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} usage token bucket
 * @param {{ inputPrice?: number|null, outputPrice?: number|null, cacheReadPrice?: number|null, cacheWritePrice?: number|null }} pricing
 * @returns {{ estimatedCostUsd: number|null, hasPricing: boolean }}
 */
export function estimateUsageCostUsd(usage, pricing = {}) {
  const inputPrice = optionalPrice(pricing.inputPrice);
  const outputPrice = optionalPrice(pricing.outputPrice);
  const cacheReadPrice = optionalPrice(pricing.cacheReadPrice);
  const cacheWritePrice = optionalPrice(pricing.cacheWritePrice);
  const hasPricing = [inputPrice, outputPrice, cacheReadPrice, cacheWritePrice]
    .some((price) => price != null);
  if (!hasPricing) {
    return { estimatedCostUsd: null, hasPricing: false };
  }

  const cost =
    (finiteNumber(usage.inputTokens) * (inputPrice ?? 0)
      + finiteNumber(usage.outputTokens) * (outputPrice ?? 0)
      + finiteNumber(usage.cacheReadTokens) * (cacheReadPrice ?? 0)
      + finiteNumber(usage.cacheWriteTokens) * (cacheWritePrice ?? 0))
    / TOKENS_PER_MILLION;

  return { estimatedCostUsd: cost, hasPricing: true };
}

