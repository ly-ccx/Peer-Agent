/**
 * 代码块语法高亮（renderer 侧纯展示能力）。
 *
 * 设计约束：
 * - 只引入 highlight.js core + 按需注册语言子集，避免全量语言包进入 bundle。
 * - 同步文本/常用语言高亮；低频语言按需载入后只刷新代码着色，源码始终可读。
 * - 结果按 (language, code) 做 LRU 缓存：流式期间同一代码块会被反复重渲，
 *   缓存把重复的 highlight 计算降为一次。
 * - 超长代码块跳过高亮，直接回退纯文本，避免长文本在流式渲染中卡顿。
 * - 配色不在这里决定：输出标准 hljs-* class，由 CSS 变量驱动深浅色主题。
 */
import hljs from 'highlight.js/lib/core';

import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** 注册表：language id -> highlight.js language 定义。 */
const LANGUAGE_MODULES = {
  bash,
  css,
  diff,
  javascript,
  json,
  plaintext,
  python,
  sql,
  typescript,
  xml,
  yaml,
} as const;

let registered = false;

function ensureRegistered(): void {
  if (registered) return;
  for (const [id, definition] of Object.entries(LANGUAGE_MODULES)) {
    hljs.registerLanguage(id, definition);
  }
  // 常见别名：Markdown 围栏里用户写什么都有，别名让命中率更高。
  hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs', 'node'], { languageName: 'javascript' });
  hljs.registerAliases(['ts', 'tsx', 'mts', 'cts'], { languageName: 'typescript' });
  hljs.registerAliases(['sh', 'zsh', 'shellsession', 'console'], { languageName: 'bash' });
  hljs.registerAliases(['yml'], { languageName: 'yaml' });
  hljs.registerAliases(['py'], { languageName: 'python' });






  hljs.registerAliases(['html', 'xhtml', 'svg', 'vue'], { languageName: 'xml' });
  hljs.registerAliases(['patch', 'udiff'], { languageName: 'diff' });

  hljs.registerAliases(['md'], { languageName: 'markdown' });
  hljs.registerAliases(['text', 'txt', 'log'], { languageName: 'plaintext' });
  hljs.configure({ classPrefix: 'hljs-', ignoreUnescapedHTML: true });
  registered = true;
}


const deferredLanguages = {
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  go: () => import('highlight.js/lib/languages/go'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  less: () => import('highlight.js/lib/languages/less'),
  lua: () => import('highlight.js/lib/languages/lua'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  perl: () => import('highlight.js/lib/languages/perl'),
  php: () => import('highlight.js/lib/languages/php'),
  r: () => import('highlight.js/lib/languages/r'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scss: () => import('highlight.js/lib/languages/scss'),
  shell: () => import('highlight.js/lib/languages/shell'),
  swift: () => import('highlight.js/lib/languages/swift'),
};
const deferredAliases: Record<string, string> = { rs: 'rust', kt: 'kotlin', rb: 'ruby', cs: 'csharp',
  'c++': 'cpp', cc: 'cpp', hpp: 'cpp', h: 'cpp', objc: 'objectivec', 'obj-c': 'objectivec', toml: 'ini' };
const pendingLanguages = new Map<string, Promise<void>>();
const failedLanguages = new Set<string>();
const languageListeners = new Set<() => void>();
let languageRevision = 0;
export const subscribeHighlightLanguages = (listener: () => void) => {
  languageListeners.add(listener);
  return () => { languageListeners.delete(listener); };
};
export const highlightLanguageRevision = () => languageRevision;

export async function loadHighlightLanguage(rawLanguage: string | undefined): Promise<void> {
  ensureRegistered();
  const requested = normalizeLanguage(rawLanguage);
  if (!requested) return;
  const language = deferredAliases[requested] ?? requested;
  if (hljs.getLanguage(language)) return;
  const loader = deferredLanguages[language as keyof typeof deferredLanguages];
  if (!loader) return;
  const pending = pendingLanguages.get(language);
  if (pending) return pending;
  const loading = loader().then(module => {
    hljs.registerLanguage(language, module.default);
    const aliases = Object.entries(deferredAliases).filter(([, target]) => target === language).map(([alias]) => alias);
    if (aliases.length) hljs.registerAliases(aliases, { languageName: language });
    failedLanguages.delete(language);
    languageRevision++;
    for (const listener of languageListeners) listener();
  }).finally(() => { pendingLanguages.delete(language); });
  pendingLanguages.set(language, loading);
  return loading;
}

/** 超过该字符数的代码块不做高亮，保护流式渲染性能。 */
const MAX_HIGHLIGHT_CHARS = 20_000;
/** LRU 上限：聊天视图同时可见的代码块量级远小于此。 */
const CACHE_LIMIT = 240;

/** 高亮结果：html 为 null 表示调用方应回退为纯文本渲染。 */
export interface HighlightedCode {
  /** highlight.js 生成的、已转义的 HTML 片段；null 表示未高亮。 */
  readonly html: string | null;
  /** 实际命中的语言 id；未识别时为 null。 */
  readonly language: string | null;
}

const FALLBACK: HighlightedCode = { html: null, language: null };

/** Map 迭代顺序即插入顺序，用它实现简易 LRU。 */
const cache = new Map<string, HighlightedCode>();

function readCache(key: string): HighlightedCode | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // 命中后移到队尾，维持 LRU 顺序。
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function writeCache(key: string, value: HighlightedCode): void {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

/** 归一化 Markdown 围栏语言标记：大小写、多余修饰（如 ```ts title=x）都要容错。 */
function normalizeLanguage(raw: string | undefined): string | null {
  if (!raw) return null;
  const token = raw.trim().toLowerCase().split(/[\s:,{]/, 1)[0];
  if (!token) return null;
  return token;
}

/**
 * diff 行级 token（addition / deletion / meta）在 CSS 里是 display:block，
 * 以便底色铺满整行。但 highlight.js 把换行符留在 </span> 之外：
 *
 *   <span class="hljs-addition">+ foo</span>\n
 *
 * block 元素本身已经断行，紧随其后的 \n 在 <pre> 中又是一个真实换行，
 * 于是每个着色行后面都会多出一行空白。这里把行尾换行移入 span 内部，
 * 让"断行"只由 block 布局产生一次。
 *
 * 只处理紧贴 </span> 之后的单个换行，缩进与行内空白不受影响。
 */
const BLOCK_DIFF_TOKEN = /(<span class="hljs-(?:addition|deletion|meta|comment)">[^]*?<\/span>)\n/g;

function absorbTrailingNewlineIntoBlockTokens(html: string): string {
  return html.replace(BLOCK_DIFF_TOKEN, (_match, span: string) =>
    span.replace(/<\/span>$/, '\n</span>'),
  );
}

/**
 * 对代码块做同步语法高亮。
 *
 * 未指定语言、语言未注册、代码过长或高亮抛错时，返回 html=null，
 * 调用方需回退到纯文本渲染，保证内容永不丢失。
 */
export function highlightCode(code: string, rawLanguage: string | undefined): HighlightedCode {
  return highlightWithinBudget(code, rawLanguage, MAX_HIGHLIGHT_CHARS, true);
}

/** Source documents are memoized by SourceViewer, not retained in the chat LRU.
 * Keep a separate finite budget while parsing the whole document so multiline
 * comments, strings and JSX retain their lexical context.
 */
export const MAX_SOURCE_HIGHLIGHT_CHARS = 500_000;
export function highlightSourceCode(code: string, rawLanguage: string | undefined): HighlightedCode {
  return highlightWithinBudget(code, rawLanguage, MAX_SOURCE_HIGHLIGHT_CHARS, false);
}

function highlightWithinBudget(code: string, rawLanguage: string | undefined, maxChars: number, cache: boolean): HighlightedCode {
  const requested = normalizeLanguage(rawLanguage);
  if (!requested) return FALLBACK;
  if (code.length > maxChars) return FALLBACK;

  ensureRegistered();
  // getLanguage 接受别名，但返回定义里的规范名；统一收敛为规范 id，
  // 这样 CSS 的 language-* 选择器（如 language-diff）对 ```patch 一样生效。
  const definition = hljs.getLanguage(requested);
  if (!definition) {
    const canonical = deferredAliases[requested] ?? requested;
    if (!failedLanguages.has(canonical)) void loadHighlightLanguage(requested).catch(() => { failedLanguages.add(canonical); });
    return FALLBACK;
  }
  const language = definition.name?.toLowerCase() ?? requested;

  const cacheKey = `${language}\u0000${code}`;
  const cached = cache ? readCache(cacheKey) : undefined;
  if (cached) return cached;

  try {
    const result = hljs.highlight(code, { language, ignoreIllegals: true });
    const html = language === 'diff'
      ? absorbTrailingNewlineIntoBlockTokens(result.value)
      : result.value;
    const value: HighlightedCode = { html, language };
    if (cache) writeCache(cacheKey, value);
    return value;
  } catch {
    // 高亮失败不能影响消息可读性，直接退回纯文本。
    if (cache) writeCache(cacheKey, FALLBACK);
    return FALLBACK;
  }
}
