import { botResourceReferences } from '@peer-agent/protocol';
const DISPOSITION_TOOLS = new Set(['spawn_session', 'message_session', 'cancel_session']);
function record(value) {
  if (typeof value === 'string') { try { return record(JSON.parse(value)); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
const pick = (value, keys) => value ? Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])) : null;

/** Public text and disposition facts; full Tool Results remain in the selected process. */
export function projectBotConversationHistory(history) {
  const messages = history?.messages || [];
  const references = new Map(messages.filter(message => message.kind === 'agent_turn' && typeof message.id === 'string')
    .map(message => [message.id, botResourceReferences(message.rounds)]));
  return messages.map(({ rounds, dispositionCalls, resourceReferences, ...message }) => {
    if (message.kind !== 'agent_turn') {
      const refs = message.kind === 'agent_reply' && typeof message.turnId === 'string' ? references.get(message.turnId) : null;
      return refs?.length ? { ...message, resourceReferences: refs } : message;
    }
    const calls = (Array.isArray(rounds) ? rounds : []).flatMap(round => (Array.isArray(round?.toolCalls) ? round.toolCalls : []).flatMap(call => {
      if (!DISPOSITION_TOOLS.has(call?.name)) return [];
      const input = record(call.input), result = record(call.result), output = record(result?.output);
      const body = output && typeof result.sessionId !== 'string'
        && (typeof output.sessionId === 'string' || typeof output.error === 'string' || output.ok === false) ? output : result;
      return [{ name: call.name, input: pick(input, ['sessionId', 'intent', 'reason', 'supersedes', 'dependsOn', 'title']),
        result: pick(body, ['ok', 'error', 'sessionId', 'status', 'queued']) }];
    }));
    const refs = references.get(message.id) ?? [];
    return { ...message, dispositionCalls: calls, ...(refs.length ? { resourceReferences: refs } : {}) };
  });
}

export function createBotConversationHistory(store) {
  return typeof store.createHistoryProjection === 'function'
    ? store.createHistoryProjection(projectBotConversationHistory, { immutableInput: true })
    : id => projectBotConversationHistory(store.getPersistedConversationHistory?.(id));
}
