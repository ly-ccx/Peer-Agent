import { detectFileKind } from '../../../workbench/file-preview/fileTypes.ts';

const FILE_NAME = /^(?:readme|licen[cs]e|copying|notice|changelog|dockerfile|containerfile|makefile|gnumakefile|justfile|procfile|gemfile|rakefile|\.gitignore|\.gitattributes|\.gitmodules|\.editorconfig|\.npmrc|\.nvmrc|\.prettierrc|\.eslintrc|\.env(?:\.[\w-]+)*)$/i;

/** A slash alone is not file evidence: Git refs and repository names use it too. */
export function documentReferencePath(raw: string): string | null {
  const value = raw.trim().replace(/#L\d+(?:-L\d+)?$/, '');
  if (!value || value.startsWith('-') || /[\u0000-\u001f<>|;&`$]/.test(value)
    || /^(?:git|pnpm|npm|yarn|bun|node|python\d*|cd|cat|rg|ls|bash|sh|zsh|curl)\s/i.test(value)) return null;
  const line = value.match(/^(.+?):\d+(?::\d+)?$/);
  const path = line ? line[1]! : value;
  if (/^[a-z][\w+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null;
  const normalized = path.replace(/\\/g, '/');
  if (/^(?:refs\/(?:heads|tags|remotes)\/|origin\/)/i.test(normalized) || normalized.endsWith('/')) return null;
  const name = normalized.split('/').at(-1)!;
  return FILE_NAME.test(name) || detectFileKind(path) !== 'unknown'
    || normalized.includes('/') && /\.[a-z][a-z0-9]{0,11}$/i.test(name) ? path : null;
}

/** Explicit prose labels take precedence even when a branch ends in .md. */
export function isGitReferenceContext(prefix: string): boolean {
  return /(?:分支|标签|(?:git\s+)?\b(?:branch|ref|tag))\s*(?:名(?:称)?\s*)?(?:为|是|[:：=])?\s*$/i.test(prefix)
    || /\bgit\s+(?:switch|checkout|branch)\s+(?:(?:-\S+)\s+)*$/i.test(prefix);
}

/** Keep literal text and selection offsets intact while recognizing unformatted paths. */
export function documentReferencesInText(text: string): readonly { readonly text: string; readonly path?: string }[] {
  const parts: { text: string; path?: string }[] = [];
  const tokens = /(?:^|[\s（(：])([^\s<>()[\]{}，。！？；："'`]+)/gu;
  let cursor = 0;
  for (const match of text.matchAll(tokens)) {
    const token = match[1]!.replace(/[.,;!?]+$/, '');
    const candidate = documentReferencePath(token);
    const start = match.index! + match[0].length - match[1]!.length;
    if (!candidate || isGitReferenceContext(text.slice(0, start))) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: token, path: candidate });
    cursor = start + token.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts.length ? parts : [{ text }];
}
