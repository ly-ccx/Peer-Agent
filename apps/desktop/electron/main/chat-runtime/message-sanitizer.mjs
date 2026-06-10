function hasContent(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function isEmptyAssistantMessage(message) {
  return (
    message?.role === 'assistant' &&
    !message?.tool_calls?.length &&
    !hasContent(message?.content)
  );
}

export function sanitizeApiMessages(messages) {
  return messages.filter((message) => {
    if (!message || typeof message !== 'object') return false;
    if (isEmptyAssistantMessage(message)) return false;
    if (message.role === 'system') return hasContent(message.content);
    if (message.role === 'user') return hasContent(message.content);
    if (message.role === 'assistant') return hasContent(message.content) || Boolean(message.tool_calls?.length);
    if (message.role === 'tool') return hasContent(message.content);
    return false;
  });
}
