/**
 * releaseNotesLocale —— 按用户界面语言从双语发布说明中抽取对应段落。
 *
 * 写作约定（Markdown 源 + GitHub 渲染后的 HTML 都要能识别）：
 *   推荐可见标记（GitHub 渲染后仍保留在正文）：
 *     locale:zh-CN
 *     locale:en-US
 *   兼容 HTML 注释（仅 raw Markdown / 部分链路保留）：
 *     <!-- locale:zh-CN -->  /  <!-- locale:en-US -->
 *
 * 回退顺序：
 *   1. 精确 locale（zh-CN / en-US）
 *   2. 同语族（zh* / en*）
 *   3. 另一语言段（有双语标记但缺当前语言时）
 *   4. 无标记时的双语启发式切分（GitHub HTML 剥掉注释后）
 *   5. 原文全文（单语历史 notes）
 */

export type ReleaseNotesLocale = 'zh-CN' | 'en-US';

const LOCALE_MARK_RE =
  /(?:<!--\s*)?locale\s*:\s*(zh-CN|zh|en-US|en)(?:\s*-->)?/gi;

const MARKER_LINE_RE =
  /(?:^|\n)\s*(?:<!--\s*)?locale\s*:\s*(zh-CN|zh|en-US|en)(?:\s*-->)?\s*(?:<\/p>)?\s*(?:\n|$)/gi;

/**
 * 常见英文段起始标题：
 * - Markdown: ## Notes / ## What's New
 * - 裸 HTML: <h2>Notes</h2>
 * - GitHub 渲染: <div class="markdown-heading"><h2 class="heading-element">Notes</h2>...
 *   （h 标签不一定独占行首，前面常有 wrapper div）
 */
const EN_SECTION_START_RE =
  /(?:^|\n)\s*(?:#{1,3}\s*(?:Notes|What's New|Whats New)\b|(?:<[^>\n]+>\s*)*<h[1-3][^>]*>\s*(?:Notes|What's New|Whats New)\b)/gi;

function normalizeLocaleToken(token: string): ReleaseNotesLocale {
  const lower = token.trim().toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  return 'en-US';
}

function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function countCjk(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
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
    .replace(/<p>\s*locale\s*:\s*(?:zh-CN|zh|en-US|en)\s*<\/p>/gi, '')
    .replace(/(?:^|\n)\s*#{1,6}\s*locale\s*:\s*(?:zh-CN|zh|en-US|en)\s*(?=\n|$)/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 无 locale 标记时，按中文在前、英文段标题起头的约定启发式切开。
 * 典型场景：GitHub 渲染 HTML 丢弃了 <!-- locale:... --> 注释。
 * 无法可靠识别时返回空 map，交给上层按全文回退。
 */
export function inferBilingualSections(
  source: string,
): Partial<Record<ReleaseNotesLocale, string>> {
  const text = String(source ?? '');
  if (!text.trim() || !hasCjk(text)) return {};

  EN_SECTION_START_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EN_SECTION_START_RE.exec(text)) !== null) {
    const raw = match[0] ?? '';
    const headingStart = raw.startsWith('\n') ? (match.index ?? 0) + 1 : (match.index ?? 0);
    const before = text.slice(0, headingStart).trim();
    const after = text.slice(headingStart).trim();
    if (!before || !after) continue;

    const cjkBefore = countCjk(before);
    const cjkAfter = countCjk(after);
    // 前半必须是中文主体；后半不应再以中文为主
    if (cjkBefore < 4) continue;
    if (cjkAfter > Math.max(8, cjkBefore * 0.35)) continue;

    return {
      'zh-CN': before,
      'en-US': after,
    };
  }

  return {};
}

/**
 * 将正文按 locale 标记切成段落 map。
 * 无标记时尝试双语启发式；仍无法识别则返回空 map。
 */
export function splitReleaseNotesByLocale(
  source: string,
): Partial<Record<ReleaseNotesLocale, string>> {
  const text = String(source ?? '');
  if (!text.trim()) return {};

  MARKER_LINE_RE.lastIndex = 0;
  LOCALE_MARK_RE.lastIndex = 0;
  const matches = [...text.matchAll(MARKER_LINE_RE)];
  // 也接受文中任意位置的注释 / 可见标记（GitHub HTML 不一定独占一行）
  const looseMatches = matches.length > 0 ? matches : [...text.matchAll(LOCALE_MARK_RE)];
  if (looseMatches.length === 0) {
    return inferBilingualSections(text);
  }

  const sections: Partial<Record<ReleaseNotesLocale, string>> = {};
  for (let i = 0; i < looseMatches.length; i += 1) {
    const match = looseMatches[i]!;
    const token = match[1] ?? 'zh-CN';
    const locale = normalizeLocaleToken(token);
    const start = (match.index ?? 0) + match[0].length;
    const end =
      i + 1 < looseMatches.length
        ? (looseMatches[i + 1]!.index ?? text.length)
        : text.length;
    const body = stripLocaleMarkers(text.slice(start, end));
    if (!body) continue;
    // 同 locale 多次出现时拼接，避免误丢内容
    sections[locale] = sections[locale] ? `${sections[locale]}\n\n${body}` : body;
  }
  return sections;
}

/**
 * 按用户 locale 选择发布说明正文。
 * 无双语标记且无法启发式切开时原样返回，兼容历史 release notes。
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
