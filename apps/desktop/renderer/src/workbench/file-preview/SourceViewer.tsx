import { useMemo } from 'react';
import { boundedPresentation, presentationLimitLabel } from './presentationBudget';
import { useHighlightLanguages } from '../../chat/components/markdown/useHighlightLanguages';

import { highlightSourceLines } from './sourceHighlight.ts';

interface SourceViewerProps {
  readonly content: string;
  readonly isZh?: boolean;
  readonly emptyLabel: string;
  readonly language?: string | null;
  readonly className?: string;
}

export function SourceViewer({ content, emptyLabel, language, className, isZh = false }: SourceViewerProps) {
  const bounded = useMemo(() => boundedPresentation(content), [content]);
  const languageRevision = useHighlightLanguages();
  const highlighted = useMemo(
    () => highlightSourceLines(bounded.text, language),
    [bounded.text, language, languageRevision],
  );

  if (content === '') {
    return <div className="workbench-empty-hint workbench-diff-status">{emptyLabel}</div>;
  }

  return (
    <>
    {bounded.truncated ? <p className="resource-adapter-notice" role="status">{presentationLimitLabel(bounded, isZh)}</p> : null}
    <pre className={`workbench-source-pre${className ? ` ${className}` : ''}`}>
      <code className={highlighted.language ? `hljs language-${highlighted.language}` : undefined}>
        {highlighted.lines.map((html, i) => (
          <span key={i} className="source-line" data-source-line={i + 1}>
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
    </>
  );
}
