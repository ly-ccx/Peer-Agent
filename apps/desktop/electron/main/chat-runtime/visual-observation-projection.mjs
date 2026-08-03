function observationsFromExecutions(executions) {
  return executions.flatMap((execution) => (
    Array.isArray(execution?.result?.visualObservations)
      ? execution.result.visualObservations
      : []
  ));
}

function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/[^;,]+);base64,([A-Za-z0-9+/=\s]+)$/s);
  if (!match) return null;
  return { mediaType: match[1], data: match[2].replace(/\s+/g, '') };
}

function observationText(observation) {
  return `Current browser screenshot. The artifact remains the factual source: ${observation.artifactRef}`;
}

/**
 * Project ephemeral browser observations into an OpenAI-compatible user message.
 * Tool-call/result pairing must be appended before this message.
 */
export function createOpenAIVisualObservationMessage(executions) {
  const observations = observationsFromExecutions(executions)
    .filter((observation) => parseImageDataUrl(observation.dataUrl));
  if (observations.length === 0) return null;
  return {
    role: 'user',
    content: observations.flatMap((observation) => ([
      { type: 'text', text: observationText(observation) },
      { type: 'image_url', image_url: { url: observation.dataUrl } },
    ])),
  };
}

/**
 * Anthropic permits image blocks inside tool_result.content, preserving the exact
 * tool_use/tool_result pairing while making the screenshot visible to the model.
 */
export function createAnthropicToolResultContent(toolExecution) {
  const observations = Array.isArray(toolExecution?.visualObservations)
    ? toolExecution.visualObservations
    : [];
  if (observations.length === 0) return toolExecution.output;
  const imageBlocks = [];
  for (const observation of observations) {
    const parsed = parseImageDataUrl(observation.dataUrl);
    if (!parsed) continue;
    imageBlocks.push({ type: 'text', text: observationText(observation) });
    imageBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: parsed.mediaType,
        data: parsed.data,
      },
    });
  }
  if (imageBlocks.length === 0) return toolExecution.output;
  return [{ type: 'text', text: toolExecution.output }, ...imageBlocks];
}

/** Gemini function responses and inline image data share the same user turn. */
export function createGeminiVisualObservationParts(executions) {
  const parts = [];
  for (const observation of observationsFromExecutions(executions)) {
    const parsed = parseImageDataUrl(observation.dataUrl);
    if (!parsed) continue;
    parts.push({ text: observationText(observation) });
    parts.push({ inlineData: { mimeType: parsed.mediaType, data: parsed.data } });
  }
  return parts;
}
