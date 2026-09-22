import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkbench } from '../WorkbenchContext';
import { FilesView } from './FilesView';
import { DocumentView } from './DocumentView';

/**
 * 「文件」区（FilesPane）：master-detail 容器。
 *
 * - master = 常驻文件树（FilesView），detail = 文件预览（DocumentView）。
 * - 点文件走 openFileInPlace：只更新 detail，不切一级 tab（right-workbench-panel.md Q10）。
 * - 宽度 ≥ 560px 左右分栏（树约 40%）；更窄时 detail 覆盖树，返回按钮/Esc 回纯树。
 * - 返回只隐藏覆盖层（本地 UI 态），文档会话不动；再点树中文件立即重新显示 detail。
 */

const NARROW_THRESHOLD_PX = 560;

export function FilesPane({ isZh, workspacePath }: {
  readonly isZh: boolean;
  readonly workspacePath: string | null;
}) {
  const { documentSession, setDocumentSession } = useWorkbench();
  const [narrow, setNarrow] = useState(false);
  const [detailHidden, setDetailHidden] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setNarrow(width > 0 && width < NARROW_THRESHOLD_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 文档会话变化（点树、点聊天路径、产物条目）时解除窄态覆盖，立刻显示 detail。
  useEffect(() => {
    setDetailHidden(false);
  }, [documentSession]);

  const hasTabs = documentSession.tabs.length > 0;
  const overlayShown = narrow && hasTabs && !detailHidden;

  // Esc 与返回按钮同效：仅窄覆盖态生效，不影响宽屏分栏。
  useEffect(() => {
    if (!overlayShown) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetailHidden(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [overlayShown]);

  const handleBack = useCallback(() => setDetailHidden(true), []);

  return (
    <div
      ref={hostRef}
      className="files-pane"
      data-narrow={narrow}
      data-detail-hidden={narrow && detailHidden}
    >
      <div className="files-pane-master" data-covered={overlayShown}>
        <FilesView isZh={isZh} workspacePath={workspacePath} />
      </div>
      <div className="files-pane-detail" data-overlay={overlayShown}>
        <DocumentView
          isZh={isZh}
          session={documentSession}
          onSessionChange={setDocumentSession}
          onBack={overlayShown ? handleBack : undefined}
        />
      </div>
    </div>
  );
}
