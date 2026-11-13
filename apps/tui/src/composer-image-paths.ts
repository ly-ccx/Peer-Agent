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

/**
 * Terminal paste of a path with spaces arrives shell-escaped (`Application\ Support`).
 * Turn those escapes back into the real pathname. Windows drive paths keep `\` as a separator.
 */
function unescapePosixShellEscapes(value: string): string {
  if (!value.includes('\\')) return value;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return value;
  return value.replace(/\\([ \t"'`$|&;<>(){}*?~\\])/g, '$1');
}

/** Quoted, shell-escaped, or file:// paste token → filesystem path. */
function normalizePastedImagePath(token: string): string {
  const unquoted = stripWrappingQuotes(token.trim());
  const unescaped = unescapePosixShellEscapes(unquoted);
  if (unescaped.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(unescaped).pathname);
    } catch {
      return unescaped.replace(/^file:\/\//, '');
    }
  }
  return unescaped;
}

function isImagePathCandidate(token: string): boolean {
  const cleaned = normalizePastedImagePath(token);
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

// Shell-escaped spaces (`\ `) stay inside the token. A raw space still ends it.
// Quoted pastes (`'/dir/My File.png'`) are one token even when the space is not escaped.
const IMAGE_PATH_CANDIDATE_RE = /(?:'(?:\\.|[^'\n])*?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)'|"(?:\\.|[^"\n])*?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)"|(?:file:\/\/|\/|\.\/|\.\.\/|~\/)?(?:\\[ \t"'`$|&;<>(){}*?~\\]|[^\s"'`<>\[\]{}|，。；：！？、（）【】《》])+?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif))(?=$|[\s"'`<>\[\]{}|，。；：！？、（）【】《》]|[^\w./\\-])/gi;

const IMAGE_PATH_ABSOLUTE_RE = /(?:file:\/\/|\/|\.\/|\.\.\/|~\/)(?:\\[ \t"'`$|&;<>(){}*?~\\]|[^\s"'`<>\[\]{}|，。；：！？、（）【】《》])*?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)/i;

/**
 * Substring of a regex match that should be replaced.
 * Keeps a CJK prefix outside the path, and keeps shell escapes plus surrounding
 * quotes so the raw paste text can be removed whole.
 */
function refineImagePathToken(raw: string): string {
  if (!raw) return raw;
  const quoted = raw.match(
    /(['"])(?:\\.|(?!\1)[^])*?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)\1/i,
  );
  if (quoted?.[0]) return quoted[0];
  const absolute = raw.match(IMAGE_PATH_ABSOLUTE_RE);
  if (absolute?.[0]) return absolute[0];
  // Bare relative image file name (no directory prefix).
  const relative = raw.match(
    /(?:^|[^A-Za-z0-9._-])([A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif))$/i,
  );
  if (relative?.[1]) return relative[1];
  return raw;
}

function pastedImagePathFromMatch(raw: string): { readonly rawPath: string; readonly normalized: string } | null {
  const rawPath = refineImagePathToken(raw);
  if (!rawPath) return null;
  const normalized = normalizePastedImagePath(rawPath);
  if (!isImagePathCandidate(normalized)) return null;
  return { rawPath, normalized };
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
    const parsed = pastedImagePathFromMatch(raw);
    if (!parsed) continue;
    if (seen.has(parsed.normalized)) continue;
    seen.add(parsed.normalized);
    paths.push(parsed.normalized);
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
  return expandHome(normalizePastedImagePath(token));
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

/**
 * Stable short id for an absolute path (FNV-1a → 6 hex chars).
 * Used so two files with the same basename still get distinct chip keys.
 */
export function shortImagePathId(filePath: string): string {
  const abs = path.resolve(normalizeLocalPath(filePath));
  let hash = 0x811c9dc5;
  for (let i = 0; i < abs.length; i += 1) {
    hash ^= abs.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

/**
 * Visible chip label (without brackets). Format:
 *   `short.png · a1b2c3` or `...tail.png · a1b2c3`
 * The id is a stable hash of the absolute path so same-basename files never collide.
 */
export function imagePathChipLabel(filePath: string, maxVisible = 18): string {
  const absolute = path.resolve(normalizeLocalPath(filePath));
  const base = path.basename(absolute);
  const id = shortImagePathId(absolute);
  if (!base) return id;
  const visible = base.length <= maxVisible
    ? base
    : `...${base.slice(-Math.max(6, maxVisible - 3))}`;
  return `${visible} · ${id}`;
}

/** Visible chip token: `[Image short.png · a1b2c3]`. */
export function formatImagePathChip(filePath: string, maxVisible = 18): string {
  const label = imagePathChipLabel(filePath, maxVisible);
  return label ? `[Image ${label}]` : '[Image]';
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
        const parsed = pastedImagePathFromMatch(raw);
        if (!parsed) return raw;
        const chip = formatImagePathChip(parsed.normalized);
        const start = raw.indexOf(parsed.rawPath);
        if (start < 0) return chip;
        const prefix = raw.slice(0, start);
        const suffix = raw.slice(start + parsed.rawPath.length);
        return `${prefix}${chip}${suffix}`;
      });
    })
    .join('');
}

function imagePathChipKeys(filePath: string): string[] {
  const absolute = path.resolve(normalizeLocalPath(filePath));
  const base = path.basename(absolute);
  const uniqueLabel = imagePathChipLabel(filePath);
  // Unique label first; absolute path next. Basename is only a soft fallback
  // (registered carefully so two same-basename paths never overwrite each other).
  const keys = new Set<string>([uniqueLabel, absolute, filePath, normalizeLocalPath(filePath)]);
  if (base) keys.add(base);
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
    const uniqueLabel = imagePathChipLabel(filePath);
    // Always pin unique identity keys (never collide across same basenames).
    pathByKey.set(uniqueLabel, absolute);
    pathByKey.set(absolute, absolute);
    pathByKey.set(normalizeLocalPath(filePath), absolute);
    pathByKey.set(filePath, absolute);

    // Soft keys (basename / truncated): only set when free or already this path.
    // Never let a later same-basename path silently overwrite an earlier one.
    for (const key of imagePathChipKeys(filePath)) {
      if (
        key === uniqueLabel
        || key === absolute
        || key === normalizeLocalPath(filePath)
        || key === filePath
      ) {
        continue;
      }
      const existing = pathByKey.get(key);
      if (!existing || existing === absolute) {
        pathByKey.set(key, absolute);
      }
    }
  }
}

function toImagePathLookup(
  pathByKey: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  return pathByKey instanceof Map ? pathByKey : new Map(Object.entries(pathByKey));
}

function resolveImageChipLabel(
  label: string,
  lookup: ReadonlyMap<string, string>,
): string | undefined {
  const key = label.trim();
  const bare = key.startsWith('...') ? key.slice(3) : key;
  const candidates = [key, bare, path.basename(bare)];
  for (const candidate of candidates) {
    const hit = lookup.get(candidate);
    if (hit) return hit;
  }
  for (const [mapKey, fullPath] of lookup.entries()) {
    if (mapKey === key || mapKey === bare) return fullPath;
  }
  for (const [, fullPath] of lookup.entries()) {
    const base = path.basename(fullPath);
    if (base === key || base === bare) return fullPath;
  }
  return undefined;
}

/** Forms a pasted path can take in the composer, so a loaded file is removed from the outgoing text. */
function pastedPathVariants(filePath: string): readonly string[] {
  return [
    filePath,
    filePath.replaceAll(' ', '\\ '),
    `'${filePath}'`,
    `"${filePath}"`,
  ];
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
  const lookup = options?.pathByKey ? toImagePathLookup(options.pathByKey) : null;
  // Resolve chips to absolute paths directly. Re-parsing the expanded path would
  // split `Application Support` on the space and then fail to read the file.
  const resolvedChipPaths: string[] = [];
  const textWithoutResolvedChips = lookup
    ? text.replace(IMAGE_CHIP_RE, (full, label: string) => {
      const hit = resolveImageChipLabel(String(label), lookup);
      if (!hit) return full;
      resolvedChipPaths.push(path.resolve(normalizeLocalPath(hit)));
      return ' ';
    })
    : text;
  const tokens = [...new Set([
    ...resolvedChipPaths,
    ...extractImagePathTokens(textWithoutResolvedChips),
  ])];
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

  // Collect every alias for successfully loaded images so local path strings
  // never remain in the outbound body (unique chips, abs paths, legacy basenames).
  const stripTargets = new Set<string>(usedPaths);
  for (const used of usedPaths) {
    if (used.startsWith('data:image/')) continue;
    const abs = path.resolve(normalizeLocalPath(used));
    stripTargets.add(used);
    stripTargets.add(abs);
    for (const variant of pastedPathVariants(abs)) stripTargets.add(variant);
    stripTargets.add(formatImagePathChip(abs));
    stripTargets.add(imagePathChipLabel(abs));
    stripTargets.add(`[Image ${imagePathChipLabel(abs)}]`);
    const base = path.basename(abs);
    if (base) {
      stripTargets.add(base);
      stripTargets.add(`[Image ${base}]`);
      if (base.length > 18) {
        const keep = Math.max(6, 15);
        stripTargets.add(`[Image ...${base.slice(-keep)}]`);
      }
    }
  }
  for (const token of tokens) {
    if (token.startsWith('data:image/')) continue;
    const abs = path.resolve(normalizeLocalPath(token));
    if (usedPaths.includes(abs) || usedPaths.includes(token)) {
      stripTargets.add(token);
      stripTargets.add(abs);
    }
  }

  let remainingText = stripImagePathsFromText(text, [...stripTargets]);
  // Drop any leftover image chips that pointed at loaded images.
  remainingText = remainingText
    .replace(IMAGE_CHIP_RE, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const displayContent = remainingText
    || (images.length > 0
      ? formatHistoryImageLabel(images)
      : text.trim());

  return {
    text: remainingText,
    images,
    displayContent,
    missingPaths,
  };
}

export function expandImageChipsInText(
  text: string,
  pathByKey: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): string {
  const lookup = toImagePathLookup(pathByKey);
  return text.replace(IMAGE_CHIP_RE, (full, label: string) => (
    resolveImageChipLabel(String(label), lookup) ?? full
  ));
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
