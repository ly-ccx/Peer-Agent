import type { WorkbenchFileMode } from '../documentSessionState';

export type WorkbenchFileKind =
  | 'markdown'
  | 'json'
  | 'code'
  | 'text'
  | 'image'
  | 'html'
  | 'unknown';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'jsonl']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const HTML_EXTENSIONS = new Set(['html', 'htm']);
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
  if (HTML_EXTENSIONS.has(ext)) return 'html';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unknown';
}

export function defaultModeForKind(kind: WorkbenchFileKind): WorkbenchFileMode {
  if (kind === 'markdown' || kind === 'json' || kind === 'image' || kind === 'html') return 'preview';
  return 'source';
}

export function formatJsonForPreview(content: string): string | null {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return null;
  }
}

/**
 * 把文件扩展名映射到 highlight.js 语言 id / 已注册别名。
 * 未覆盖的扩展名返回 null，调用方应回退纯文本。
 */
const HIGHLIGHT_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  graphql: 'plaintext',
  gd: 'plaintext',
  html: 'html',
  htm: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsonl: 'json',
  kt: 'kotlin',
  less: 'less',
  lua: 'lua',
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  swift: 'swift',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  vue: 'xml',
  xml: 'xml',
  svg: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  env: 'ini',
  txt: 'plaintext',
  log: 'plaintext',
};

export function highlightLanguageForPath(path: string): string | null {
  const ext = extension(path);
  if (!ext) return null;
  return HIGHLIGHT_LANGUAGE_BY_EXTENSION[ext] ?? null;
}
