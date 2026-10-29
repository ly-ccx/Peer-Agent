import type { BotResourceReferenceHint } from './document-reference.ts';

const FILE_RESULTS = new Map([
  ['read_file', new Set(['local_file_ref', 'file_read_result'])],
  ['write_file', new Set(['file_write_result'])],
  ['edit_file', new Set(['file_edit_result'])],
]);
function resourceHintRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    if (value.length > 1_000_000) return null;
    try { return resourceHintRecord(JSON.parse(value)); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function resourceFileResult(value: unknown, depth = 0): Record<string, unknown> | null {
  const result = resourceHintRecord(value);
  if (!result || depth > 4 || result.success === false || result.ok === false
    || ['failed', 'error', 'blocked', 'denied', 'cancelled'].includes(String(result.status))) return null;
  if (typeof result.kind === 'string' && typeof result.path === 'string') return result;
  // Only known transport envelopes; never search assistant prose or arbitrary properties.
  for (const key of ['output', 'outputPreview', 'fileResult', 'legacyResult']) {
    const nested = resourceFileResult(result[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Normalize same-turn navigation hints. No permission, Artifact or Evidence is created. */
export function botResourceReferences(rounds: unknown): readonly BotResourceReferenceHint[] {
  const paths = new Map<string, BotResourceReferenceHint>();
  for (const rawRound of Array.isArray(rounds) ? rounds : []) {
    const round = resourceHintRecord(rawRound);
    for (const rawCall of Array.isArray(round?.toolCalls) ? round.toolCalls : []) {
      const call = resourceHintRecord(rawCall);
      const kinds = typeof call?.name === 'string' ? FILE_RESULTS.get(call.name) : null;
      if (!kinds || !call) continue;
      const result = resourceFileResult(call.result);
      if (!result || !kinds.has(String(result.kind)) || result.tool !== call.name
        || (result.status !== undefined && result.status !== 'success')) continue;
      const path = result.path;
      if (typeof path !== 'string' || path.length > 8192 || /[\0\r\n]/.test(path) || !/^(?:\/|[A-Za-z]:[\\/])/.test(path)) continue;
      if (!paths.has(path)) paths.set(path, { path, tool: call.name as BotResourceReferenceHint['tool'] });
      if (paths.size >= 256) return [...paths.values()];
    }
  }
  return [...paths.values()];
}
