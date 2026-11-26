export const QUIET_REPLY_MARKER = 'NO_REPLY' as const;

export interface QuietReplyParse {
  readonly isQuiet: boolean;
  readonly leadingText: string;
  readonly isPureQuiet: boolean;
}

// Match Rust char::is_whitespace and char::is_alphanumeric, including non-ASCII letters.
const alphanumeric = /[\p{Alphabetic}\p{Number}]/u;
const markup = /^[`*_]*/u;
const validSuffix = /^[`*_.!]*$/u;
const trimEnd = (text: string) => text.replace(/\p{White_Space}+$/u, '');

function inlineReference(before: string, decorations: string): boolean {
  return decorations.includes('`') && alphanumeric.test(before.slice(before.lastIndexOf('\n') + 1));
}

function wordParts(text: string, separator: RegExp) {
  let start = text.length;
  while (start > 0 && !separator.test(text[start - 1] ?? '')) start--;
  const word = text.slice(start);
  const before = text.slice(0, start);
  const decorations = markup.exec(word)?.[0] ?? '';
  return { before, decorations, bare: word.slice(decorations.length) };
}

function exactMarker(bare: string): boolean {
  return bare.startsWith(QUIET_REPLY_MARKER) && validSuffix.test(bare.slice(QUIET_REPLY_MARKER.length));
}

export function parseQuietReply(raw: string): QuietReplyParse {
  let remaining = trimEnd(raw);
  let isQuiet = false;
  while (true) {
    const { before, decorations, bare } = wordParts(remaining, /\p{White_Space}/u);
    if (!exactMarker(bare) || inlineReference(before, decorations)) break;
    isQuiet = true;
    remaining = trimEnd(before);
  }
  const isPureQuiet = isQuiet && !alphanumeric.test(remaining);
  return { isQuiet, isPureQuiet, leadingText: isPureQuiet ? '' : isQuiet ? remaining : raw };
}

export function isQuietReply(raw: string): boolean {
  return parseQuietReply(raw).isQuiet;
}

export function withoutGrowingQuietMarker(raw: string): string {
  const { before, decorations, bare } = wordParts(trimEnd(raw), /[ \n\t]/u);
  return bare && (QUIET_REPLY_MARKER.startsWith(bare) || exactMarker(bare)) && !inlineReference(before, decorations)
    ? trimEnd(before)
    : raw;
}
