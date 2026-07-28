/**
 * Join streamed thinking/reasoning deltas without gluing adjacent status phrases.
 *
 * Keep this pure-JS helper in lockstep with packages/chat-kernel joinThinkingContent:
 * Electron main cannot import the TypeScript package entry at runtime.
 *
 * Providers (esp. GPT reasoning summaries) often emit short status phrases that
 * lack a trailing space/newline. Naive string concat turns
 * "Planning inspection" + "Investigating path" into "...inspectionInvestigating...".
 */
export function joinThinkingContent(previous, next) {
  if (!previous) return next;
  if (!next) return previous;

  const lastChar = previous[previous.length - 1] ?? '';
  const firstChar = next[0] ?? '';

  // Provider already separated chunks (space / newline / tab / CJK full-width space).
  if (/\s/.test(lastChar) || /\s/.test(firstChar)) {
    return previous + next;
  }

  // Only intervene when the next delta looks like a new status phrase:
  // starts with an uppercase letter (Latin / Unicode Lu), while previous ends
  // with a word char or sentence-ending punctuation. Mid-token streams
  // ("Plan"+"ning") and CJK continuations stay untouched.
  const nextStartsStatusPhrase = /[A-Z\p{Lu}]/u.test(firstChar);
  if (!nextStartsStatusPhrase) {
    return previous + next;
  }

  const prevEndsBoundary = /[\p{L}\p{N}.!?;:。！？；：…]/u.test(lastChar);
  if (!prevEndsBoundary) {
    return previous + next;
  }

  return `${previous}\n${next}`;
}
