import { memo, useCallback, useMemo, useState } from 'react';
import { useHighlightLanguages } from './useHighlightLanguages';
import { highlightClosedCode } from './codeHighlighter';
import { renderInlineLines } from './InlineMarkdown';
import { parseMarkdownBlocks, markdownBlockSources, type MarkdownBlock } from './markdownParser';
import { stripHistoricalLocalRecordForDisplay } from '../../state/historicalLocalRecord';
import { openFenceBody, type MarkdownOpenSlot } from '../../state/streamingMarkdownSlot.ts';

const HISTORICAL_PREVIEW_MARKER = '[历史长文本已从活跃上下文压缩为预览；原文没有可恢复的本地 artifact ref]';

function HistoricalPreviewBlock({ content }: { readonly content: string }) {
  const lines = content.split('\n');
  const originalChars = lines.find((line) => line.startsWith('originalChars:'))?.replace('originalChars:', '').trim();
  const preview = lines.filter((line) => line && line !== HISTORICAL_PREVIEW_MARKER && !line.startsWith('originalChars:')).join('\n').trim();
  const hasPreview = preview.length > 0;

  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => {
    if (hasPreview) setExpanded((v) => !v);
  }, [hasPreview]);

  const cardClasses = ['historical-preview-card', expanded ? 'expanded' : 'collapsed'].join(' ');

  return (
    <div className={cardClasses}>
      <button
        type="button"
        className="historical-preview-header"
        onClick={toggle}
        disabled={!hasPreview}
        aria-expanded={hasPreview ? expanded : undefined}
      >
        {hasPreview ? (
          <svg
            className="historical-preview-chevron"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        ) : null}
        <span className="historical-preview-label">历史长文本已压缩为预览</span>
        {originalChars ? <span className="historical-preview-meta">{Number(originalChars).toLocaleString()} chars</span> : null}
      </button>
      {hasPreview && expanded ? (
        <div className="historical-preview-body">
          <pre>{preview}</pre>
        </div>
      ) : null}
    </div>
  );
}

function CopyableCodeBlock({ content, language, blockKey, highlightFence = true }: {
  readonly content: string;
  readonly language?: string;
  readonly blockKey: string;
  readonly highlightFence?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [content]);

  return (
    <div className="code-block-wrapper" key={blockKey}>
      <button
        type="button"
        className={`code-copy-btn ${copied ? 'copied' : ''}`}
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy'}
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      <pre>
        <CodeBlockContent content={content} language={language} highlightFence={highlightFence} />
      </pre>
    </div>
  );
}

/**
 * 代码内容渲染：命中语法高亮时输出 hljs token HTML，否则回退纯文本。
 *
 * useMemo + 模块级 LRU 双层缓存。未闭合围栏不调用高亮，避免把生长中的源码写进缓存。
 */
function CodeBlockContent({ content, language, highlightFence = true }: {
  readonly content: string;
  readonly language?: string;
  readonly highlightFence?: boolean;
}) {
  const languageRevision = useHighlightLanguages();
  const highlighted = useMemo(
    () => highlightClosedCode(content, language, highlightFence),
    [content, language, languageRevision, highlightFence],
  );

  // dangerouslySetInnerHTML 的输入来自 highlight.js，已对源码做 HTML 转义，
  // 只包含 <span class="hljs-*"> 结构；未高亮时走纯文本分支，绝不注入原始内容。
  if (highlighted.html !== null) {
    return (
      <code
        className={`hljs${highlighted.language ? ` language-${highlighted.language}` : ''}`}
        data-language={highlighted.language ?? language}
        dangerouslySetInnerHTML={{ __html: highlighted.html }}
      />
    );
  }

  return <code data-language={language}>{content}</code>;
}

const MarkdownBlockView = memo(function MarkdownBlockView({
  block,
  index,
  offsets,
  highlightFence,
}: {
  readonly block: MarkdownBlock;
  readonly index: number;
  readonly offsets?: readonly number[];
  readonly highlightFence: boolean;
}) {
  if (block.type === 'heading') {
    const Heading = `h${Math.min(block.depth + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
    return <Heading>{renderInlineLines(block.content, `heading-${index}`, offsets)}</Heading>;
  }
  if (block.type === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul';
    return (
      <Tag start={block.ordered ? block.start : undefined}>
        {block.items.map((item, itemIndex) => (
          <li key={`list-${index}-${itemIndex}`}>
            {renderInlineLines(item, `list-${index}-${itemIndex}`)}
          </li>
        ))}
      </Tag>
    );
  }
  if (block.type === 'code') {
    return (
      <CopyableCodeBlock
        blockKey={`code-${index}`}
        content={block.content}
        language={block.language}
        highlightFence={highlightFence}
      />
    );
  }
  if (block.type === 'quote') {
    return <blockquote>{renderInlineLines(block.content, `quote-${index}`)}</blockquote>;
  }
  if (block.type === 'table') {
    return (
      <div className="markdown-table-scroll">
        <table>
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th key={`table-${index}-head-${headerIndex}`}>
                  {renderInlineLines(header, `table-${index}-head-${headerIndex}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`table-${index}-row-${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`table-${index}-cell-${rowIndex}-${cellIndex}`}>
                    {renderInlineLines(cell, `table-${index}-cell-${rowIndex}-${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === 'rule') return <hr />;
  if (block.content.startsWith(HISTORICAL_PREVIEW_MARKER)) {
    return <HistoricalPreviewBlock content={block.content} />;
  }
  return <p>{renderInlineLines(block.content, `paragraph-${index}`, offsets)}</p>;
});

/** 已闭合块的引用不变时整列跳过。流式期间只有开放尾部会换引用。 */
const ClosedMarkdownBlocks = memo(function ClosedMarkdownBlocks({
  blocks,
}: {
  readonly blocks: readonly MarkdownBlock[];
}) {
  return blocks.map((block, index) => (
    <MarkdownBlockView key={`closed-${index}`} block={block} index={index} highlightFence />
  ));
});

function OpenMarkdownTail({ slot }: { readonly slot: MarkdownOpenSlot }) {
  const blocks = useMemo(
    () => (slot.openKind === 'prose' && slot.openText ? parseMarkdownBlocks(slot.openText) : []),
    [slot.openKind, slot.openText],
  );
  if (slot.openKind === 'fence') {
    const fence = openFenceBody(slot.openText);
    if (!fence) return null;
    return (
      <div className="code-block-wrapper">
        <pre>
          <code data-language={fence.language}>{fence.code}</code>
        </pre>
      </div>
    );
  }
  if (blocks.length === 0) return null;
  return blocks.map((block, index) => (
    <MarkdownBlockView
      key={`open-${index}`}
      block={block}
      index={index}
      highlightFence={false}
    />
  ));
}

function slotMatchesContent(slot: MarkdownOpenSlot, content: string): boolean {
  return slot.sourceLength === content.length && content.slice(slot.closedSourceLength) === slot.openText;
}

function MarkdownMessageImpl({ content, selectionSource, openSlot }: {
  readonly content: string;
  readonly selectionSource?: { readonly text: string; readonly start: number } | null;
  /** 流式开放块。缺省或与正文不一致时回退整段解析。 */
  readonly openSlot?: MarkdownOpenSlot | null;
}) {
  const source = selectionSource === undefined ? { text: content, start: 0 } : selectionSource;
  const sourceMatches = source !== null && Number.isInteger(source.start) && source.start >= 0
    && source.text.slice(source.start, source.start + content.length) === content;
  const sanitized = stripHistoricalLocalRecordForDisplay(content);
  const streamingSlot = openSlot && sanitized === content && slotMatchesContent(openSlot, content)
    ? openSlot
    : null;
  const blocks = streamingSlot ? null : parseMarkdownBlocks(sanitized);
  if (!streamingSlot && (!blocks || blocks.length === 0)) return null;

  return (
    <div className="markdown-content" data-selection-source={sanitized === content && sourceMatches ? source.text : undefined}>
      {streamingSlot ? (
        <>
          <ClosedMarkdownBlocks blocks={streamingSlot.closed} />
          <OpenMarkdownTail slot={streamingSlot} />
        </>
      ) : blocks?.map((block, index) => {
        const offsets = sanitized === content && sourceMatches
          ? markdownBlockSources.get(block)?.offsets.map((offset) => source.start + offset) : undefined;
        return (
          <MarkdownBlockView
            key={`block-${index}`}
            block={block}
            index={index}
            offsets={offsets}
            highlightFence
          />
        );
      })}
    </div>
  );
}

// memo：避免父组件无关状态变化（如 token usage）连带重渲全部历史消息。
export const MarkdownMessage = memo(MarkdownMessageImpl);
