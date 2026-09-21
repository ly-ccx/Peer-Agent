import { bindPreviewImage } from '../runtime-gateway/desktop-preview-service.mjs';

export const INDEPENDENT_VISUAL_REVIEW_PURPOSE = 'independent-review';

export function isIndependentVisualReviewPurpose(purpose) {
  return purpose === INDEPENDENT_VISUAL_REVIEW_PURPOSE;
}

function observationsFromExecutions(executions, purpose) {
  const allowDesktop = isIndependentVisualReviewPurpose(purpose);
  return executions.flatMap((execution) => (
    Array.isArray(execution?.result?.visualObservations)
      ? execution.result.visualObservations
      : []
  )).filter((observation) => observation?.kind !== 'desktop_preview' || allowDesktop);
}

function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/[^;,]+);base64,([A-Za-z0-9+/=\s]+)$/s);
  if (!match) return null;
  return { mediaType: match[1], data: match[2].replace(/\s+/g, '') };
}

function observationText(observation) {
  const surface = observation.kind === 'desktop_preview' ? 'managed Desktop preview' : 'browser';
  return `Current ${surface} screenshot. The artifact remains the factual source: ${observation.artifactRef}`;
}

export function createOpenAIVisualObservationMessage(executions, purpose) {
  const content = [];
  for (const observation of observationsFromExecutions(executions, purpose)) {
    if (!parseImageDataUrl(observation.dataUrl)) continue;
    content.push({ type: 'text', text: observationText(observation) });
    content.push(bindPreviewImage({ type: 'image_url', image_url: { url: observation.dataUrl } }, observation));
  }
  return content.length ? { role: 'user', content } : null;
}

export function createAnthropicToolResultContent(toolExecution, purpose) {
  const observations = Array.isArray(toolExecution?.visualObservations)
    ? toolExecution.visualObservations.filter((observation) => (
      observation?.kind !== 'desktop_preview' || isIndependentVisualReviewPurpose(purpose)
    ))
    : [];
  const imageBlocks = [];
  for (const observation of observations) {
    const parsed = parseImageDataUrl(observation.dataUrl);
    if (!parsed) continue;
    imageBlocks.push({ type: 'text', text: observationText(observation) });
    imageBlocks.push(bindPreviewImage({
      type: 'image',
      source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
    }, observation));
  }
  if (!imageBlocks.length) return toolExecution.output;
  return [{ type: 'text', text: toolExecution.output }, ...imageBlocks];
}

export function createGeminiVisualObservationParts(executions, purpose) {
  const parts = [];
  for (const observation of observationsFromExecutions(executions, purpose)) {
    const parsed = parseImageDataUrl(observation.dataUrl);
    if (!parsed) continue;
    parts.push({ text: observationText(observation) });
    parts.push(bindPreviewImage({ inlineData: { mimeType: parsed.mediaType, data: parsed.data } }, observation));
  }
  return parts;
}
