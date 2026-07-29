/**
 * Join GPT-style reasoning *summary* status phrases without gluing them into one run-on line.
 *
 * Keep in lockstep with apps/desktop/renderer/src/chat/state/thinkingSummaryJoin.ts.
 * ONLY for kind === 'summary'. Do not use for reasoning / legacy kindless thinking.
 *
 * Conservative rules:
 * - empty prev/next → non-empty side
 * - either side already has boundary whitespace → concat as-is
 * - insert \n only with stronger evidence of a new status phrase:
 *   sentence punctuation, multi-word capitalised phrase, or a lone English gerund (…ing)
 * - bare lower→Upper alone is NOT enough (protects camelCase fragments)
 */
export function joinSummaryThinkingContent(previous, next) {
  if (!previous) return next;
  if (!next) return previous;

  const lastChar = previous[previous.length - 1] ?? '';
  const firstChar = next[0] ?? '';

  if (/\s/.test(lastChar) || /\s/.test(firstChar)) {
    return previous + next;
  }

  const nextStartsCapital = /[A-Z\p{Lu}]/u.test(firstChar);
  if (!nextStartsCapital) {
    return previous + next;
  }

  const prevEndsBoundary = /[\p{L}\p{N}.!?;:。！？；：…]/u.test(lastChar);
  if (!prevEndsBoundary) {
    return previous + next;
  }

  const prevEndsSentencePunctuation = /[.!?;:。！？；：…]/.test(lastChar);
  const nextIsMultiWordPhrase = /\s/.test(next);
  const nextIsGerundStatusVerb = /^[A-Z\p{Lu}][\p{L}'-]*ing\b/u.test(next);
  if (!prevEndsSentencePunctuation && !nextIsMultiWordPhrase && !nextIsGerundStatusVerb) {
    return previous + next;
  }

  return `${previous}\n${next}`;
}
