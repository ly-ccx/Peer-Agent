export type FileVisualKind =
  | 'folder'
  | 'markdown'
  | 'code'
  | 'style'
  | 'config'
  | 'image'
  | 'archive'
  | 'git'
  | 'file';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);
const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'go', 'h', 'hpp', 'java', 'js', 'jsx', 'kt', 'lua', 'mjs',
  'mts', 'php', 'py', 'rb', 'rs', 'sh', 'sql', 'swift', 'ts', 'tsx', 'vue',
]);
const STYLE_EXTENSIONS = new Set(['css', 'less', 'sass', 'scss', 'styl']);
const CONFIG_EXTENSIONS = new Set([
  'env', 'ini', 'json', 'jsonc', 'jsonl', 'lock', 'properties', 'toml', 'xml', 'yaml', 'yml',
]);
const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const ARCHIVE_EXTENSIONS = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip']);
const GIT_FILE_NAMES = new Set(['.gitignore', '.gitattributes', '.gitmodules']);
const CONFIG_FILE_NAMES = new Set([
  '.editorconfig', '.env', '.npmrc', '.prettierrc', 'dockerfile', 'makefile', 'package.json',
  'pnpm-lock.yaml', 'tsconfig.json', 'vite.config.ts',
]);

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** Single source of truth for the visual language used by the Files tree. */
export function getFileVisualKind(name: string, isDir: boolean): FileVisualKind {
  if (isDir) return 'folder';

  const normalizedName = name.toLowerCase();
  if (GIT_FILE_NAMES.has(normalizedName)) return 'git';
  if (CONFIG_FILE_NAMES.has(normalizedName)) return 'config';

  const extension = fileExtension(normalizedName);
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  if (STYLE_EXTENSIONS.has(extension)) return 'style';
  if (CONFIG_EXTENSIONS.has(extension)) return 'config';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  return 'file';
}
