/** Unified hunk coordinates are display facts only; malformed input must not invent line numbers. */
export function parseUnifiedHunk(line: string) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return null;
  const [oldStart, oldCount, newStart, newCount] = [Number(match[1]), Number(match[2] ?? 1), Number(match[3]), Number(match[4] ?? 1)];
  if (![oldStart, oldCount, newStart, newCount, oldStart! + oldCount!, newStart! + newCount!].every(Number.isSafeInteger)
    || (oldCount! > 0 && oldStart === 0) || (newCount! > 0 && newStart === 0)) return null;
  return { oldStart: oldStart!, oldCount: oldCount!, newStart: newStart!, newCount: newCount! };
}
export function isNoNewlineMarker(line: string) { return line === String.fromCharCode(92) + ' No newline at end of file'; }
export function hasMalformedUnifiedHunks(text: string): boolean {
  let oldLeft = 0, newLeft = 0, seenHunk = false, fileHeaderSeen = false;
  for (const line of text.replace(/\n$/, '').split('\n')) {
    if (isNoNewlineMarker(line)) continue;
    if (line.startsWith('@@')) {
      const hunk = parseUnifiedHunk(line);
      if (oldLeft || newLeft || !hunk) return true;
      oldLeft = hunk.oldCount; newLeft = hunk.newCount; seenHunk = true; continue;
    }
    if (oldLeft || newLeft) {
      if (line.startsWith(' ')) { oldLeft--; newLeft--; }
      else if (line.startsWith('-')) oldLeft--;
      else if (line.startsWith('+')) newLeft--;
      else return true;
      if (oldLeft < 0 || newLeft < 0) return true;
    } else if (line.startsWith('diff ')) fileHeaderSeen = false;
    else if (line.startsWith('--- ')) { if (fileHeaderSeen) return true; fileHeaderSeen = true; }
    else if (seenHunk && /^[ +\-]/.test(line) && !/^(?:--- |\+\+\+ )/.test(line)) return true;
  }
  return oldLeft !== 0 || newLeft !== 0;
}
