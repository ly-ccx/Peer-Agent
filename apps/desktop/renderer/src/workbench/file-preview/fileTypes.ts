import type { WorkbenchFileMode } from '../documentSessionState';

export type WorkbenchFileKind =
  | 'markdown'
  | 'json'
  | 'code'
  | 'text'
  | 'image'
  | 'unknown';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'jsonl']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const TEXT_EXTENSIONS = new Set(['txt', 'log', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini', 'env']);
const CODE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'go',
  'gd',
  'graphql',
  'h',
  'hpp',
  'html',
  'java',
  'js',
  'jsx',
  'kt',
  'lua',
  'mjs',
  'mts',
  'php',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'swift',
  'ts',
  'tsx',
  'vue',
  'xml',
]);

export function basename(path: string): string {
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

export function extension(path: string): string {
  const name = basename(path);
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

export function detectFileKind(path: string): WorkbenchFileKind {
  const ext = extension(path);
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (JSON_EXTENSIONS.has(ext)) return 'json';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unknown';
}

export function defaultModeForKind(kind: WorkbenchFileKind): WorkbenchFileMode {
  if (kind === 'markdown' || kind === 'json') return 'preview';
  return 'source';
}

export function formatJsonForPreview(content: string): string | null {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return null;
  }
}
