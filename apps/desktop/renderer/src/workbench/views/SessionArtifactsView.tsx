import { useMemo } from 'react';
import { useTaskOverview } from '../../app/hooks/useTaskOverview';
import {
  projectTaskOverviewArtifacts,
  type TaskArtifactProjection,
} from '../../app/pages/taskOverviewArtifacts';
import { selectConversationTaskOverviewItem } from '../taskMonitorRail';
import { useWorkbench } from '../WorkbenchContext';

/**
 * 「产物」tab（SessionArtifactsView）：本会话产物聚合。
 *
 * - 数据复用 taskOverview 会话投影 + projectTaskOverviewArtifacts 治理过滤
 *   （治理 ref 与通用文案标签永不展示），不新增数据通道。
 * - 点击条目走 openFile → 「文件」区 FilesPane 的 detail 预览（Q11：
 *   detail 组件唯一宿主是 FilesPane，本视图不内嵌预览）。
 * - 轮询仅在 tab 激活时启用（与任务监控栏 active 契约一致）。
 */

const EMPTY_PROJECTION: TaskArtifactProjection = {
  groups: [],
  summary: '',
  total: 0,
  visibleTotal: 0,
  hiddenTotal: 0,
};

export function SessionArtifactsView({ isZh, active, conversationId }: {
  readonly isZh: boolean;
  /** 「产物」tab 是否激活；未激活不轮询 taskOverview。 */
  readonly active: boolean;
  readonly conversationId: string | null;
}) {
  const { openFile } = useWorkbench();

  const items = useTaskOverview({
    enabled: active && !!conversationId,
    ...(conversationId ? { conversationId } : {}),
  });
  const overviewItem = useMemo(
    () => (conversationId ? selectConversationTaskOverviewItem(items, conversationId) : null),
    [conversationId, items],
  );
  const projection = useMemo<TaskArtifactProjection>(() => {
    if (!overviewItem) return EMPTY_PROJECTION;
    try {
      return projectTaskOverviewArtifacts(overviewItem);
    } catch {
      // 投影失败降级为空列表，不让整个 tab 不可用。
      return EMPTY_PROJECTION;
    }
  }, [overviewItem]);

  const isEmpty = projection.groups.every((group) => group.artifacts.length === 0);

  return (
    <div className="session-artifacts" aria-label={isZh ? '会话产物' : 'Session artifacts'}>
      {isEmpty ? (
        <div className="workbench-empty">
          <div className="workbench-empty-title">{isZh ? '产物' : 'Artifacts'}</div>
          <p className="workbench-empty-hint">
            {isZh
              ? '本会话暂无产物；任务产生的文件与变更会出现在这里，点击即可在文件区预览。'
              : 'No artifacts yet. Files and changes produced by tasks will appear here; click to preview in the Files pane.'}
          </p>
        </div>
      ) : (
        projection.groups.map((group) => (
          group.artifacts.length === 0 ? null : (
            <section key={group.kind} className="session-artifacts-group" aria-label={group.label}>
              <h3 className="session-artifacts-group-title">
                {group.label}
                {group.total > group.artifacts.length
                  ? (isZh ? ` · ${group.total}` : ` · ${group.total}`)
                  : ''}
              </h3>
              <ul className="session-artifacts-list">
                {group.artifacts.map((artifact) => {
                  const openPath = typeof artifact.openPath === 'string' ? artifact.openPath.trim() : '';
                  return (
                    <li key={`${artifact.kind}:${artifact.ref}`}>
                      <button
                        type="button"
                        className="session-artifacts-item"
                        disabled={!openPath}
                        title={openPath || artifact.label}
                        onClick={() => {
                          if (openPath) openFile(openPath);
                        }}
                      >
                        <span className="session-artifacts-item-kind">{group.label}</span>
                        <span className="session-artifacts-item-label">{artifact.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )
        ))
      )}
      {projection.hiddenTotal > 0 && !isEmpty ? (
        <p className="session-artifacts-more">
          {isZh
            ? `仅显示部分产物（${projection.hiddenTotal} 项被折叠）`
            : `Showing partial artifacts (${projection.hiddenTotal} collapsed)`}
        </p>
      ) : null}
    </div>
  );
}
