import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  availablePreviewSize,
  positionTaskArtifactPreview,
} from '../../app/pages/taskArtifactPreviewPosition';
import { FileKindIcon } from './FileKindIcon';
import {
  countDiffLineStats,
  diffFileBaseName,
  diffFileDisplayName,
  groupDiffByFile,
  type DiffFileGroup,
  type DiffLine,
} from './diffLines';

export { buildDiffLines, countDiffLineStats, groupDiffByFile } from './diffLines';
export type { DiffFileGroup, DiffLine, DiffLineKind } from './diffLines';

interface DiffViewerProps {
  readonly diffText: string;
  /** 工作台单文件预览已经有文件名，验收页的 range diff 才需要这条定位。 */
  readonly showFileHeaders?: boolean;
  /** 验收页只列改了哪些文件；对照用悬停弹层，不单独摊在下面。 */
  readonly showFileIndex?: boolean;
  readonly isZh?: boolean;
}

interface ActiveDiffPreview {
  readonly file: DiffFileGroup;
  readonly anchor: HTMLElement;
}

const PREVIEW_LINE_LIMIT = 80;
const HOVER_OPEN_MS = 180;

function DiffLines({ lines }: { readonly lines: readonly DiffLine[] }) {
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

function DiffFilePreviewPortal({
  active,
  isZh,
  onKeep,
  onHide,
  onDismiss,
}: {
  readonly active: ActiveDiffPreview;
  readonly isZh: boolean;
  readonly onKeep: () => void;
  readonly onHide: () => void;
  readonly onDismiss: () => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; placement: 'above' | 'below' } | null>(null);
  const stats = countDiffLineStats(active.file.lines);
  const previewLines = active.file.lines.length > PREVIEW_LINE_LIMIT
    ? active.file.lines.slice(0, PREVIEW_LINE_LIMIT)
    : active.file.lines;
  const hiddenCount = active.file.lines.length - previewLines.length;

  useLayoutEffect(() => {
    const previewElement = previewRef.current;
    if (!previewElement || !active.anchor.isConnected) return;
    const triggerRect = active.anchor.getBoundingClientRect();
    const previewRect = previewElement.getBoundingClientRect();
    setPosition(positionTaskArtifactPreview(
      triggerRect,
      { width: previewRect.width, height: previewRect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [active]);

  useEffect(() => {
    const hideIfOuter = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && previewRef.current?.contains(target)) return;
      onDismiss();
    };
    window.addEventListener('resize', onDismiss);
    window.addEventListener('scroll', hideIfOuter, true);
    return () => {
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', hideIfOuter, true);
    };
  }, [onDismiss]);

  return createPortal(
    <div
      ref={previewRef}
      className={`diff-file-preview-portal is-${position?.placement ?? 'below'}`}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        maxWidth: availablePreviewSize({ width: window.innerWidth, height: window.innerHeight }).width,
        visibility: position ? 'visible' : 'hidden',
      }}
      onMouseEnter={onKeep}
      onMouseLeave={onHide}
    >
      <div className="diff-file-preview">
        <div className="diff-file-preview-head">
          <span className="diff-file-preview-path">
            {active.file.path}
            {active.file.fromPath && active.file.fromPath !== active.file.path
              ? ` ← ${active.file.fromPath}`
              : ''}
          </span>
          <span className="diff-file-index-stats">
            {stats.additions > 0 ? <b className="is-add">+{stats.additions}</b> : null}
            {stats.deletions > 0 ? <b className="is-del">−{stats.deletions}</b> : null}
          </span>
        </div>
        <DiffLines lines={previewLines} />
        {hiddenCount > 0 ? (
          <div className="diff-file-preview-more">
            {isZh ? `还有 ${hiddenCount} 行` : `${hiddenCount} more lines`}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function DiffFileIndex({
  files,
  isZh,
}: {
  readonly files: readonly DiffFileGroup[];
  readonly isZh: boolean;
}) {
  const hideTimer = useRef<number>(0);
  const showTimer = useRef<number>(0);
  const [active, setActive] = useState<ActiveDiffPreview | null>(null);
  const rows = useMemo(() => {
    const paths = files.map((file) => file.path);
    return files.map((file, index) => ({
      file,
      index,
      name: diffFileDisplayName(file.path, paths),
      stats: countDiffLineStats(file.lines),
    }));
  }, [files]);

  const keepPreview = () => {
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(showTimer.current);
  };

  const hidePreview = () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setActive(null), 80);
  };

  const dismissPreview = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    setActive(null);
  }, []);

  const showPreview = (file: DiffFileGroup, anchor: HTMLElement) => {
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(showTimer.current);
    showTimer.current = window.setTimeout(() => {
      setActive({ file, anchor });
    }, HOVER_OPEN_MS);
  };

  useEffect(() => () => {
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(showTimer.current);
  }, []);
  useEffect(() => {
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(showTimer.current);
    setActive(null);
  }, [files]);

  useEffect(() => {
    const cancelHover = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.diff-file-preview-portal')) return;
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
      setActive((current) => (current ? null : current));
    };
    window.addEventListener('scroll', cancelHover, true);
    return () => window.removeEventListener('scroll', cancelHover, true);
  }, []);

  return (
    <div className="diff-file-index">
      <div className="diff-file-index-head">
        <span>{isZh ? `${files.length} 个文件已改` : `${files.length} Files Changed`}</span>
      </div>
      <ul className="diff-file-index-list">
        {rows.map(({ file, index, name, stats }) => {
          const isActive = active?.file === file;
          return (
            <li key={`${file.path}:${index}`}>
              <div
                className={`diff-file-index-row${isActive ? ' is-active' : ''}`}
                tabIndex={0}
                aria-label={file.path}
                onMouseEnter={(event) => showPreview(file, event.currentTarget)}
                onMouseLeave={hidePreview}
                onFocus={(event) => showPreview(file, event.currentTarget)}
                onBlur={hidePreview}
              >
                <FileKindIcon name={diffFileBaseName(file.path) || file.path} />
                <span className="diff-file-index-name">{name}</span>
                <span className="diff-file-index-stats">
                  {stats.additions > 0 ? <b className="is-add">+{stats.additions}</b> : null}
                  {stats.deletions > 0 ? <b className="is-del">−{stats.deletions}</b> : null}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {active ? (
        <DiffFilePreviewPortal
          active={active}
          isZh={isZh}
          onKeep={keepPreview}
          onHide={hidePreview}
          onDismiss={dismissPreview}
        />
      ) : null}
    </div>
  );
}

export function DiffViewer({
  diffText,
  showFileHeaders = true,
  showFileIndex = false,
  isZh = true,
}: DiffViewerProps) {
  const files = useMemo(() => groupDiffByFile(diffText), [diffText]);

  if (showFileIndex) {
    return files.length > 0 ? <DiffFileIndex files={files} isZh={isZh} /> : null;
  }

  return (
    <div className="workbench-diff-files">
      {files.map((file, fileIndex) => (
        <section key={`${file.path}:${fileIndex}`} className="diff-file">
          {showFileHeaders && file.path ? (
            <header className="diff-file-head-wrap">
              <div className="diff-file-head">
                {file.path}
                {file.fromPath && file.fromPath !== file.path ? ` ← ${file.fromPath}` : ''}
              </div>
            </header>
          ) : null}
          <DiffLines lines={file.lines} />
        </section>
      ))}
    </div>
  );
}
