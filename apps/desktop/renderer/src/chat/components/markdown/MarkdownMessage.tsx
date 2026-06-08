import { useCallback, useState } from 'react';
import { renderInlineLines } from './InlineMarkdown';
import { parseMarkdownBlocks } from './markdownParser';

function CopyableCodeBlock({ content, language, blockKey }: {
  readonly content: string;
  readonly language?: string;
  readonly blockKey: string;
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
        <code data-language={language}>{content}</code>
      </pre>
    </div>
  );
}

export function MarkdownMessage({ content }: { readonly content: string }) {
  const blocks = parseMarkdownBlocks(content);
  if (blocks.length === 0) return null;

  return (
    <div className="markdown-content">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Heading = `h${Math.min(block.depth + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
          return <Heading key={`heading-${index}`}>{renderInlineLines(block.content, `heading-${index}`)}</Heading>;
        }
        if (block.type === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul';
          return (
            <Tag key={`list-${index}`} start={block.ordered ? block.start : undefined}>
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
              key={`code-${index}`}
              blockKey={`code-${index}`}
              content={block.content}
              language={block.language}
            />
          );
        }
        if (block.type === 'quote') {
          return <blockquote key={`quote-${index}`}>{renderInlineLines(block.content, `quote-${index}`)}</blockquote>;
        }
        if (block.type === 'table') {
          return (
            <div key={`table-${index}`} className="markdown-table-scroll">
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
        if (block.type === 'rule') {
          return <hr key={`rule-${index}`} />;
        }
        return <p key={`paragraph-${index}`}>{renderInlineLines(block.content, `paragraph-${index}`)}</p>;
      })}
    </div>
  );
}
