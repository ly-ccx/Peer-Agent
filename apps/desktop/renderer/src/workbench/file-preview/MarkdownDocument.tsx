import { useState, type ReactNode } from 'react';
import { renderInlineLines } from '../../chat/components/markdown/InlineMarkdown';
import { parseMarkdownBlocks, type MarkdownBlock } from '../../chat/components/markdown/markdownParser';

interface MarkdownDocumentProps {
  readonly content: string;
  readonly emptyLabel: string;
  readonly copyLabel: string;
  readonly copiedLabel: string;
}

interface CodeBlockProps {
  readonly language?: string;
  readonly content: string;
  readonly copyLabel: string;
  readonly copiedLabel: string;
}

function Heading({ depth, children }: { readonly depth: number; readonly children: ReactNode }) {
  switch (depth) {
    case 1:
      return <h1>{children}</h1>;
    case 2:
      return <h2>{children}</h2>;
    case 3:
      return <h3>{children}</h3>;
    case 4:
      return <h4>{children}</h4>;
    case 5:
      return <h5>{children}</h5>;
    default:
      return <h6>{children}</h6>;
  }
}

function CodeBlock({ language, content, copyLabel, copiedLabel }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="workbench-doc-code">
      <div className="workbench-doc-codebar">
        <span>{language || 'text'}</span>
        <button type="button" onClick={copy}>
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre>
        <code>{content || '\u00a0'}</code>
      </pre>
    </div>
  );
}

function renderBlock(
  block: MarkdownBlock,
  index: number,
  labels: Pick<MarkdownDocumentProps, 'copyLabel' | 'copiedLabel'>,
) {
  const key = `doc-block-${index}`;
  switch (block.type) {
    case 'heading':
      return (
        <Heading key={key} depth={block.depth}>
          {renderInlineLines(block.content, key)}
        </Heading>
      );
    case 'paragraph':
      return <p key={key}>{renderInlineLines(block.content, key)}</p>;
    case 'quote':
      return <blockquote key={key}>{renderInlineLines(block.content, key)}</blockquote>;
    case 'list': {
      const items = block.items.map((item, itemIndex) => (
        <li key={`${key}-item-${itemIndex}`}>{renderInlineLines(item, `${key}-item-${itemIndex}`)}</li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'code':
      return (
        <CodeBlock
          key={key}
          language={block.language}
          content={block.content}
          copyLabel={labels.copyLabel}
          copiedLabel={labels.copiedLabel}
        />
      );
    case 'table':
      return (
        <div key={key} className="workbench-doc-table-wrap">
          <table>
            <thead>
              <tr>
                {block.headers.map((header, cellIndex) => (
                  <th key={`${key}-head-${cellIndex}`}>{renderInlineLines(header, `${key}-head-${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${key}-cell-${rowIndex}-${cellIndex}`}>
                      {renderInlineLines(cell, `${key}-cell-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr key={key} />;
    default:
      return null;
  }
}

export function MarkdownDocument({ content, emptyLabel, copyLabel, copiedLabel }: MarkdownDocumentProps) {
  const blocks = parseMarkdownBlocks(content);

  if (blocks.length === 0) {
    return <div className="workbench-empty-hint workbench-diff-status">{emptyLabel}</div>;
  }

  return (
    <article className="workbench-document">
      {blocks.map((block, index) => renderBlock(block, index, { copyLabel, copiedLabel }))}
    </article>
  );
}
