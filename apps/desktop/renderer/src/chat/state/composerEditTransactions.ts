export interface ComposerEditValue { readonly text: string; readonly start: number; readonly end: number }

/** Local text history only. Quotes, attachments and durable drafts retain their owners. */
export function createComposerEditTransactions(now = Date.now) {
  let values: ComposerEditValue[] = [], index = -1, previousKind = '', previousAt = 0;
  function reset(value: ComposerEditValue) { values = [value]; index = 0; previousKind = ''; }
  return {
    reset,
    record(before: ComposerEditValue, after: ComposerEditValue, kind = 'edit') {
      if (before.text === after.text) return;
      if (values[index]?.text !== before.text) reset(before);
      const coalesce = kind === 'typing' && previousKind === kind && index > 0
        && index === values.length - 1 && now() - previousAt < 750
        && values[index]!.start === before.start && before.start === before.end;
      if (coalesce) values[index] = after;
      else { values[index] = before; values = [...values.slice(0, index + 1), after].slice(-100); index = values.length - 1; }
      previousKind = kind; previousAt = now();
    },
    undo(current: string) {
      if (values[index]?.text !== current || index < 1) return null;
      previousKind = ''; return values[--index]!;
    },
    redo(current: string) {
      if (values[index]?.text !== current || index >= values.length - 1) return null;
      previousKind = ''; return values[++index]!;
    },
  };
}
