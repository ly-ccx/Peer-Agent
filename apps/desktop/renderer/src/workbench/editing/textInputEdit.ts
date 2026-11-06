/** HTML textarea normalizes line endings. Preserve unchanged source bytes outside the actual edit. */
export const textareaText = (text: string) => text.replace(/\r\n?/g, '\n');
export function textInputEdit(previous: string, input: string): string {
  const before = textareaText(previous), after = textareaText(input);
  if (before === after) return previous;
  let start = 0, endBefore = before.length, endAfter = after.length;
  while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  const rawOffset = (position: number) => {
    let raw = 0, visible = 0;
    while (visible < position && raw < previous.length) { if (previous[raw] === '\r' && previous[raw + 1] === '\n') raw++; raw++; visible++; }
    return raw;
  };
  const rawStart = rawOffset(start), rawEnd = rawOffset(endBefore);
  const endings = previous.slice(0, rawStart).match(/\r\n|\r|\n/g) ?? previous.match(/\r\n|\r|\n/g);
  const newline = endings?.at(-1) ?? '\n';
  return previous.slice(0, rawStart) + after.slice(start, endAfter).replace(/\n/g, newline) + previous.slice(rawEnd);
}
