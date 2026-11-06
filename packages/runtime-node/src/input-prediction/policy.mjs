import { INPUT_PREDICTION_LIMITS as limits, normalizeInputPredictionSettings } from '@peer-agent/protocol';

export function predictionSettingsFor(settings, workspaceId, mode) {
  const value = normalizeInputPredictionSettings(settings?.inputPrediction);
  if (!value.enabled || value.disabledWorkspaceIds.includes(workspaceId)) return null;
  if (mode === 'continuation' && !value.continuationEnabled) return null;
  return value;
}

export function parseInputPrediction(text, mode) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
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

/** UTF-8 bytes conservatively bound the token budget; never trim mandatory instructions. */
export function predictionMessages({ system, snapshot, request }) {
  const rows = snapshot.messages;
  if (!Array.isArray(rows) || !rows.length || !rows.some(row => row.role === 'user')) return null;
  const latest = rows.at(-1);
  if (latest?.role !== 'assistant' || !latest.content?.trim()) return null;
  const messages = rows.slice(-8).map(row => ({ role: row.role, content: row.content }));
  if (messages.some(row => !['user', 'assistant'].includes(row.role) || typeof row.content !== 'string')) return null;
  const data = { mode: request.mode, conversation: messages, draft: request.draftText, quote: snapshot.quote ?? null };
  const result = [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(data) }];
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes + 256 > limits.inputTokens) return null;
  return { messages: result, reservedTokens: limits.inputTokens + limits.outputTokens };
}
