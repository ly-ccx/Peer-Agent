import { randomUUID } from 'node:crypto';
import { startOfLocalDayMs, sumRoleSpendUsd } from '../usage-stats.mjs';
import { estimateUsageCostUsd } from '../usage-pricing.mjs';

export function createInputPredictionBudget({ log, now = Date.now }) {
  function summary() {
    const day = log.readForBudget(startOfLocalDayMs(now()));
    const rows = day.rows.filter(row => row.requestPurpose === 'input_prediction');
    return { ...day, requests: rows.length,
      tokens: rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens + (row.cacheReadTokens || 0) + (row.cacheWriteTokens || 0), 0),
      estimated: rows.some(row => row.usageIsEstimate) };
  }
  return {
    summary,
    reserve({ settings, route, workspaceId, conversationId, tokens }) {
      const day = log.readForBudget(startOfLocalDayMs(now()));
      if (!day.complete) return null;
      const rows = day.rows.filter(row => row.requestPurpose === 'input_prediction');
      const consumed = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens + (row.cacheReadTokens || 0) + (row.cacheWriteTokens || 0), 0);
      if (rows.length >= settings.dailyRequestLimit || consumed + tokens > settings.dailyTokenLimit) return null;
      const provider = route.provider;
      const usage = { inputTokens: tokens - 128, outputTokens: 128 };
      const cost = estimateUsageCostUsd(usage, provider).estimatedCostUsd;
      for (const [role, cap] of [[null, route.routing?.dailySpendCapUsd], ['input_predictor', route.routing?.roleSpendCaps?.input_predictor]]) {
        if (typeof cap === 'number' && (sumRoleSpendUsd(day.rows, { role }) + (cost ?? 0) >= cap || cost == null)) return null;
      }
      const reservation = { id: randomUUID(), at: new Date(now()).toISOString(), requestPurpose: 'input_prediction',
        workspaceId, conversationId, role: 'input_predictor', modelProviderId: provider.id,
        groupId: provider.groupId, model: provider.model, providerName: provider.name,
        pricing: { inputPrice: provider.inputPrice, outputPrice: provider.outputPrice,
          cacheReadPrice: provider.cacheReadPrice, cacheWritePrice: provider.cacheWritePrice },
        pricingSource: provider.pricingSource, usage };
      log.append({ ...reservation, accountingState: 'reserved', usageIsEstimate: true });
      return reservation;
    },
    settle(reservation, usage, { complete = true } = {}) {
      const known = complete && usage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens);
      const conservative = { ...reservation.usage };
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
        if (Number.isFinite(usage?.[key])) conservative[key] = Math.max(conservative[key] ?? 0, usage[key]);
      }
      log.append({ ...reservation, accountingState: 'settled', usageIsEstimate: !known,
        usage: known ? usage : conservative });
    },
  };
}
