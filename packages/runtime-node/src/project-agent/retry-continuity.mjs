/** Bounded excerpts from one canonical attempt; never replay calls or reasoning. */
export function readRetryContinuity(messages, turnId) {
  const turn = (Array.isArray(messages) ? messages : []).find(message => message.id === turnId && message.kind === 'agent_turn');
  if (!turn) return null;
  const calls = (turn.rounds || []).flatMap(round => round?.toolCalls || []).filter(call => call?.result != null).slice(-16);
  let remaining = 11_700;
  const tools = calls.flatMap(call => {
    if (remaining <= 0 || typeof call.name !== 'string') return [];
    const args = excerpt(call.input, Math.min(800, remaining));
    const result = excerpt(call.result, Math.min(2200, remaining));
    const refs = call.result?.evidenceRefs || call.result?.outputPreview?.evidenceRefs || [];
    const item = { name: call.name.slice(0, 100), argumentsPreview: args.text, resultPreview: result.text,
      truncated: args.truncated || result.truncated || call.result?.truncated === true,
      evidenceRefs: Array.isArray(refs) ? refs.filter(ref => typeof ref === 'string' && ref.length <= 500).slice(0, 8) : [] };
    if (JSON.stringify(item).length > remaining) { item.resultPreview = ''; item.argumentsPreview = ''; item.truncated = true; }
    const cost = JSON.stringify(item).length;
    if (cost > remaining) return [];
    remaining -= cost;
    return [item];
  });
  return tools.length ? { turnId, tools } : null;
}

function excerpt(value, max) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value) || ''; } catch { text = ''; }
  return { text: text.slice(0, max), truncated: text.length > max };
}
