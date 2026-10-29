import type { BotResourceReferenceHint } from '@peer-agent/protocol';

export function referencesForReplyParagraph(id: string, messages: readonly { readonly id: string; readonly turnId?: string; readonly resourceReferences?: readonly BotResourceReferenceHint[] }[],
  activity?: { readonly turnId: string; readonly resourceReferences?: readonly BotResourceReferenceHint[] }): readonly BotResourceReferenceHint[] {
  const separator = id.lastIndexOf(':');
  if (separator < 1) return [];
  const turnId = id.slice(0, separator);
  const stored = messages.filter(source => (source.turnId || source.id) === turnId).flatMap(source => source.resourceReferences ?? []);
  return stored.length ? [...new Map(stored.map(ref => [ref.path, ref])).values()]
    : activity?.turnId === turnId ? activity.resourceReferences ?? [] : [];
}

export function botResourceCandidates(path: string, references: readonly BotResourceReferenceHint[]): readonly string[] {
  const suffix = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return [...new Set(references.filter(ref => ref.path.replace(/\\/g, '/').endsWith(`/${suffix}`)).map(ref => ref.path))];
}

/** A display basename is usable only when this turn has exactly one matching source. */
export function resolveBotResourceDisplay(path: string, references: readonly BotResourceReferenceHint[]): string | null {
  const normalized = path.replace(/\\/g, '/');
  if (/^(?:\/|[A-Za-z]:\/)/.test(normalized)) return path;
  const suffix = normalized.replace(/^\.\//, '');
  const matches = botResourceCandidates(path, references);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 || !suffix.includes('/')) return null;
  // An explicit relative path remains a reference for host resolution, never a guessed basename.
  return path;
}
