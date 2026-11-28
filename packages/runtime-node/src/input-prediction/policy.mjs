import { INPUT_PREDICTION_LIMITS as limits, normalizeInputPredictionSettings } from '@peer-agent/protocol';

const BUDGET_OVERHEAD_TOKENS = 256;
const MAX_QUOTE_CHARS = 240;

export function predictionSettingsFor(settings, workspaceId, mode) {
  const value = normalizeInputPredictionSettings(settings?.inputPrediction);
  if (!value.enabled || value.disabledWorkspaceIds.includes(workspaceId)) return null;
  if (mode === 'continuation' && !value.continuationEnabled) return null;
  return value;
}

function unwrapJsonFence(raw) {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseInputPrediction(text, mode) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  let value;
  try { value = JSON.parse(unwrapJsonFence(text)); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.kind === 'none' && Object.keys(value).length === 1) return '';
  const key = mode === 'next_turn' ? 'text' : 'suffix';
  if (value.kind !== mode || Object.keys(value).some(name => name !== 'kind' && name !== key)) return null;
  const insertion = value[key];
  if (typeof insertion !== 'string' || !insertion.trim() || insertion.length > limits.candidateLength) return null;
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(insertion) || /[\uD800-\uDFFF]/u.test(insertion)) return null;
  const count = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(insertion)].length : [...insertion].length;
  if (count > limits.candidateGraphemes) return null;
  if (/(同意.{0,4}授权|批准.{0,4}(权限|计划)|验收通过|确认.{0,4}(签收|验收)|approve.{0,12}(permission|plan)|accept.{0,12}(result|delivery))/iu.test(insertion)) return null;
  return insertion;
}

/**
 * Conservative token estimator that still fails closed on oversized ASCII rules
 * while avoiding the 3x UTF-8 byte penalty on CJK conversations.
 */
function estimateTokens(text) {
  let ascii = 0, nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      ascii++;
    } else {
      nonAscii++;
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) i++;
    }
  }
  return ascii + Math.ceil(nonAscii * 1.5);
}

function trimCodePoints(text, maxChars, { fromTail = false } = {}) {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars <= 1) return chars.slice(fromTail ? -1 : 0, fromTail ? undefined : 1).join('');
  return fromTail
    ? `…${chars.slice(-(maxChars - 1)).join('')}`
    : `${chars.slice(0, maxChars - 1).join('')}…`;
}

function buildPayload(system, request, conversation, quote) {
  const data = { mode: request.mode, conversation, draft: request.draftText, quote: quote ?? null };
  const messages = [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(data) }];
  return { messages, tokens: estimateTokens(JSON.stringify(messages)) };
}

/** Conservatively bound the input token budget; never trim mandatory system instructions or draft. */
export function predictionMessages({ system, snapshot, request }) {
  const rows = snapshot.messages;
  if (!Array.isArray(rows) || !rows.length || !rows.some(row => row.role === 'user')) return null;
  const latest = rows.at(-1);
  if (latest?.role !== 'assistant' || !latest.content?.trim()) return null;
  const messages = rows.slice(-8).map(row => ({ role: row.role, content: row.content }));
  if (messages.some(row => !['user', 'assistant'].includes(row.role) || typeof row.content !== 'string')) return null;

  const maxTokens = limits.inputTokens - BUDGET_OVERHEAD_TOKENS;
  // Mandatory system instructions are never truncated.
  if (estimateTokens(JSON.stringify([{ role: 'system', content: system }])) > maxTokens) return null;

  let quote = snapshot.quote ?? null;
  const full = buildPayload(system, request, messages, quote);
  if (full.tokens <= maxTokens) {
    return { messages: full.messages, reservedTokens: limits.inputTokens + limits.outputTokens };
  }

  // Trim oversized quote first before touching conversation messages.
  if (quote && typeof quote.content === 'string' && Array.from(quote.content).length > MAX_QUOTE_CHARS) {
    quote = { ...quote, content: trimCodePoints(quote.content, MAX_QUOTE_CHARS) };
    const withTrimmedQuote = buildPayload(system, request, messages, quote);
    if (withTrimmedQuote.tokens <= maxTokens) {
      return { messages: withTrimmedQuote.messages, reservedTokens: limits.inputTokens + limits.outputTokens };
    }
  }

  // Find the most recent user message so we always keep at least [latestUser, latestAssistant].
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return null;

  // Greedily include as many newest messages as fit within budget, preserving chronology.
  const latestIdx = messages.length - 1;
  const required = lastUserIdx === latestIdx ? [latestIdx] : [lastUserIdx, latestIdx];
  let chosenIndices = [...required];
  let candidate = buildPayload(system, request, chosenIndices.map(i => messages[i]), quote);

  if (candidate.tokens <= maxTokens) {
    for (let i = latestIdx - 1; i >= 0; i--) {
      if (chosenIndices.includes(i)) continue;
      const nextIndices = [...chosenIndices, i].sort((a, b) => a - b);
      const next = buildPayload(system, request, nextIndices.map(idx => messages[idx]), quote);
      if (next.tokens <= maxTokens) {
        chosenIndices = nextIndices;
        candidate = next;
      } else {
        // Stop widening older turns once we hit budget so recency stays contiguous.
        if (i < lastUserIdx) break;
      }
    }
    return { messages: candidate.messages, reservedTokens: limits.inputTokens + limits.outputTokens };
  }

  // Even [lastUser, latestAssistant] exceeds budget: trim content cleanly while keeping
  // the tail of the latest assistant reply (where questions/next steps live) and latest user intent.
  const emptyShellTokens = buildPayload(system, request, [], quote).tokens;
  const remaining = maxTokens - emptyShellTokens - 48;
  if (remaining < 40) return null;

  const userOrig = messages[lastUserIdx].content;
  const asstOrig = messages[latestIdx].content;
  // Allocate ~35% to user message and ~65% to latest assistant tail, then shrink if escaping pushes over.
  let userCap = Math.max(24, Math.floor((remaining * 0.35) / 1.5));
  let asstCap = Math.max(40, Math.floor((remaining * 0.65) / 1.5));
  for (let attempt = 0; attempt < 8; attempt++) {
    const trimmed = [
      { role: 'user', content: trimCodePoints(userOrig, userCap, { fromTail: true }) },
      { role: 'assistant', content: trimCodePoints(asstOrig, asstCap, { fromTail: true }) },
    ];
    const built = buildPayload(system, request, trimmed, quote);
    if (built.tokens <= maxTokens) {
      return { messages: built.messages, reservedTokens: limits.inputTokens + limits.outputTokens };
    }
    userCap = Math.max(12, Math.floor(userCap * 0.75));
    asstCap = Math.max(20, Math.floor(asstCap * 0.75));
  }
  return null;
}
