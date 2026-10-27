/** Captures one already-read listing, never walks or reads file bodies. */
export function directoryFeedbackExcerpt(entries: readonly { readonly name: string; readonly isDir: boolean }[], selected: string | null, incomplete: boolean, isZh: boolean): string {
  const lines = [isZh ? '已读取的目录清单（文件正文未读取）' : 'Loaded directory listing (file contents were not read)'];
  if (selected) lines.push(isZh ? `选中路径：${selected}` : `Selected path: ${selected}`);
  let count = 0;
  for (const item of entries) {
    const line = `${item.isDir ? '[directory]' : '[file]'} ${item.name}`;
    if (count >= 50 || lines.join('\n').length + line.length + 180 > 8192) break;
    lines.push(line); count++;
  }
  lines.push(isZh ? `本引用含 ${count}/${entries.length} 个已列举项${incomplete || count < entries.length ? '；仅为部分清单' : ''}。` : `This reference includes ${count}/${entries.length} listed entries${incomplete || count < entries.length ? '; partial listing' : ''}.`);
  return lines.join('\n');
}
