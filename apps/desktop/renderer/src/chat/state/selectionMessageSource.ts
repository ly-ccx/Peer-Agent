/** A display segment is selectable only after every text segment proves the full source. */
export interface SelectionMessageSource {
  readonly text: string;
  readonly start: number;
}

export function mapSelectionMessageSources<T extends { readonly type: string; readonly content?: string }>(
  text: string,
  groups: readonly T[],
): ReadonlyMap<T, SelectionMessageSource> {
  const mapped = new Map<T, SelectionMessageSource>();
  let cursor = 0;
  for (const group of groups) {
    if (group.type !== 'text') continue;
    const content = group.content;
    if (typeof content !== 'string' || text.slice(cursor, cursor + content.length) !== content) return new Map();
    mapped.set(group, { text, start: cursor });
    cursor += content.length;
  }
  // A prefix match does not prove that the displayed segments represent the message.
  return cursor === text.length ? mapped : new Map();
}
