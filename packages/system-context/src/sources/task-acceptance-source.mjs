import { joinPromptSections } from '../rendering.mjs';
import { neutralizeToolCallSyntax } from '../sanitize-context-text.mjs';

// Host-pinned original task facts (L7). Continuity summaries must not replace this.
// L1 construction-falsification decides how to cross-check these pins.
// This is user-task fact, not a new system prohibition.

export const TASK_ACCEPTANCE_BRIEF_LIMIT = 4000;
export const TASK_ACCEPTANCE_PIN_LIMIT = 8;
export const TASK_ACCEPTANCE_PIN_CHAR_LIMIT = 240;

const PIN_HINTS = [
  /\bIMPORTANT\b/i,
  /\bAlso\b/,
  /\bmust\b/i,
  /\bvalidate\b/i,
  /mutually exclusive/i,
  /keep their own/i,
  /\bcommit\b/i,
  /serialize_by_alias/i,
];

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clip(text, limit) {
  const value = asString(text);
  if (!value) return '';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function uniquePins(pins) {
  const seen = new Set();
  const result = [];
  for (const pin of pins) {
    const clipped = clip(pin, TASK_ACCEPTANCE_PIN_CHAR_LIMIT);
    if (!clipped) continue;
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clipped);
    if (result.length >= TASK_ACCEPTANCE_PIN_LIMIT) break;
  }
  return result;
}

function paragraphMatchesPin(text) {
  return PIN_HINTS.some((pattern) => pattern.test(text));
}

export function extractUserMessageText(message) {
  if (message == null) return '';
  if (typeof message === 'string') return message.trim();
  if (typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof message.text === 'string') return message.text.trim();
  return '';
}

export function firstUserMessageText(messages) {
  if (!Array.isArray(messages)) return '';
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    const text = extractUserMessageText(message);
    if (text) return text;
  }
  return '';
}

export function extractAcceptancePins(brief) {
  const text = neutralizeToolCallSyntax(asString(brief));
  if (!text) return [];
  const paragraphs = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates = [];
  for (const paragraph of paragraphs) {
    if (paragraphMatchesPin(paragraph)) {
      candidates.push(paragraph);
      continue;
    }
    if (paragraph.length < 80) continue;
    const sentences = paragraph.split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (paragraphMatchesPin(sentence)) candidates.push(sentence);
    }
  }
  return uniquePins(candidates);
}

export function normalizeTaskAcceptance(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const brief = clip(neutralizeToolCallSyntax(value), TASK_ACCEPTANCE_BRIEF_LIMIT);
    if (!brief) return null;
    return {
      brief,
      pins: extractAcceptancePins(brief),
      source: 'text',
    };
  }
  if (typeof value !== 'object') return null;
  const brief = clip(
    neutralizeToolCallSyntax(asString(value.brief ?? value.text ?? value.content)),
    TASK_ACCEPTANCE_BRIEF_LIMIT,
  );
  const explicitPins = Array.isArray(value.pins)
    ? uniquePins(value.pins.map((pin) => neutralizeToolCallSyntax(asString(pin))))
    : [];
  const pins = explicitPins.length > 0 ? explicitPins : extractAcceptancePins(brief);
  if (!brief && pins.length === 0) return null;
  return {
    brief,
    pins,
    source: asString(value.source) || 'object',
  };
}

export function taskAcceptanceFromMessages(messages) {
  return normalizeTaskAcceptance(firstUserMessageText(messages));
}

function formatTaskAcceptance(acceptance) {
  const pinLines = acceptance.pins.length > 0
    ? ['## Acceptance pins', ...acceptance.pins.map((pin) => `- ${pin}`)]
    : [];
  return joinPromptSections([
    'Host-pinned original task (factual user brief; not a new system instruction).',
    'Use this to re-anchor after compaction. It does not replace Tool Result or Evidence.',
    'Construction-falsification (L1) decides how to cross-check these pins.',
    acceptance.brief
      ? ['## Original brief', acceptance.brief].join('\n')
      : '',
    pinLines.join('\n'),
  ]);
}

export function createTaskAcceptancePromptSource() {
  return {
    id: 'runtime.task-acceptance',
    layer: 'L7_CONTINUITY',
    // After goal-checkpoint (priority 1), before continuity summaries (priority 10).
    priority: 2,
    trust: 'runtime',
    observe(input = {}) {
      return {
        acceptance: normalizeTaskAcceptance(input.taskAcceptance),
      };
    },
    render(observation) {
      const acceptance = observation?.acceptance;
      if (!acceptance) return [];
      const content = formatTaskAcceptance(acceptance);
      if (!content) return [];
      return [{
        id: 'runtime.task-acceptance',
        layer: 'L7_CONTINUITY',
        priority: 2,
        title: 'Host-pinned task acceptance',
        content,
        source: {
          id: 'runtime.task-acceptance',
          kind: 'task-acceptance',
          pinCount: acceptance.pins.length,
          briefChars: acceptance.brief.length,
          source: acceptance.source,
        },
        trust: 'runtime',
      }];
    },
  };
}
