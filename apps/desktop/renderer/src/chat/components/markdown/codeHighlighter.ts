/**
 * 代码块语法高亮（renderer 侧纯展示能力）。
 *
 * 设计约束：
 * - 只引入 highlight.js core + 按需注册语言子集，避免全量语言包进入 bundle。
 * - 同步 API：聊天消息是流式打字机渲染，异步高亮会导致 token 抖动。
 * - 结果按 (language, code) 做 LRU 缓存：流式期间同一代码块会被反复重渲，
 *   缓存把重复的 highlight 计算降为一次。
 * - 超长代码块跳过高亮，直接回退纯文本，避免长文本在流式渲染中卡顿。
 * - 配色不在这里决定：输出标准 hljs-* class，由 CSS 变量驱动深浅色主题。
 */
import hljs from 'highlight.js/lib/core';

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import objectivec from 'highlight.js/lib/languages/objectivec';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** 注册表：language id -> highlight.js language 定义。 */
const LANGUAGE_MODULES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  markdown,
  objectivec,
  perl,
  php,
  plaintext,
  python,
  r,
  ruby,
  rust,
  scala,
  scss,
  shell,
  sql,
  swift,
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
  hljs.registerAliases(['rs'], { languageName: 'rust' });
  hljs.registerAliases(['kt'], { languageName: 'kotlin' });
  hljs.registerAliases(['rb'], { languageName: 'ruby' });
  hljs.registerAliases(['cs'], { languageName: 'csharp' });
  hljs.registerAliases(['c++', 'cc', 'hpp', 'h'], { languageName: 'cpp' });
  hljs.registerAliases(['objc', 'obj-c'], { languageName: 'objectivec' });
  hljs.registerAliases(['html', 'xhtml', 'svg', 'vue'], { languageName: 'xml' });
  hljs.registerAliases(['patch', 'udiff'], { languageName: 'diff' });
  hljs.registerAliases(['toml'], { languageName: 'ini' });
  hljs.registerAliases(['md'], { languageName: 'markdown' });
  hljs.registerAliases(['text', 'txt', 'log'], { languageName: 'plaintext' });
  hljs.configure({ classPrefix: 'hljs-', ignoreUnescapedHTML: true });
  registered = true;
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
  const requested = normalizeLanguage(rawLanguage);
  if (!requested) return FALLBACK;
  if (code.length > MAX_HIGHLIGHT_CHARS) return FALLBACK;

  ensureRegistered();
  // getLanguage 接受别名，但返回定义里的规范名；统一收敛为规范 id，
  // 这样 CSS 的 language-* 选择器（如 language-diff）对 ```patch 一样生效。
  const definition = hljs.getLanguage(requested);
  if (!definition) return FALLBACK;
  const language = definition.name?.toLowerCase() ?? requested;

  const cacheKey = `${language}\u0000${code}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  try {
    const result = hljs.highlight(code, { language, ignoreIllegals: true });
    const html = language === 'diff'
      ? absorbTrailingNewlineIntoBlockTokens(result.value)
      : result.value;
    const value: HighlightedCode = { html, language };
    writeCache(cacheKey, value);
    return value;
  } catch {
    // 高亮失败不能影响消息可读性，直接退回纯文本。
    writeCache(cacheKey, FALLBACK);
    return FALLBACK;
  }
}
