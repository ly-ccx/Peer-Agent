import { useMemo } from 'react';
import { PeerIcon } from '../../ui/icons';
import { groupDiffByFile } from './diffLines';
import { DiffFileIndex } from './DiffFileIndex';
import { DiffLines } from './DiffRows';
import { SourceViewer } from './SourceViewer';
import { prepareDiffPresentation, diffFallbackLabel } from './diffPresentationState';
export { buildDiffLines, countDiffLineStats, groupDiffByFile } from './diffLines';
export type { DiffFileGroup, DiffLine, DiffLineKind } from './diffLines';

interface DiffViewerProps {
  readonly diffText: string;
  /** 工作台单文件预览已经有文件名，验收页的 range diff 才需要这条定位。 */
  readonly showFileHeaders?: boolean;
  /** 文件索引支持显式点击阅读；悬停只提供有界的快捷预览。 */
  readonly showFileIndex?: boolean;
  readonly isZh?: boolean;
}

export function DiffViewer({
  diffText,
  showFileHeaders = true,
  showFileIndex = false,
  isZh = true,
}: DiffViewerProps) {
  const presentation = useMemo(() => prepareDiffPresentation(diffText), [diffText]);
  const files = useMemo(() => presentation.mode === 'unified' ? groupDiffByFile(presentation.text) : [], [presentation]);
  if (presentation.mode === 'raw') return <div className="workbench-diff-files">
    <p className="resource-adapter-notice" role="status">{diffFallbackLabel(presentation.reason, isZh)}</p>
    <SourceViewer content={diffText} isZh={isZh} emptyLabel={isZh ? 'Diff 为空。' : 'The diff is empty.'} />
  </div>;

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
                {file.fromPath && file.fromPath !== file.path ? <><PeerIcon name="back" size={12} className="diff-rename-arrow" /><span className="diff-rename-source">{file.fromPath}</span></> : null}
              </div>
            </header>
          ) : null}
          <DiffLines lines={file.lines} />
        </section>
      ))}
    </div>
  );
}
