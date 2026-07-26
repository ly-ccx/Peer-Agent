import { neutralizeToolCallSyntax } from '../sanitize-context-text.mjs';

/**
 * Continuity injection prefers integrity over mechanical length chopping.
 *
 * Compaction already produces a cumulative handoff summary (carry-forward + delta).
 * Inject that body whole into system context. Do not re-truncate the summary text
 * with a fixed character budget — that would undo LLM compaction's purpose.
 *
 * We still keep a small recent-item window for callers that pass multiple items,
 * but production paths typically supply only the latest cumulative handoff.
 */
const MAX_CONTINUITY_SUMMARIES = 3;

function normalizeContinuityItem(item, index) {
  if (!item || typeof item !== 'object') return null;
  const summary = neutralizeToolCallSyntax(typeof item.summary === 'string' && item.summary.trim()
    ? item.summary.trim()
    : typeof item.content === 'string'
      ? item.content.trim()
      : '');
  if (!summary) return null;
  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `continuity-${index + 1}`,
    // Integrity-first: keep the full summary body produced by compaction.
    summary,
    method: typeof item.method === 'string' && item.method.trim() ? item.method.trim() : 'unknown',
    originalMessageCount: Number.isFinite(item.originalMessageCount) ? item.originalMessageCount : null,
    beforeTokens: Number.isFinite(item.beforeTokens) ? item.beforeTokens : null,
    afterTokens: Number.isFinite(item.afterTokens) ? item.afterTokens : null,
  };
}

function formatContinuityItem(item, index) {
  const meta = [
    `method=${item.method}`,
    item.originalMessageCount != null ? `originalMessages=${item.originalMessageCount}` : null,
    item.beforeTokens != null ? `beforeTokens=${item.beforeTokens}` : null,
    item.afterTokens != null ? `afterTokens=${item.afterTokens}` : null,
    `summaryChars=${item.summary.length}`,
  ].filter(Boolean).join('; ');
  return [
    `## Continuity Summary ${index + 1}`,
    meta,
    '',
    item.summary,
  ].join('\n');
}

function formatContinuityContext(items) {
  return [
    'Continuity context from previous compaction.',
    'This is the cumulative handoff summary for navigation and unfinished work.',
    'Injected with integrity priority: the summary body is kept complete (not mechanically truncated by a fixed character budget).',
    'It is continuity context, not a replacement for Tool Result / Evidence.',
    'If it conflicts with newer user messages, prefer the latest user messages.',
    'If local facts matter, verify them with tools before claiming them.',
    '',
    ...items.map((item, index) => formatContinuityItem(item, index)),
  ].join('\n');
}

export function createContinuityPromptSource() {
  return {
    id: 'runtime.continuity',
    layer: 'L7_CONTINUITY',
    priority: 10,
    trust: 'runtime',
    observe(input = {}) {
      const rawItems = Array.isArray(input.continuityContext)
        ? input.continuityContext
        : [];
      const items = rawItems
        .map((item, index) => normalizeContinuityItem(item, index))
        .filter(Boolean)
        // Prefer the most recent cumulative handoffs when multiple are supplied.
        .slice(-MAX_CONTINUITY_SUMMARIES);
      return { items };
    },
    render(observation = {}) {
      const items = Array.isArray(observation.items) ? observation.items : [];
      if (!items.length) return [];
      return [{
        id: 'runtime.continuity',
        layer: 'L7_CONTINUITY',
        priority: 10,
        title: 'Continuity Context',
        content: formatContinuityContext(items),
        source: {
          id: 'runtime.continuity',
          kind: 'compaction-continuity',
          integrityFirst: true,
          summaryCount: items.length,
          summaries: items.map((item) => ({
            id: item.id,
            method: item.method,
            originalMessageCount: item.originalMessageCount,
            beforeTokens: item.beforeTokens,
            afterTokens: item.afterTokens,
            summaryChars: item.summary.length,
          })),
        },
        trust: 'runtime',
      }];
    },
  };
}
