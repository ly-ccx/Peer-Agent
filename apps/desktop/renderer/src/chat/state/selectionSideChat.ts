/** UI-only projection of authorized relation data. No storage or execution. */
export interface InlineChildRelation {
  childId: string;
  sourceMessageId: string;
  sourceRevision: number;
  start: number;
  end: number;
  exactText: string;
  createdAt: string;
}
export interface InlineChildMark {
  start: number;
  end: number;
  childIds: string[];
}

/** Split overlapping ranges without losing either discussion. Offsets are UTF-16. */
export function projectInlineChildMarks(
  message: { id: string; revision: number; text: string },
  relations: readonly InlineChildRelation[],
): { marks: InlineChildMark[]; unavailableChildIds: string[] } {
  const valid: InlineChildRelation[] = [];
  const unavailable = new Set<string>();
  const ordered = [...relations].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.childId.localeCompare(b.childId));
  for (const relation of ordered) {
    if (relation.sourceMessageId !== message.id) continue;
    if (relation.sourceRevision !== message.revision
      || !Number.isSafeInteger(relation.start) || !Number.isSafeInteger(relation.end)
      || relation.start < 0 || relation.end <= relation.start || relation.end > message.text.length
      || message.text.slice(relation.start, relation.end) !== relation.exactText) {
      unavailable.add(relation.childId);
    } else valid.push(relation);
  }
  const endpoints = [...new Set(valid.flatMap((r) => [r.start, r.end]))].sort((a, b) => a - b);
  const marks: InlineChildMark[] = [];
  for (let i = 0; i < endpoints.length - 1; i++) {
    const start = endpoints[i];
    const end = endpoints[i + 1];
    const childIds = [...new Set(valid.filter((r) => r.start < end && r.end > start).map((r) => r.childId))];
    if (childIds.length) marks.push({ start, end, childIds });
  }
  return { marks, unavailableChildIds: [...unavailable] };
}

export type InlineNavigation =
  | { kind: 'none' }
  | { kind: 'open'; childId: string }
  | { kind: 'list'; childIds: string[] };

/** Drag-selection and hover never navigate. Existing marks never create sessions. */
export function resolveInlineChildNavigation(
  childIds: readonly string[],
  action: 'hover' | 'click' | 'keyboard' | 'restore',
  hasTextSelection = false,
): InlineNavigation {
  const ids = [...new Set(childIds)];
  if (action === 'hover' || hasTextSelection || ids.length === 0) return { kind: 'none' };
  return ids.length === 1 ? { kind: 'open', childId: ids[0] } : { kind: 'list', childIds: ids };
}
