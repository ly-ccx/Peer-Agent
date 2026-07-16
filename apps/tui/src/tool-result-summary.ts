const DEFAULT_MAX_LENGTH = 1_200;
const DEFAULT_INLINE_MAX_LENGTH = 120;

export function toolResultInlineSummary(
  content: string,
  maxLength = DEFAULT_INLINE_MAX_LENGTH,
): string {
  const singleLine = content
    .replace(/\s+/g, ' ')
    .trim();
  if (!singleLine) return 'completed';
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function toggleToolDetails(current: boolean): boolean {
  return !current;
}


function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === 'bigint') return nested.toString();
    if (!nested || typeof nested !== 'object') return nested;
    if (seen.has(nested)) return '[Circular]';
    seen.add(nested);
    if (Array.isArray(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }, 2);
}

export function formatToolResultSummary(
  value: unknown,
  fallback = 'completed',
  maxLength = DEFAULT_MAX_LENGTH,
): string {
  let formatted: string;
  if (typeof value === 'string') {
    formatted = value;
  } else if (value === undefined || value === null) {
    formatted = fallback;
  } else {
    try {
      formatted = stableJson(value) ?? fallback;
    } catch {
      formatted = fallback;
    }
  }

  if (formatted.length <= maxLength) return formatted;
  return `${formatted.slice(0, Math.max(0, maxLength - 1))}…`;
}
