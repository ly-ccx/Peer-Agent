/** Explicit inline-code / Markdown destinations, never commands, URLs or arbitrary prose. */
export function documentReferencePath(raw: string): string | null {
  const value = raw.trim().replace(/#L\d+(?:-L\d+)?$/, '');
  if (!value || value.startsWith('-') || /[\u0000-\u001f]/.test(value)
    || /^[a-z][\w+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null;
  const line = value.match(/^(.+?):\d+(?::\d+)?$/);
  const path = line ? line[1]! : value;
  return /[\\/]/.test(path) || /^[^\\/:]+\.[a-z0-9]{1,12}$/i.test(path) ? path : null;
}
import { detectFileKind } from '../../../workbench/file-preview/fileTypes.ts';


/** Keep literal text and selection offsets intact while recognizing unformatted paths. */
export function documentReferencesInText(text: string): readonly { readonly text: string; readonly path?: string }[] {
  const parts: { text: string; path?: string }[] = [];
  const tokens = /(?:^|[\s（(：])([^\s<>()[\]{}，。！？；："'`]+)/gu;
  let cursor = 0;
  for (const match of text.matchAll(tokens)) {
    const token = match[1]!.replace(/[.,;!?]+$/, '');
    const candidate = documentReferencePath(token);
    if (!candidate || !/[\\/]/.test(candidate) && detectFileKind(candidate) === 'unknown') continue;
    const start = match.index! + match[0].length - match[1]!.length;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: token, path: candidate });
    cursor = start + token.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts.length ? parts : [{ text }];
}
