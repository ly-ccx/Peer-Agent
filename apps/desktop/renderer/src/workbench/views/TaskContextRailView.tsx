import { useMemo } from 'react';
import {
  projectTaskOverviewArtifacts,
  type TaskArtifactProjection,
} from '../../app/pages/taskOverviewArtifacts.ts';
import { useTaskOverview } from '../../app/hooks/useTaskOverview';
import { useWorkspaceGit } from '../../chat/hooks/useWorkspaceGit';
import { useBackgroundRunsContext } from '../GlobalBackgroundTasksButton';
import { useWorkbench } from '../WorkbenchContext';
import {
  projectTaskContextEnvironment,
  projectTaskContextRuns,
  selectConversationTaskOverviewItem,
} from '../taskContextRail.ts';

/**
 * 任务上下文栏 —— Qoder 式右侧信息的 Peer 版本（P0 三区）。
 *
 * 设计来源：peer-knowledge/design/product/task-context-rail.md
 * 本组件是**只读投影**：
 * - 不新增 IPC / 协议类型 / 权限判定；
 * - 后台进程区按会话过滤，只是 Runtime 快照的会话作用域视图，
 *   不承担管理职责（管理仍在 ChatHeader 的后台运行入口）；
 * - 产出区复用任务总览的投影与治理 ref 过滤，禁止放宽。
 */

const ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function BranchIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="9" r="2.2" />
      <path d="M6 7.2v9.6M8.2 5h5.3A2.5 2.5 0 0 1 16 7.5V9" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 7a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function DeviceIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="2.5" y="4.5" width="19" height="12" rx="2" />
      <path d="M8 20h8M12 16.5V20" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4" />
    </svg>
  );
}

function ArtifactIcon({ kind }: { readonly kind: 'code' | 'file' | 'image' }) {
  if (kind === 'image') {
    return (
      <svg {...ICON_PROPS}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.6" />
        <path d="M20 16l-4.5-4L7 20" />
      </svg>
    );
  }
  if (kind === 'file') {
    return (
      <svg {...ICON_PROPS}>
        <path d="M6 3h7l5 5v13H6z" />
        <path d="M13 3v5h5" />
      </svg>
    );
  }
  return (
    <svg {...ICON_PROPS}>
      <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
    </svg>
  );
}

/** 分区容器：空分区保留标题、不写占位文案（对齐 Qoder 空分区行为）。 */
function RailSection({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="task-context-section" aria-label={title}>
      <h3 className="task-context-section-title">{title}</h3>
      {children}
    </section>
  );
}

function RailRow({ icon, value, detail, onClick }: {
  readonly icon: React.ReactNode;
  readonly value: string;
  readonly detail?: string;
  readonly onClick?: () => void;
}) {
  const content = (
    <>
      <span className="task-context-row-icon">{icon}</span>
      <span className="task-context-row-value" title={detail || value}>{value}</span>
    </>
  );
  if (!onClick) {
    return <div className="task-context-row">{content}</div>;
  }
  return (
    <button type="button" className="task-context-row task-context-row--action" onClick={onClick}>
      {content}
    </button>
  );
}

export function TaskContextRailView({ isZh, workspacePath, conversationId }: {
  readonly isZh: boolean;
  readonly workspacePath: string | null;
  readonly conversationId: string | null;
}) {
  const workbench = useWorkbench();
  const { workspaceGit } = useWorkspaceGit(workspacePath);
  // 复用 Provider 的单一轮询 reader，避免第二套 poller 重复打主进程。
  const runsReader = useBackgroundRunsContext();

  // 产出只取本会话那一条任务总览投影：conversationId 即其稳定身份。
  const items = useTaskOverview(
    conversationId ? { conversationId, enabled: true } : { enabled: false },
  );
  const artifactProjection = useMemo<TaskArtifactProjection>(() => {
    const empty: TaskArtifactProjection = {
      groups: [], summary: '', total: 0, visibleTotal: 0, hiddenTotal: 0,
    };
    if (!conversationId) return empty;
    // 会话作用域查询返回的多是 goal_plan 投影（taskId 为 planId），
    // 因此按 taskId 或 item.conversationId 命中本会话那一条。
    const item = selectConversationTaskOverviewItem(items, conversationId);
    if (!item) return empty;
    try {
      // 投影函数自身已做治理 ref 过滤与上限截断；此处只兜异常。
      return projectTaskOverviewArtifacts(item);
    } catch {
      return empty;
    }
  }, [conversationId, items]);

  const environment = useMemo(() => projectTaskContextEnvironment({
    workspacePath,
    workspaceIsGit: workspaceGit == null ? null : workspaceGit.ok,
    currentBranch: workspaceGit?.current ?? null,
  }, isZh), [workspacePath, workspaceGit, isZh]);

  const runs = useMemo(
    () => projectTaskContextRuns(runsReader?.snapshot ?? null, conversationId, isZh),
    [runsReader?.snapshot, conversationId, isZh],
  );

  return (
    <div className="task-context-rail">
      {environment.length > 0 ? (
        <RailSection title={isZh ? '环境信息' : 'Environment'}>
          {environment.map((row) => (
            <RailRow
              key={row.id}
              icon={row.icon === 'branch' ? <BranchIcon /> : row.icon === 'folder' ? <FolderIcon /> : <DeviceIcon />}
              value={row.value}
              detail={row.detail}
              {...(row.openTarget === 'branch' && workspacePath
                ? { onClick: () => workbench?.setActiveTab('files') }
                : row.openTarget === 'workspace' && workspacePath
                  ? { onClick: () => workbench?.revealInFiles(workspacePath) }
                  : {})}
            />
          ))}
        </RailSection>
      ) : null}

      {runs.length > 0 ? (
        <RailSection title={isZh ? '后台进程' : 'Background processes'}>
          {runs.map((row) => (
            <RailRow
              key={row.taskId}
              icon={<TerminalIcon />}
              value={row.cwdLabel ? `${row.command} · ${row.cwdLabel}` : row.command}
              detail={row.command}
              onClick={() => {
                // 打开既有详情入口：本栏不做停止/重跑等管理动作，
                // 复用 ChatHeader 的同一个后台运行面板（含单一轮询 reader）。
                runsReader?.requestRunDetails(row.taskId);
              }}
            />
          ))}
        </RailSection>
      ) : null}

      {artifactProjection.total > 0 ? (
        <RailSection title={isZh ? '产出' : 'Outputs'}>
          {artifactProjection.groups.map((group) => (
            group.artifacts.map((artifact) => (
              <RailRow
                key={`${group.kind}:${artifact.ref}`}
                icon={<ArtifactIcon kind={group.kind} />}
                value={artifact.label}
                detail={artifact.label}
                {...(artifact.openPath
                  ? {
                    onClick: () => {
                      if (group.kind === 'code') {
                        workbench?.openDiff(artifact.openPath!, workspacePath ?? undefined);
                      } else {
                        workbench?.openFile(artifact.openPath!, workspacePath ?? undefined);
                      }
                    },
                  }
                  : {})}
              />
            ))
          ))}
          {artifactProjection.hiddenTotal > 0 ? (
            <p className="task-context-more">
              {isZh
                ? `另有 ${artifactProjection.hiddenTotal} 项`
                : `${artifactProjection.hiddenTotal} more`}
            </p>
          ) : null}
        </RailSection>
      ) : null}
    </div>
  );
}
