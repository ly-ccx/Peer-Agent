import { MotionSurface } from '../../app/components/MotionSurface';
import { useInteractionLayer } from '../../app/hooks/useInteractionLayer';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useId } from 'react';
import { createPortal } from 'react-dom';
import { availablePreviewSize, positionTaskArtifactPreview } from '../../app/pages/taskArtifactPreviewPosition';
import { PeerIcon } from '../../ui/icons';
import { FileKindIcon } from './FileKindIcon';
import { countDiffLineStats, diffFileBaseName, diffFileDisplayName, type DiffFileGroup } from './diffLines';
import { DiffLines } from './DiffRows';

interface ActiveDiffPreview {
  readonly file: DiffFileGroup;
  readonly anchor: HTMLElement;
}

const PREVIEW_LINE_LIMIT = 80;
const HOVER_OPEN_MS = 180;

function DiffFilePreviewPortal({
  active,
  isZh,
  onKeep,
  onHide,
  onDismiss,
}: {
  readonly active: ActiveDiffPreview | null;
  readonly isZh: boolean;
  readonly onKeep: () => void;
  readonly onHide: () => void;
  readonly onDismiss: () => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null); anchorRef.current = active?.anchor ?? null;
  useInteractionLayer(Boolean(active), { roots: [previewRef], trigger: anchorRef, identity: active?.anchor, passive: true, restoreFocus: false,
    closeOnTriggerRemoval: true, onClose: onDismiss });
  const [position, setPosition] = useState<{ left: number; top: number; placement: 'above' | 'below' } | null>(null);
  const lines = active?.file.lines ?? [];
  const stats = countDiffLineStats(lines);
  const previewLines = lines.length > PREVIEW_LINE_LIMIT ? lines.slice(0, PREVIEW_LINE_LIMIT) : lines;
  const hiddenCount = lines.length - previewLines.length;

  useLayoutEffect(() => {
    if (!active) return;
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
    if (!active) return;
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
  }, [active, onDismiss]);

  return createPortal(
    <MotionSurface kind="fade">{active ? (<div
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
              ? <><PeerIcon name="back" size={12} className="diff-rename-arrow" /><span className="diff-rename-source">{active.file.fromPath}</span></>
              : null}
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
    </div>) : null}</MotionSurface>,
    document.body,
  );
}

export function DiffFileIndex({
  files,
  isZh,
}: {
  readonly files: readonly DiffFileGroup[];
  readonly isZh: boolean;
}) {
  const panelId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const opened = files.find(file => JSON.stringify([file.path, file.fromPath]) === selected);
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
          const isActive = active?.file === file || opened === file;
          return (
            <li key={`${file.path}:${index}`}>
              <button type="button"
                className={`diff-file-index-row${isActive ? ' is-active' : ''}`}
                aria-label={file.path} aria-controls={panelId}
                aria-expanded={JSON.stringify([file.path, file.fromPath]) === selected}
                onClick={() => { dismissPreview(); setSelected(JSON.stringify([file.path, file.fromPath])); }}
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
              </button>
            </li>
          );
        })}
      </ul>
      {opened ? <section id={panelId} className="diff-selected-file" aria-label={opened.path}>
        <header><strong>{opened.path}</strong><button type="button" className="ui-button" onClick={() => setSelected(null)}
          aria-label={isZh ? '收起文件差异' : 'Collapse file diff'}><PeerIcon name="close" size={14} /></button></header>
        <DiffLines lines={opened.lines} />
      </section> : selected ? <p role="status">{isZh ? '所选文件已不在当前差异中。' : 'The selected file is no longer in the current diff.'}</p> : null}
      <DiffFilePreviewPortal
          active={active}
          isZh={isZh}
          onKeep={keepPreview}
          onHide={hidePreview}
          onDismiss={dismissPreview}
        />
    </div>
  );
}
