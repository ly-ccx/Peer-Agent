import { useMemo } from 'react';

import { highlightSourceLines } from './sourceHighlight.ts';

interface SourceViewerProps {
  readonly content: string;
  readonly emptyLabel: string;
  readonly language?: string | null;
  readonly className?: string;
}

export function SourceViewer({ content, emptyLabel, language, className }: SourceViewerProps) {
  const highlighted = useMemo(
    () => highlightSourceLines(content, language),
    [content, language],
  );

  if (content === '') {
    return <div className="workbench-empty-hint workbench-diff-status">{emptyLabel}</div>;
  }

  return (
    <pre className={`workbench-source-pre${className ? ` ${className}` : ''}`}>
      <code className={highlighted.language ? `hljs language-${highlighted.language}` : undefined}>
        {highlighted.lines.map((html, i) => (
          <span key={i} className="source-line">
            <span className="source-gutter" aria-hidden="true">
              {i + 1}
            </span>
            {highlighted.language ? (
              <span
                className="source-line-text"
                dangerouslySetInnerHTML={{ __html: html === '' ? '&nbsp;' : html }}
              />
            ) : (
              <span className="source-line-text">{html === '' ? '\u00a0' : html}</span>
            )}
          </span>
        ))}
      </code>
    </pre>
  );
}
