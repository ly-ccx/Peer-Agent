import { useMemo } from 'react';

import { buildDiffLines } from './diffLines';

export { buildDiffLines } from './diffLines';
export type { DiffLine, DiffLineKind } from './diffLines';

interface DiffViewerProps {
  readonly diffText: string;
}

export function DiffViewer({ diffText }: DiffViewerProps) {
  const lines = useMemo(() => buildDiffLines(diffText), [diffText]);

  return (
    <pre className="workbench-diff-pre">
      <code>
        {lines.map((line, i) => (
          <span key={i} className={`diff-line diff-line--${line.kind}`}>
            <span className="diff-gutter diff-gutter--old" aria-hidden="true">
              {line.oldNo ?? ''}
            </span>
            <span className="diff-gutter diff-gutter--new" aria-hidden="true">
              {line.newNo ?? ''}
            </span>
            <span className="diff-line-text">{line.text === '' ? '\u00a0' : line.text}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}
