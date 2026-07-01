import { neutralizeToolCallSyntax } from '../../chat-runtime/message-sanitizer.mjs';

const MAX_CONTINUITY_SUMMARIES = 3;
const MAX_SUMMARY_CHARS = 12_000;

function normalizeContinuityItem(item, index) {
  if (!item || typeof item !== 'object') return null;
  const summary = neutralizeToolCallSyntax(typeof item.summary === 'string' && item.summary.trim()
    ? item.summary.trim()
    : typeof item.content === 'string'
      ? item.content.trim()
      : '');
  if (!summary) return null;
  return {
    id: typeof item.id === 'string' ? item.id : `continuity-${index}`,
    method: typeof item.method === 'string' ? item.method : 'unknown',
    originalMessageCount: Number.isFinite(item.originalMessageCount) ? item.originalMessageCount : 0,
    beforeTokens: Number.isFinite(item.beforeTokens) ? item.beforeTokens : 0,
    afterTokens: Number.isFinite(item.afterTokens) ? item.afterTokens : 0,
    summary: summary.length > MAX_SUMMARY_CHARS
      ? `${summary.slice(0, MAX_SUMMARY_CHARS)}\n[continuity summary truncated]`
      : summary,
  };
}

function formatContinuityContext(items) {
  return [
    'Continuity context from previous compaction.',
    'This is a navigation aid, not fresh evidence. If continuity context conflicts with recent user messages, follow the recent user messages. If local facts matter, verify them with tools before claiming them.',
    '',
    ...items.map((item, index) => [
      `## Continuity Summary ${index + 1}`,
      `method=${item.method}; originalMessages=${item.originalMessageCount}; beforeTokens=${item.beforeTokens}; afterTokens=${item.afterTokens}`,
      '',
      item.summary,
    ].join('\n')),
  ].join('\n');
}

export function createContinuityPromptSource() {
  return {
    id: 'runtime.continuity',
    layer: 'L7_CONTINUITY',
    priority: 0,
    trust: 'runtime',
    observe(input = {}) {
      const rawItems = Array.isArray(input.continuityContext)
        ? input.continuityContext
        : [];
      const items = rawItems
        .map(normalizeContinuityItem)
        .filter(Boolean)
        .slice(-MAX_CONTINUITY_SUMMARIES);
      return { items };
    },
    render(observation) {
      if (!observation.items.length) return [];
      return [{
        id: 'runtime.continuity',
        layer: 'L7_CONTINUITY',
        priority: 0,
        title: 'Continuity context',
        content: formatContinuityContext(observation.items),
        source: {
          id: 'runtime.continuity',
          kind: 'compaction-continuity',
          summaryCount: observation.items.length,
          summaries: observation.items.map((item) => ({
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
