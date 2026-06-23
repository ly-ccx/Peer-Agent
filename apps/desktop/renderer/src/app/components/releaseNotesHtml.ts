/**
 * releaseNotesHtml —— 发布说明富文本解析（纯函数，零依赖，可在 node --test 下运行）。
 *
 * 背景：electron-updater 下发的 releaseNotes 是 GitHub 渲染后的 HTML 片段
 * （如 `<p>...</p><ul><li>...</li></ul>`）。表达层需要把它安全地渲染成富文本，
 * 但渲染进程测试用 `node --test`（无 jsdom / DOMParser），且禁止 dangerouslySetInnerHTML。
 *
 * 因此这里把 HTML 解析为一棵白名单节点树，再由 UpdateModal 用 React 元素渲染：
 *   - 只保留白名单标签，其余标签「脱壳」（丢标签、保留其子内容）。
 *   - 链接只允许 http/https/mailto 协议，其余降级为纯文本。
 *   - 解码常见 HTML 实体。
 *
 * 解析失败或输入异常时，调用方应回退为纯文本展示。
 */

export type ReleaseNotesNode =
  | { kind: 'text'; text: string }
  | { kind: 'element'; tag: ReleaseNotesTag; href?: string; children: ReleaseNotesNode[] };

export type ReleaseNotesTag =
  | 'p'
  | 'br'
  | 'ul'
  | 'ol'
  | 'li'
  | 'strong'
  | 'em'
  | 'code'
  | 'pre'
  | 'blockquote'
  | 'a'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'hr';

// 标签白名单：键为输入标签（小写），值为归一化后的标签。
const TAG_WHITELIST: Record<string, ReleaseNotesTag> = {
  p: 'p',
  br: 'br',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  code: 'code',
  pre: 'pre',
  blockquote: 'blockquote',
  a: 'a',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  hr: 'hr',
};

// 空元素（无子节点）。
const VOID_TAGS = new Set(['br', 'hr']);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    const mapped = ENTITIES[body] ?? ENTITIES[body.toLowerCase()];
    return mapped ?? whole;
  });
}

function safeHref(rawAttrs: string): string | undefined {
  const match = rawAttrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (!match) return undefined;
  const value = decodeEntities((match[2] ?? match[3] ?? match[4] ?? '').trim());
  if (/^(https?:|mailto:)/i.test(value)) return value;
  return undefined;
}

/**
 * 把 HTML 片段解析为白名单节点树。纯文本（无标签）也能正确返回为单个 text 节点。
 */
export function parseReleaseNotesHtml(html: string): ReleaseNotesNode[] {
  const root: ReleaseNotesNode = { kind: 'element', tag: 'p', children: [] };
  const stack: Array<{ tag: ReleaseNotesTag | null; children: ReleaseNotesNode[] }> = [
    { tag: null, children: root.children },
  ];

  const pushChild = (node: ReleaseNotesNode) => {
    stack[stack.length - 1].children.push(node);
  };
  const pushText = (raw: string) => {
    if (!raw) return;
    const text = decodeEntities(raw);
    if (text) pushChild({ kind: 'text', text });
  };

  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(html)) !== null) {
    pushText(html.slice(lastIndex, m.index));
    lastIndex = tagRe.lastIndex;

    const isClosing = m[1] === '/';
    const rawName = m[2].toLowerCase();
    const rawAttrs = m[3] ?? '';
    const selfClosed = m[4] === '/';
    const mapped = TAG_WHITELIST[rawName];

    if (!mapped) {
      // 非白名单标签：脱壳（忽略标签本身，保留其子内容）。
      continue;
    }

    if (VOID_TAGS.has(mapped)) {
      pushChild({ kind: 'element', tag: mapped, children: [] });
      continue;
    }

    if (!isClosing) {
      const node: ReleaseNotesNode = {
        kind: 'element',
        tag: mapped,
        children: [],
        ...(mapped === 'a' ? { href: safeHref(rawAttrs) } : {}),
      };
      pushChild(node);
      if (!selfClosed) {
        stack.push({ tag: mapped, children: node.children });
      }
    } else {
      // 闭合标签：回退到最近的同名开标签。
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i].tag === mapped) {
          stack.length = i;
          break;
        }
      }
    }
  }

  pushText(html.slice(lastIndex));

  return normalize(root.children);
}

// 移除纯空白文本节点造成的噪声，但保留元素之间的有意义文本。
function normalize(nodes: ReleaseNotesNode[]): ReleaseNotesNode[] {
  const out: ReleaseNotesNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      if (node.text.trim() === '') continue;
      out.push(node);
    } else {
      out.push({ ...node, children: normalize(node.children) });
    }
  }
  return out;
}

/**
 * 把节点树降级为纯文本（用于不渲染富文本时的回退，或可访问性）。
 */
export function nodesToPlainText(nodes: ReleaseNotesNode[]): string {
  const parts: string[] = [];
  const walk = (list: ReleaseNotesNode[]) => {
    for (const node of list) {
      if (node.kind === 'text') {
        parts.push(node.text);
      } else if (node.tag === 'br') {
        parts.push('\n');
      } else {
        walk(node.children);
        if (['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(node.tag)) {
          parts.push('\n');
        }
      }
    }
  };
  walk(nodes);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}
