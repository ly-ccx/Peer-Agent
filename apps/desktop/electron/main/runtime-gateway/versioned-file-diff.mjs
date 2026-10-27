/** Actual text comparison, bounded for presentation. Never an executable patch or a current Git claim. */
export function versionedFileDiff(filePath, before, after, maxChars = 4000) {
  if (before === after) return { text: '', truncated: false, additions: 0, deletions: 0 };
  const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const old = lines(before), next = lines(after); let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 2), oldEnd = Math.min(old.length, old.length - suffix + 2), nextEnd = Math.min(next.length, next.length - suffix + 2);
  const range = (from, count) => `${count ? from + 1 : from},${count}`;
  const out = [`--- ${JSON.stringify(filePath)}`, `+++ ${JSON.stringify(filePath)}`, `@@ -${range(start, oldEnd - start)} +${range(start, nextEnd - start)} @@`];
  let size = out.join('\n').length, truncated = false;
  const emit = (mark, text) => {
    const row = mark + (text.endsWith('\n') ? text.slice(0, -1) : text);
    const rows = [row, ...(!text.endsWith('\n') ? ['\\ No newline at end of file'] : [])];
    for (const line of rows) { if (size + line.length + 1 > maxChars) { truncated = true; return false; } out.push(line); size += line.length + 1; }
    return true;
  };
  for (let i = start; i < prefix && !truncated; i++) emit(' ', old[i]);
  for (let i = prefix; i < old.length - suffix && !truncated; i++) emit('-', old[i]);
  for (let i = prefix; i < next.length - suffix && !truncated; i++) emit('+', next[i]);
  for (let i = old.length - suffix; i < oldEnd && !truncated; i++) emit(' ', old[i]);
  return { text: out.join('\n'), truncated, additions: next.length - prefix - suffix, deletions: old.length - prefix - suffix };
}
