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

const IMAGE_CHIP_RE = /\[Image ([^\]]+)\]/g;
const IMAGE_CHIP_SPLIT_RE = /(\[Image [^\]]+\])/g;

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
  // Display chip labels like "...41-F4C365D4.png" must never re-enter chipify.
  if (
    cleaned.startsWith('...')
    || cleaned.includes('[Image ')
    || cleaned.includes(']')
  ) {
    return false;
  }
  const ext = path.extname(cleaned.split('?')[0] ?? cleaned).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return false;
  // Require a path-like token so truncated basenames cannot be treated as files.
  return (
    cleaned.startsWith('/')
    || cleaned.startsWith('./')
    || cleaned.startsWith('../')
    || cleaned.startsWith('~/')
    || cleaned.startsWith('file:')
    || cleaned.includes('/')
    || cleaned.includes('\\')
  );
}

const IMAGE_EXT_PATTERN = '(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)';
// Match image paths even when glued to non-ASCII text (e.g. Chinese) without spaces.
// Stop at whitespace / quotes / brackets / common CJK punctuation, not at every non-word char.
const IMAGE_PATH_CANDIDATE_RE = new RegExp(
  `(?:file:\\/\\/)?(?:\\/|\\.\\/|\\.\\.\\/|~\\/)?[^\\s"'\`<>\\[\\]{}|，。；：！？、（）【】《》]+?\\.${IMAGE_EXT_PATTERN}(?=$|[\\s"'\`<>\\[\\]{}|，。；：！？、（）【】《》]|[^\\w./\\\\-])`,
  'gi',
);

/**
 * If text is glued in front of a path (e.g. Chinese + absolute path), keep only the path.
 */
function refineImagePathToken(raw: string): string {
  const token = stripWrappingQuotes(raw);
  if (!token) return token;
  // Prefer absolute/relative path markers inside the match.
  const absolute = token.match(
    /(?:file:\/\/|\/|\.\/|\.\.\/|~\/)[^\s"'`<>\[\]{}|，。；：！？、（）【】《》]*?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)/i,
  );
  if (absolute?.[0]) return absolute[0];
  // Bare relative image file name (no directory prefix).
  const relative = token.match(
    /(?:^|[^A-Za-z0-9._-])([A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif))$/i,
  );
  if (relative?.[1]) return relative[1];
  return token;
}

/**
 * Extract local image path tokens from free-form composer text.
 * Supports absolute paths, relative paths, file:// URLs, and otty-paste temp paths.
 * Paths glued to CJK/non-ASCII text (no whitespace) are also extracted.
 */
function maskImageChips(text: string): string {
  // Same-length spaces keep match indices aligned with the original text while
  // hiding path-like fragments that live inside chip labels.
  return text.replace(IMAGE_CHIP_RE, (full) => ' '.repeat(full.length));
}

export function extractImagePathTokens(text: string): string[] {
  if (!text.trim()) return [];
  const masked = maskImageChips(text);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const match of masked.matchAll(IMAGE_PATH_CANDIDATE_RE)) {
    const start = match.index ?? 0;
    const raw = text.slice(start, start + (match[0]?.length ?? 0));
    const token = refineImagePathToken(raw);
    if (!isImagePathCandidate(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    paths.push(token);
  }
  return paths;
}

/**
 * Split the draft into meaningful segments (text fragments and image chips)
 * and check whether every non-empty segment still appears in target.
 * This detects mid-text insertion where the previous draft is preserved
 * but split by the newly pasted content.
 *
 * Segments are split on image chips AND on whitespace, because a pasted
 * image path inserted at the caret will also split plain text fragments.
 */
function allSegmentsPresentIn(draft: string, target: string): boolean {
  // Split on image chips, keeping the chips as segments too.
  const chipSegments = draft
    .split(IMAGE_CHIP_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Further split each non-chip segment on whitespace into word-like tokens.
  const segments: string[] = [];
  for (const seg of chipSegments) {
    if (seg.startsWith('[Image ') && seg.endsWith(']')) {
      // Image chip — keep as-is.
      segments.push(seg);
    } else {
      // Plain text — split on whitespace to handle mid-word insertion.
      const words = seg.split(/\s+/).filter((w) => w.length > 0);
      if (words.length === 0) continue;
      segments.push(...words);
    }
  }
  if (segments.length === 0) return false;
  // Every segment must appear in target for this to be a mid-text insertion.
  return segments.every((seg) => target.includes(seg));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/**
 * Some terminals / paste helpers can deliver a pasted image path as a full textarea
 * replacement instead of inserting it at the caret. If the previous draft is still
 * meaningful and the next value contains an image path but lost the previous draft,
 * preserve the user's typed prompt and append the pasted image token.
 */
export function mergeImagePasteWithExistingDraft(nextText: string, previousDraft: string): string {
  if (!previousDraft.trim() || !nextText.trim()) return nextText;
  if (nextText.includes(previousDraft) || previousDraft.includes(nextText)) return nextText;
  const imagePaths = extractImagePathTokens(nextText);
  if (imagePaths.length === 0) return nextText;

  // Check whether all non-empty segments of the previous draft (text fragments
  // and image chips alike) are still present in nextText. If they are, the
  // paste was an insertion at the caret, not a full-textarea replacement, so
  // we must not merge — doing so would duplicate the existing content.
  if (allSegmentsPresentIn(previousDraft, nextText)) return nextText;

  const previous = previousDraft.replace(/[ 	]+$/g, '');
  const next = nextText.replace(/^[ 	]+/g, '');
  const separator = previous.length === 0 || previous.endsWith('\n') ? '' : ' ';
  return `${previous}${separator}${next}`;
}

export function stripImagePathsFromText(text: string, imagePaths: readonly string[]): string {
  let next = text;
  // Longer paths first so nested/overlapping tokens strip cleanly.
  const ordered = [...imagePaths].sort((a, b) => b.length - a.length);
  for (const imagePath of ordered) {
    if (!imagePath) continue;
    const escaped = escapeRegExp(imagePath);
    // Allow paths glued to non-ASCII text (no leading/trailing whitespace required).
    next = next.replace(new RegExp(escaped, 'g'), ' ');
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

/** Visible chip token, Qoder-style: `[Image ...tail.png]` or `[Image short.png]`. */
export function formatImagePathChip(filePath: string, maxVisible = 18): string {
  const base = path.basename(normalizeLocalPath(filePath));
  if (!base) return '[Image]';
  if (base.length <= maxVisible) return `[Image ${base}]`;
  const keep = Math.max(6, maxVisible - 3);
  return `[Image ...${base.slice(-keep)}]`;
}

/**
 * Replace raw image path tokens in composer text with compact chips.
 * Already-chipped segments are preserved, nested chips are flattened, and
 * path-like fragments inside chip labels are never re-wrapped.
 */
export function chipifyImagePathsInText(text: string): string {
  if (!text) return text;
  // Flatten accidental nested chips produced by previous paste/chipify cycles.
  let next = text;
  let guard = 0;
  while (guard < 4 && next.includes('[Image [Image ')) {
    next = next.replace(/\[Image (\[Image [^\]]+\])\]/g, '$1');
    guard += 1;
  }

  const parts = next.split(IMAGE_CHIP_SPLIT_RE);
  return parts
    .map((part) => {
      if (part.startsWith('[Image ') && part.endsWith(']')) {
        // Never scan chip labels for nested paths. If a previous cycle stored a
        // full filesystem path inside the chip, compact it back to a short label
        // so soft-wrap cannot split a long absolute path mid-token.
        const inner = part.slice('[Image '.length, -1).trim();
        if (isImagePathCandidate(inner)) {
          return formatImagePathChip(inner);
        }
        return part;
      }
      // Only scan non-chip text for real filesystem paths.
      return part.replace(IMAGE_PATH_CANDIDATE_RE, (raw) => {
        const token = refineImagePathToken(raw);
        if (!isImagePathCandidate(token)) return raw;
        const start = raw.indexOf(token);
        if (start < 0) return formatImagePathChip(token);
        const prefix = raw.slice(0, start);
        const suffix = raw.slice(start + token.length);
        return `${prefix}${formatImagePathChip(token)}${suffix}`;
      });
    })
    .join('');
}


function imagePathChipKeys(filePath: string): string[] {
  const normalized = path.resolve(normalizeLocalPath(filePath));
  const base = path.basename(normalized);
  const keys = new Set<string>([base, normalized, filePath, normalizeLocalPath(filePath)]);
  if (base.length > 18) {
    const keep = Math.max(6, 15);
    keys.add(`...${base.slice(-keep)}`);
    keys.add(base.slice(-keep));
  }
  return [...keys];
}

export function registerImagePathKeys(
  pathByKey: Map<string, string>,
  filePaths: readonly string[],
): void {
  for (const filePath of filePaths) {
    const absolute = path.resolve(normalizeLocalPath(filePath));
    for (const key of imagePathChipKeys(filePath)) {
      pathByKey.set(key, absolute);
    }
  }
}

export async function loadLocalImageAttachments(
  text: string,
  options?: {
    readonly maxBytes?: number;
    readonly pathByKey?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  },
): Promise<{
  readonly text: string;
  readonly images: readonly MessageImageLike[];
  readonly displayContent: string;
  readonly missingPaths: readonly string[];
}> {
  const maxBytes = options?.maxBytes ?? 8 * 1024 * 1024;
  const expanded = options?.pathByKey
    ? expandImageChipsInText(text, options.pathByKey)
    : text;
  const tokens = extractImagePathTokens(expanded);
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
    usedPaths.push(localPath);
  }

  let remainingText = stripImagePathsFromText(expanded, usedPaths);
  remainingText = remainingText
    .replace(IMAGE_CHIP_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const labels = usedPaths
    .filter((item) => !item.startsWith('data:image/'))
    .map((item) => path.basename(normalizeLocalPath(item)));
  const uniqueLabels = [...new Set(labels)];
  const displayContent = remainingText
    || (uniqueLabels.length > 0
      ? `[image${uniqueLabels.length > 1 ? 's' : ''}: ${uniqueLabels.join(', ')}]`
      : text.trim());

  return {
    text: remainingText,
    images,
    displayContent,
    missingPaths,
  };
}

/**
 * Visible history placeholder for image attachments in TUI chat.
 * Terminal cannot render pixels; keep a stable chip so pure-image turns do not "disappear".
 */
export function expandImageChipsInText(
  text: string,
  pathByKey: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): string {
  const lookup = pathByKey instanceof Map
    ? pathByKey
    : new Map(Object.entries(pathByKey));
  return text.replace(IMAGE_CHIP_RE, (full, label: string) => {
    const key = String(label).trim();
    const bare = key.startsWith('...') ? key.slice(3) : key;
    const candidates = [key, bare, path.basename(bare)];
    for (const candidate of candidates) {
      const hit = lookup.get(candidate);
      if (hit) return hit;
    }
    for (const [mapKey, fullPath] of lookup.entries()) {
      const base = path.basename(fullPath);
      if (
        mapKey === key
        || mapKey === bare
        || base === key
        || base === bare
        || base.endsWith(bare)
      ) {
        return fullPath;
      }
    }
    return full;
  });
}

/** Register paths so later chip tokens can expand back to absolute paths. */
export function registerImagePathKeys(
  pathByKey: Map<string, string>,
  filePaths: readonly string[],
): void {
  for (const filePath of filePaths) {
    const absolute = path.resolve(normalizeLocalPath(filePath));
    for (const key of imagePathChipKeys(filePath)) {
      pathByKey.set(key, absolute);
    }
  }
}

export async function loadLocalImageAttachments(
  text: string,
  options?: {
    readonly maxBytes?: number;
    readonly pathByKey?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  },
): Promise<{
  readonly text: string;
  readonly images: readonly MessageImageLike[];
  readonly displayContent: string;
  readonly missingPaths: readonly string[];
}> {
  const maxBytes = options?.maxBytes ?? 8 * 1024 * 1024;
  const expanded = options?.pathByKey
    ? expandImageChipsInText(text, options.pathByKey)
    : text;
  const tokens = extractImagePathTokens(expanded);
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
    usedPaths.push(localPath);
  }

  let remainingText = stripImagePathsFromText(expanded, usedPaths);
  remainingText = remainingText
    .replace(IMAGE_CHIP_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const labels = usedPaths
    .filter((item) => !item.startsWith('data:image/'))
    .map((item) => path.basename(normalizeLocalPath(item)));
  const uniqueLabels = [...new Set(labels)];
  const displayContent = remainingText
    || (uniqueLabels.length > 0
      ? `[image${uniqueLabels.length > 1 ? 's' : ''}: ${uniqueLabels.join(', ')}]`
      : text.trim());

  return {
    text: remainingText,
    images,
    displayContent,
    missingPaths,
  };
}

/**
 * Visible history placeholder for image attachments in TUI chat.
 * Terminal cannot render pixels; keep a stable chip so pure-image turns do not "disappear".
 */
export function formatHistoryImageLabel(
  images: readonly MessageImageLike[] | undefined,
): string {
  const count = images?.length ?? 0;
  if (count <= 0) return '';
  if (count === 1) return '[Image]';
  return `[Images × ${count}]`;
}

function looksLikeImagePlaceholder(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Composer displayContent / older pure-image payloads.
  return /^\[images?\s*[:：]/i.test(trimmed) || /^\[Image(?:s)?\b/i.test(trimmed);
}

/**
 * User-visible body for a history bubble: typed text + optional image chip.
 * When content is only an auto image placeholder and images[] is present,
 * prefer the chip so pure-image turns do not render blank or duplicated.
 */
export function formatUserMessageBody(
  content: string,
  images?: readonly MessageImageLike[],
): { readonly text: string; readonly imageLabel: string | null } {
  const imageLabel = formatHistoryImageLabel(images) || null;
  const raw = content.trim();
  const text = raw && !(imageLabel && looksLikeImagePlaceholder(raw)) ? raw : '';
  return {
    text,
    imageLabel,
  };
}
