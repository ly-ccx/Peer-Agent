import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { clientApi } from '../../../clientApi';
import { useWorkbenchOptional } from '../../../workbench/WorkbenchContext';

/**
 * 透传当前会话的 workspacePath，作为聊天消息内"相对文件路径"的解析基准。
 * 为 null 时，相对路径降级为不可点击的普通 inline code；绝对路径仍可点。
 */
export const WorkspacePathContext = createContext<string | null>(null);

function findSingleStar(text: string, start: number) {
  let index = text.indexOf('*', start);
  while (index >= 0) {
    if (text[index - 1] !== '*' && text[index + 1] !== '*') return index;
    index = text.indexOf('*', index + 1);
  }
  return -1;
}

function tokenTone(openingTag: string) {
  const token = openingTag.match(/colorTokenV2\s*=\s*["']?([A-Za-z0-9_-]+)["']?/i)?.[1] ?? '';
  if (token.includes('red')) return 'red';
  if (token.includes('orange') || token.includes('yellow') || token.includes('warning')) return 'warning';
  if (token.includes('green') || token.includes('success')) return 'success';
  if (token.includes('blue') || token.includes('link')) return 'info';
  return 'default';
}

function findFontToken(text: string, start: number) {
  const match = text.slice(start).match(/<font\b[^>]*>/i);
  if (!match || match.index === undefined) return null;
  return {
    start: start + match.index,
    openingTag: match[0],
    tone: tokenTone(match[0]),
  };
}

/**
 * 解析 inline code 文本是否像一个文件路径（含可选 :行号 / :行:列 后缀）。
 * 仅在确有路径特征时返回，普通 inline code（如 useState、--flag）返回 null。
 */
export function parseFilePathToken(
  raw: string,
): { path: string; line?: number; isAbsolute: boolean } | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  // 排除 URL（http://、file://、scheme://）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;

  // 剥离尾部 :行号 或 :行:列
  const lineMatch = text.match(/^(.+?):(\d+)(?::\d+)?$/);
  const pathPart = lineMatch ? lineMatch[1] : text;
  const line = lineMatch ? Number(lineMatch[2]) : undefined;

  const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(pathPart);
  const isPosixAbs = pathPart.startsWith('/');
  const isHomeAbs = pathPart.startsWith('~/');
  const isAbsolute = isWindowsAbs || isPosixAbs || isHomeAbs;
  const hasExplicitRelPrefix = pathPart.startsWith('./') || pathPart.startsWith('../');
  // 裸相对路径（无 ./ 或 ../ 前缀）只要含 `/` 即视为「候选」，这里只做字符/格式初筛。
  // 是否真的是文件，交由 FilePathCode 的磁盘存在性校验权威判定：git 分支名/仓库名/
  // 版本号（dev/0.0.1、origin/main、org/repo）因磁盘上不存在，不会被升级为可点链接，
  // 无需在此用正则去猜「它像不像文件 / 是不是 git」。
  const looksLikeBareRelPath = pathPart.includes('/');
  const isRelative =
    !isAbsolute && (hasExplicitRelPrefix || looksLikeBareRelPath);

  if (!isAbsolute && !isRelative) return null;

  // 允许的路径字符集（不含空格），避免把任意带斜杠文本当路径
  if (!/^[A-Za-z0-9._~@%+\-/\\:]+$/.test(pathPart)) return null;
  // 至少要有一个路径分隔符
  if (!pathPart.includes('/') && !pathPart.includes('\\')) return null;

  return { path: pathPart, line, isAbsolute };
}

/** 将路径解析为可传给主进程的绝对路径；无法解析（相对路径但无 workspacePath）时返回 null。 */
function resolveAbsolutePath(
  parsed: { path: string; isAbsolute: boolean },
  workspacePath: string | null,
): string | null {
  const { path, isAbsolute } = parsed;
  if (isAbsolute) {
    // ~/ 无法在渲染层安全展开 → 不放行，避免传错路径
    if (path.startsWith('~/')) return null;
    return path;
  }
  if (!workspacePath) return null;
  let rel = path;
  if (rel.startsWith('./')) rel = rel.slice(2);
  const root = workspacePath.replace(/[/\\]+$/, '');
  return `${root}/${rel}`;
}

function FilePathCode({ raw }: { raw: string }) {
  const workspacePath = useContext(WorkspacePathContext);
  const workbench = useWorkbenchOptional();
  const parsed = parseFilePathToken(raw);
  const absPath = parsed ? resolveAbsolutePath(parsed, workspacePath) : null;
  // 透传原始相对路径：当 absPath 在当前 workspace 解析不到时，
  // 主进程可用它跨已知 workspace 回退查找（跨仓库引用场景）。
  const relPath = parsed && !parsed.isAbsolute ? parsed.path : undefined;
  // 路径以 / 或 \ 结尾视为「目录」chip（如 archive/deprecated-architecture/）：
  // 点击时打开右侧「文件」视图并定位到该目录，而非走文件的 Diff 视图。
  const isDir = !!parsed && /[/\\]$/.test(parsed.path);

  // 存在性校验：候选路径只有在磁盘上真实存在时才升级为可点链接。
  // git 分支名/仓库名/版本号（dev/0.0.1、origin/main、org/repo）因磁盘上没有对应文件
  // 而保持普通文本——以「是不是真文件」为权威判据，而非去识别「它是不是 git」。
  const [exists, setExists] = useState(false);
  useEffect(() => {
    if (!absPath) {
      setExists(false);
      return;
    }
    let cancelled = false;
    setExists(false);
    Promise.resolve()
      .then(() => clientApi.fileExists(absPath, workspacePath ?? undefined, relPath))
      .then((result) => {
        if (!cancelled) setExists(Boolean(result?.exists));
      })
      .catch(() => {
        if (!cancelled) setExists(false);
      });
    return () => {
      cancelled = true;
    };
  }, [absPath, workspacePath, relPath]);

  if (!parsed || !absPath || !exists) {
    // 不是路径 / 无 workspacePath 解析基准 / 磁盘上不存在 → 保持普通 inline code 行为
    return <code>{raw}</code>;
  }

  const handleOpen = () => {
    if (workbench) {
      if (isDir) {
        // 目录：打开右侧 Workbench 的「文件」视图并定位/展开到该目录。
        workbench.revealInFiles(absPath, workspacePath ?? undefined, relPath);
      } else {
        // 文件：打开右侧 Workbench 的 Diff 视图展示该文件的 git diff。
        workbench.openDiff(absPath, workspacePath ?? undefined, relPath);
      }
      return;
    }
    // 回退：无 Workbench 上下文时，用系统默认程序打开文件/目录。
    void clientApi.openPath(absPath, workspacePath ?? undefined);
  };

  const title = workbench
    ? (isDir ? `在文件视图中打开 ${absPath}` : `查看 ${absPath} 的改动`)
    : `打开 ${absPath}`;

  return (
    <code
      className="markdown-file-path"
      role="link"
      tabIndex={0}
      title={title}
      onClick={handleOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleOpen();
        }
      }}
    >
      {raw}
    </code>
  );
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;

  while (cursor < text.length) {
    const fontToken = findFontToken(text, cursor);
    const candidates = [
      { type: 'code' as const, start: text.indexOf('`', cursor), marker: '`' },
      { type: 'strong' as const, start: text.indexOf('**', cursor), marker: '**' },
      { type: 'em' as const, start: findSingleStar(text, cursor), marker: '*' },
      ...(fontToken ? [{ type: 'font' as const, ...fontToken }] : []),
    ].filter((candidate) => candidate.start >= 0);
    candidates.sort((a, b) => a.start - b.start);
    const next = candidates[0];
    if (!next) {
      nodes.push(text.slice(cursor));
      break;
    }

    if (next.start > cursor) nodes.push(text.slice(cursor, next.start));
    if (next.type === 'font') {
      const contentStart = next.start + next.openingTag.length;
      const contentEnd = text.toLowerCase().indexOf('</font>', contentStart);
      if (contentEnd < 0) {
        nodes.push(text.slice(contentStart));
        break;
      }
      const key = `${keyPrefix}-inline-${tokenIndex}`;
      nodes.push(
        <span key={key} className={`markdown-token markdown-token-${next.tone}`}>
          {renderInlineMarkdown(text.slice(contentStart, contentEnd), key)}
        </span>,
      );
      tokenIndex += 1;
      cursor = contentEnd + '</font>'.length;
      continue;
    }

    const contentStart = next.start + next.marker.length;
    const contentEnd = text.indexOf(next.marker, contentStart);
    if (contentEnd < 0) {
      nodes.push(text.slice(next.start));
      break;
    }

    const content = text.slice(contentStart, contentEnd);
    const key = `${keyPrefix}-inline-${tokenIndex}`;
    if (next.type === 'code') {
      nodes.push(<FilePathCode key={key} raw={content} />);
    } else if (next.type === 'strong') {
      nodes.push(<strong key={key}>{renderInlineMarkdown(content, key)}</strong>);
    } else {
      nodes.push(<em key={key}>{renderInlineMarkdown(content, key)}</em>);
    }
    tokenIndex += 1;
    cursor = contentEnd + next.marker.length;
  }

  return nodes;
}

export function renderInlineLines(text: string, keyPrefix: string) {
  return text.split('\n').flatMap((line, index) => {
    const nodes = renderInlineMarkdown(line, `${keyPrefix}-${index}`);
    return index === 0 ? nodes : [<br key={`${keyPrefix}-br-${index}`} />, ...nodes];
  });
}
