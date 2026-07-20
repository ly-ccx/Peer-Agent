import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface MessageImageLike {
  readonly url: string;
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
}

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  '.avif',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
};

/** Slash-command form: `/help`, `/model foo`. Paths like `/var/...` or `/Users/...` are not commands. */
export function isSlashCommandInput(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return false;
  // Absolute path (POSIX) or Windows-ish rooted path fragments after `/`
  if (/^\/(?:[A-Za-z]:[\\/]|Users\/|home\/|var\/|tmp\/|private\/|opt\/|usr\/|etc\/|\.|~)/.test(trimmed)) {
    return false;
  }
  // Pure path with image extension or multi-segment path starting with `/.../`
  if (/\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)(?:\s|$)/i.test(trimmed)) {
    return false;
  }
  // Slash commands: `/cmd` or `/cmd args` without path separators in the command token
  return /^\/[A-Za-z][\w-]*(?:\s|$)/.test(trimmed);
}

function stripWrappingQuotes(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"'))
    || (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function isImagePathCandidate(token: string): boolean {
  const cleaned = stripWrappingQuotes(token.trim());
  if (!cleaned) return false;
  if (cleaned.startsWith('data:image/')) return true;
  const ext = path.extname(cleaned.split('?')[0] ?? cleaned).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Extract local image path tokens from free-form composer text.
 * Supports absolute paths, relative paths, file:// URLs, and otty-paste temp paths.
 */
export function extractImagePathTokens(text: string): string[] {
  const tokens = text.match(/(?:file:\/\/)?(?:\/|\.\/|\.\.\/|~\/)?[^\s"'`]+/g) ?? [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of tokens) {
    const token = stripWrappingQuotes(raw);
    if (!isImagePathCandidate(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    paths.push(token);
  }
  return paths;
}

export function stripImagePathsFromText(text: string, imagePaths: readonly string[]): string {
  let next = text;
  for (const imagePath of imagePaths) {
    const escaped = imagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    next = next.replace(new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'g'), ' ');
  }
  return next.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function expandHome(filePath: string): string {
  if (filePath.startsWith('~/')) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (home) return path.join(home, filePath.slice(2));
  }
  return filePath;
}

function normalizeLocalPath(token: string): string {
  if (token.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(token).pathname);
    } catch {
      return token.replace(/^file:\/\//, '');
    }
  }
  return expandHome(token);
}

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadLocalImageAttachments(
  text: string,
  options?: { readonly maxBytes?: number },
): Promise<{
  readonly text: string;
  readonly images: readonly MessageImageLike[];
  readonly displayContent: string;
  readonly missingPaths: readonly string[];
}> {
  const maxBytes = options?.maxBytes ?? 8 * 1024 * 1024;
  const tokens = extractImagePathTokens(text);
  const images: MessageImageLike[] = [];
  const usedPaths: string[] = [];
  const missingPaths: string[] = [];

  for (const token of tokens) {
    if (token.startsWith('data:image/')) {
      images.push({ url: token });
      usedPaths.push(token);
      continue;
    }

    const localPath = path.resolve(normalizeLocalPath(token));
    if (!(await pathExists(localPath))) {
      missingPaths.push(token);
      continue;
    }

    const buffer = await readFile(localPath);
    if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) {
      missingPaths.push(token);
      continue;
    }

    const mimeType = mimeTypeForPath(localPath);
    if (!mimeType.startsWith('image/')) {
      missingPaths.push(token);
      continue;
    }

    images.push({
      url: `data:${mimeType};base64,${buffer.toString('base64')}`,
      mimeType,
    });
    usedPaths.push(token);
  }

  const remainingText = stripImagePathsFromText(text, usedPaths);
  const labels = usedPaths.map((item) => path.basename(normalizeLocalPath(item)));
  const displayContent = remainingText
    || (labels.length > 0 ? `[image${labels.length > 1 ? 's' : ''}: ${labels.join(', ')}]` : text.trim());

  return {
    text: remainingText,
    images,
    displayContent,
    missingPaths,
  };
}
