/** Missing native reasoning is historical data, never invented provider state. */
export function admitDeepSeekChatHistory(messages, { model, tools, supportsReasoning, effort }) {
  if (!/^deepseek(?:[-/]|$)/i.test(model || '') || !tools?.length || !supportsReasoning || effort === 'off') return messages;
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== 'assistant' || typeof message.reasoning_content === 'string') { out.push(message); continue; }
    // Old/cross-model canonical history cannot provide authentic native thinking.
    // Keep paired results together as labelled facts; no tool call is reissued.
    const history = [message];
    while (messages[i + 1]?.role === 'tool') history.push(messages[++i]);
    out.push({ role: 'user', content: '[Historical assistant and tool observations; context only, not a new request or executable calls]\n' + JSON.stringify(history) });
  }
  return out;
}
