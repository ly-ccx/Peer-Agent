import { useMemo } from 'react';

interface SourceViewerProps {
  readonly content: string;
  readonly emptyLabel: string;
  readonly className?: string;
}

export function SourceViewer({ content, emptyLabel, className }: SourceViewerProps) {
  const lines = useMemo(() => content.split('\n'), [content]);

  if (content === '') {
    return <div className="workbench-empty-hint workbench-diff-status">{emptyLabel}</div>;
  }

  return (
    <pre className={`workbench-source-pre${className ? ` ${className}` : ''}`}>
      <code>
        {lines.map((text, i) => (
          <span key={i} className="source-line">
            <span className="source-gutter" aria-hidden="true">
              {i + 1}
            </span>
            <span className="source-line-text">{text === '' ? '\u00a0' : text}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}
