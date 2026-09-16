import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { clientApi } from '../../../clientApi';
import { Overlay } from '../../../app/components/Overlay';
import { useWorkbenchOptional } from '../../../workbench/WorkbenchContext';
import {
  isLocalImagePath,
  loadLocalImageDataUrl,
} from '../../state/localImagePreview';
import { findMarkdownImage, findMarkdownLink, safeExternalHref } from './inlineMarkdownLinks';

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

function FilePathCode({ raw, alt, children }: { raw: string; alt?: string; children?: ReactNode }) {
  const workspacePath = useContext(WorkspacePathContext);
  const workbench = useWorkbenchOptional();
  const parsed = parseFilePathToken(raw);
  const absPath = parsed ? resolveAbsolutePath(parsed, workspacePath) : null;
  // 透传原始相对路径：当 absPath 在当前 workspace 解析不到时，
  // 主进程可用它跨已知 workspace 回退查找（跨仓库引用场景）。
  const relPath = parsed && !parsed.isAbsolute ? parsed.path : undefined;
  // 路径以「看起来像路径」为前提；最终是否可点取决于 fileExists 结果。
  // 绝对路径即使当前 workspace 未绑定也允许探测（主进程会直接 stat）。
  const canProbe = Boolean(absPath && (parsed?.isAbsolute || workspacePath));
  const [exists, setExists] = useState<boolean | null>(canProbe ? null : false);
  const [isDir, setIsDir] = useState(false);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const looksLikeImage = Boolean(parsed && isLocalImagePath(parsed.path));

  useEffect(() => {
    if (!canProbe || !absPath) return;
    let cancelled = false;
    clientApi
      .fileExists(absPath, workspacePath ?? undefined, relPath)
      .then((result) => {
        if (cancelled) return;
        setExists(Boolean(result?.exists));
        setIsDir(Boolean(result?.isDir));
      })
      .catch(() => {
        if (!cancelled) setExists(false);
      });
    return () => {
      cancelled = true;
    };
  }, [absPath, canProbe, relPath, workspacePath]);

  // 本地图片路径：存在后按需加载缩略图（ADR 59：不写回会话存储）。
  useEffect(() => {
    if (!looksLikeImage || !absPath || exists !== true || isDir) {
      setPreviewDataUrl(null);
      return;
    }
    let cancelled = false;
    loadLocalImageDataUrl(absPath, workspacePath, relPath).then((dataUrl) => {
      if (!cancelled) setPreviewDataUrl(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [absPath, exists, isDir, looksLikeImage, relPath, workspacePath]);

  const content = children ?? raw;

  if (!parsed || !absPath) {
    return <code>{content}</code>;
  }

  // 探测中：先以普通 code 呈现，避免闪烁可点样式
  if (exists === null) {
    return <code>{content}</code>;
  }

  // 磁盘上不存在 → 保持普通 inline code 行为
  if (!exists) {
    return <code>{content}</code>;
  }

  const handleOpen = () => {
    if (workbench) {
      if (isDir) {
        // 目录：打开右侧 Workbench 的「文件」视图并定位/展开到该目录。
        workbench.revealInFiles(absPath, workspacePath ?? undefined, relPath);
      } else {
        // 文件：打开 Diff 视图。
        workbench.openDiff(absPath, workspacePath ?? undefined, relPath);
      }
    } else {
      void clientApi.openPath(absPath);
    }
  };

  const title = isDir
    ? `在文件树中定位：${absPath}`
    : looksLikeImage && previewDataUrl
      ? `预览图片：${absPath}`
      : `在 Diff 中打开：${absPath}`;

  if (looksLikeImage && previewDataUrl) {
    return (
      <span className="markdown-local-image">
        <button
          type="button"
          className="markdown-local-image-thumb"
          title={title}
          onClick={() => setPreviewOpen(true)}
        >
          <img src={previewDataUrl} alt={alt || raw} loading="lazy" />
        </button>
        <code
          className="markdown-file-path"
          role="link"
          tabIndex={0}
          title={isDir ? title : `在 Diff 中打开：${absPath}`}
          onClick={handleOpen}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleOpen();
            }
          }}
        >
          {content}
        </code>
        {previewOpen ? (
          <LocalImageLightbox
            dataUrl={previewDataUrl}
            path={absPath}
            onClose={() => setPreviewOpen(false)}
          />
        ) : null}
      </span>
    );
  }

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
      {content}
    </code>
  );
}

/**
 * 暗房式图片查看器：图片带 alpha 感知投影浮在磨砂遮罩上，
 * 底部胶囊工具条提供尺寸、缩放切换、在文件管理器中显示、复制路径与关闭。
 */
function LocalImageLightbox({
  dataUrl,
  path,
  onClose,
}: {
  dataUrl: string;
  path: string;
  onClose: () => void;
}) {
  const isZh = navigator.language.toLowerCase().startsWith('zh');
  const [zoomed, setZoomed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const fileName = path.split(/[\\/]/).pop() ?? path;

  const zoomLabel = zoomed
    ? (isZh ? '适应窗口' : 'Fit to window')
    : (isZh ? '查看原始尺寸' : 'View actual size');

  const handleCopyPath = () => {
    void navigator.clipboard.writeText(path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Overlay
      ariaLabel={fileName}
      backdropClassName="markdown-local-image-lightbox"
      panelClassName={`markdown-local-image-lightbox-panel${zoomed ? ' is-zoomed' : ''}`}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <>
          <div className="markdown-local-image-lightbox-stage">
            <img
              src={dataUrl}
              alt={fileName}
              draggable={false}
              title={zoomLabel}
              onClick={() => setZoomed((value) => !value)}
              onLoad={(event) => {
                const img = event.currentTarget;
                setDims({ w: img.naturalWidth, h: img.naturalHeight });
              }}
            />
          </div>
          <div className="markdown-local-image-lightbox-bar">
            <div className="markdown-local-image-lightbox-info">
              <span className="markdown-local-image-lightbox-name">{fileName}</span>
              <span className="markdown-local-image-lightbox-path" title={path}>
                <bdi>{path}</bdi>
              </span>
            </div>
            <div className="markdown-local-image-lightbox-actions">
              {dims ? (
                <span className="markdown-local-image-lightbox-dims">{dims.w} × {dims.h}</span>
              ) : null}
              <button
                type="button"
                title={zoomLabel}
                aria-label={zoomLabel}
                onClick={() => setZoomed((value) => !value)}
              >
                {zoomed ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                title={isZh ? '在文件管理器中显示' : 'Reveal in file manager'}
                aria-label={isZh ? '在文件管理器中显示' : 'Reveal in file manager'}
                onClick={() => void clientApi.openPath(path, undefined, { mode: 'reveal' })}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </button>
              <button
                type="button"
                title={copied ? (isZh ? '已复制' : 'Copied') : (isZh ? '复制路径' : 'Copy path')}
                aria-label={copied ? (isZh ? '已复制' : 'Copied') : (isZh ? '复制路径' : 'Copy path')}
                onClick={handleCopyPath}
              >
                {copied ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
              <span className="markdown-local-image-lightbox-divider" aria-hidden="true" />
              <button
                type="button"
                title={isZh ? '关闭预览' : 'Close preview'}
                aria-label={isZh ? '关闭预览' : 'Close preview'}
                onClick={requestClose}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}
    </Overlay>
  );
}

/**
 * 将纯文本切片中的「绝对本地图片路径」提升为可预览节点；非图片路径保持原样。
 * 仅匹配绝对路径（/… 或 C:\…），避免误伤普通单词。
 */
function pushTextWithBareImagePaths(nodes: ReactNode[], text: string, keyPrefix: string, tokenIndex: number): number {
  // POSIX abs + Windows abs image paths
  const re = /(?:^|[\s(])((?:\/[\w.@+\-]+(?:\/[\w.@+\-]+)*\.(?:png|jpe?g|gif|webp|bmp|svg))|(?:[A-Za-z]:[\\/][\w.@+\-\\/]+\.(?:png|jpe?g|gif|webp|bmp|svg)))(?=$|[\s),.;:!?\]])/gi;
  let last = 0;
  let localIndex = tokenIndex;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const full = match[0];
    const pathToken = match[1];
    const pathStartInFull = full.indexOf(pathToken);
    const absoluteStart = match.index + pathStartInFull;
    if (absoluteStart > last) {
      nodes.push(text.slice(last, absoluteStart));
    }
    nodes.push(<FilePathCode key={`${keyPrefix}-imgpath-${localIndex}`} raw={pathToken} />);
    localIndex += 1;
    last = absoluteStart + pathToken.length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  } else if (last === 0 && text.length === 0) {
    // nothing
  }
  return localIndex;
}

function renderInlineMarkdown(text: string, keyPrefix: string, offsets?: readonly number[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  const mappedText = (start: number, end: number) => {
    const children: ReactNode[] = [];
    pushTextWithBareImagePaths(children, text.slice(start, end), `${keyPrefix}-${start}`, 0);
    return offsets
      ? <span key={`${keyPrefix}-source-${start}`} data-source-offsets={JSON.stringify(offsets.slice(start, end + 1))}>{children}</span>
      : children;
  };
  let cursor = 0;
  let tokenIndex = 0;

  while (cursor < text.length) {
    const fontToken = findFontToken(text, cursor);
    const imageToken = findMarkdownImage(text, cursor);
    const linkToken = findMarkdownLink(text, cursor);
    const candidates = [
      ...(imageToken ? [{ type: 'image' as const, ...imageToken }] : []),
      ...(linkToken ? [{ type: 'link' as const, ...linkToken }] : []),
      { type: 'code' as const, start: text.indexOf('`', cursor), marker: '`' },
      { type: 'strong' as const, start: text.indexOf('**', cursor), marker: '**' },
      { type: 'em' as const, start: findSingleStar(text, cursor), marker: '*' },
      ...(fontToken ? [{ type: 'font' as const, ...fontToken }] : []),
    ].filter((candidate) => candidate.start >= 0);
    candidates.sort((a, b) => a.start - b.start);
    const next = candidates[0];
    if (!next) {
      nodes.push(mappedText(cursor, text.length));
      break;
    }

    if (next.start > cursor) {
      nodes.push(mappedText(cursor, next.start));
    }
    if (next.type === 'image') {
      const key = `${keyPrefix}-inline-${tokenIndex}`;
      const alt = next.alt.trim() || next.destination;
      const externalHref = safeExternalHref(next.destination);
      if (externalHref) {
        nodes.push(
          <span key={key} className="markdown-local-image">
            <img src={externalHref} alt={alt} />
          </span>,
        );
      } else if (parseFilePathToken(next.destination) || isLocalImagePath(next.destination)) {
        nodes.push(
          <FilePathCode key={key} raw={next.destination} alt={alt}>
            {alt}
          </FilePathCode>,
        );
      } else {
        nodes.push(<span key={key}>{alt}</span>);
      }
      tokenIndex += 1;
      cursor = next.end;
      continue;
    }
    if (next.type === 'link') {
      const key = `${keyPrefix}-inline-${tokenIndex}`;
      const label = renderInlineMarkdown(next.label, `${key}-label`);
      const externalHref = safeExternalHref(next.destination);
      if (externalHref) {
        nodes.push(
          <a key={key} href={externalHref} target="_blank" rel="noreferrer noopener">
            {label}
          </a>,
        );
      } else if (parseFilePathToken(next.destination)) {
        nodes.push(<FilePathCode key={key} raw={next.destination}>{label}</FilePathCode>);
      } else {
        nodes.push(<span key={key}>{label}</span>);
      }
      tokenIndex += 1;
      cursor = next.end;
      continue;
    }
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
      nodes.push(<strong key={key}>{renderInlineMarkdown(content, key, offsets?.slice(contentStart, contentEnd + 1))}</strong>);
    } else {
      nodes.push(<em key={key}>{renderInlineMarkdown(content, key, offsets?.slice(contentStart, contentEnd + 1))}</em>);
    }
    tokenIndex += 1;
    cursor = contentEnd + next.marker.length;
  }

  return nodes;
}

export function renderInlineLines(text: string, keyPrefix: string, offsets?: readonly number[]) {
  let start = 0;
  return text.split('\n').flatMap((line, index) => {
    const nodes = renderInlineMarkdown(line, `${keyPrefix}-${index}`, offsets?.slice(start, start + line.length + 1));
    start += line.length + 1;
    return index === 0 ? nodes : [<br key={`${keyPrefix}-br-${index}`} />, ...nodes];
  });
}
