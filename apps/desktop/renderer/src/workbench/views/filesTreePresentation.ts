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

export function directoryReadMessage(status: string, isZh: boolean): string {
  const labels: Record<string, readonly [string, string]> = {
    truncated: ['仅显示前 1000 项；可筛选已加载条目或打开子目录。', 'Showing the first 1000 entries. Filter loaded entries or open a subfolder.'],
    permission_denied: ['没有读取此目录的权限。', 'Reading this directory is not permitted.'],
    scope_denied: ['此目录超出当前允许范围。', 'This directory is outside the permitted scope.'],
    not_found: ['目录已不存在或被移动。', 'This directory is missing or was moved.'],
    not_dir: ['此位置已经不是目录。', 'This location is no longer a directory.'],
    workspace_unavailable: ['此目录的来源当前不可用。', 'This directory source is unavailable.'],
  };
  const message = labels[status]?.[isZh ? 0 : 1] ?? (isZh ? '未能读取此目录。' : 'The directory could not be read.');
  return status === 'truncated' ? message : message + (isZh ? ' 保留上次目录，可刷新重试。' : ' The previous tree is retained. Refresh to retry.');
}

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
