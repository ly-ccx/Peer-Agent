/**
 * releaseNotesLocale —— 按用户界面语言从双语发布说明中抽取对应段落。
 *
 * 写作约定（Markdown 源 + GitHub 渲染后的 HTML 都要能识别）：
 *   Markdown:  <!-- locale:zh-CN -->  /  <!-- locale:en-US -->
 *   HTML:      注释节点可能被 GitHub 保留为 <!-- locale:zh-CN -->，
 *              或出现在段落文本附近；解析时同时匹配注释与可见标记。
 *
 * 回退顺序：
 *   1. 精确 locale（zh-CN / en-US）
 *   2. 同语族（zh* / en*）
 *   3. 另一语言段（有双语标记但缺当前语言时）
 *   4. 原文全文（无任何 locale 标记时，兼容历史中文-only notes）
 */

export type ReleaseNotesLocale = 'zh-CN' | 'en-US';

const LOCALE_MARK_RE =
  /(?:<!--\s*)?locale\s*:\s*(zh-CN|zh|en-US|en)(?:\s*-->)?/gi;

const MARKER_LINE_RE =
  /(?:^|\n)\s*(?:<!--\s*)?locale\s*:\s*(zh-CN|zh|en-US|en)(?:\s*-->)?\s*(?:\n|$)/gi;

function normalizeLocaleToken(token: string): ReleaseNotesLocale {
  const lower = token.trim().toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  return 'en-US';
}

export function resolveReleaseNotesLocale(input?: string | null): ReleaseNotesLocale {
  if (!input) return 'zh-CN';
  const lower = input.trim().toLowerCase();
  if (lower.startsWith('en')) return 'en-US';
  return 'zh-CN';
}

function stripLocaleMarkers(text: string): string {
  return text
    .replace(/(?:^|\n)\s*<!--\s*locale\s*:\s*(?:zh-CN|zh|en-US|en)\s*-->\s*(?=\n|$)/gi, '\n')
    .replace(/(?:^|\n)\s*locale\s*:\s*(?:zh-CN|zh|en-US|en)\s*(?=\n|$)/gi, '\n')
    .replace(/<!--\s*locale\s*:\s*(?:zh-CN|zh|en-US|en)\s*-->/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 将正文按 locale 标记切成段落 map。无标记时返回空 map。
 */
export function splitReleaseNotesByLocale(
  source: string,
): Partial<Record<ReleaseNotesLocale, string>> {
  const text = String(source ?? '');
  if (!text.trim()) return {};

  const matches = [...text.matchAll(MARKER_LINE_RE)];
  // 也接受文中任意位置的注释标记（GitHub HTML 不一定独占一行）
  const looseMatches = matches.length > 0 ? matches : [...text.matchAll(LOCALE_MARK_RE)];
  if (looseMatches.length === 0) return {};

  const sections: Partial<Record<ReleaseNotesLocale, string>> = {};
  for (let i = 0; i < looseMatches.length; i += 1) {
    const match = looseMatches[i]!;
    const token = match[1] ?? 'zh-CN';
    const locale = normalizeLocaleToken(token);
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < looseMatches.length ? (looseMatches[i + 1]!.index ?? text.length) : text.length;
    const body = stripLocaleMarkers(text.slice(start, end));
    if (!body) continue;
    // 同 locale 多次出现时拼接，避免误丢内容
    sections[locale] = sections[locale] ? `${sections[locale]}\n\n${body}` : body;
  }
  return sections;
}

/**
 * 按用户 locale 选择发布说明正文。
 * 无双语标记时原样返回，兼容历史 release notes。
 */
export function selectReleaseNotesByLocale(
  source: string | null | undefined,
  localeInput?: string | null,
): string {
  const raw = String(source ?? '').trim();
  if (!raw) return '';

  const preferred = resolveReleaseNotesLocale(localeInput);
  const sections = splitReleaseNotesByLocale(raw);
  const keys = Object.keys(sections) as ReleaseNotesLocale[];
  if (keys.length === 0) {
    return stripLocaleMarkers(raw);
  }

  if (sections[preferred]) return sections[preferred]!;

  const fallback: ReleaseNotesLocale = preferred === 'zh-CN' ? 'en-US' : 'zh-CN';
  if (sections[fallback]) return sections[fallback]!;

  // 理论上不会走到：有 map 但两语皆空
  return stripLocaleMarkers(raw);
}
