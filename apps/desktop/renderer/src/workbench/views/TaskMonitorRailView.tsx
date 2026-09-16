import { useEffect, useMemo, useState } from 'react';
import {
  projectTaskMonitorArtifacts,
  projectTaskMonitorEnvironment,
  projectTaskMonitorRuns,
  selectConversationTaskOverviewItem,
} from '../taskMonitorRail.ts';
import {
  projectTaskOverviewArtifacts,
  type TaskArtifactProjection,
} from '../../app/pages/taskOverviewArtifacts.ts';
import { useTaskOverview } from '../../app/hooks/useTaskOverview';
import { useBackgroundRunsContext } from '../GlobalBackgroundTasksButton';
import { BackgroundRunDetails } from '../BackgroundRunDetails';
import { useWorkbenchOptional } from '../WorkbenchContext';
import { reconcileStopRequest, type StopRequest } from '../backgroundRuntimeState.ts';
import type { ManagedShellTask } from '@peer-agent/protocol';

/**
 * 任务监控栏（Task Monitor Rail）—— Qoder 式右侧信息区的 Peer 版本。
 *
 * 设计来源：peer-knowledge/design/product/task-context-rail.md，并按用户截图纠偏：
 * 本栏归当前 ChatSurface，合并环境信息、当前会话后台任务、计划进度与产出；
 * composer 环境胶囊继续作为输入区的紧凑入口，两者复用同一环境事实。
 *
 * 治理边界：
 * - 后台任务区复用 Provider 的单一轮询 reader（useBackgroundRunsContext），
 *   停止等写操作复用同一 stops 链路 —— 不新建第二个 poller，也不是第二个全局管理面；
 * - 本栏由 ChatSurface 挂载并跟随当前会话，不属于独立 Workbench；
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
      <path d="M3 7a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function DeviceIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="3" y="4" width="18" height="13" rx="1.5" />
      <path d="M8 21h8M12 17v4" />
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

/** 分区 = 独立小卡（控制中心式堆叠）：每张卡自带圆角/毛玻璃/阴影/内边距。
 * variant：wide 全宽卡；tile 半宽小卡（与相邻 tile 并排，对齐控制中心 Wi-Fi/蓝牙形态）。 */
function MonitorSection({
  title,
  variant = 'wide',
  icon,
  children,
}: {
  readonly title: string;
  readonly variant?: 'wide' | 'tile';
  readonly icon?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section
      className={`task-monitor-section task-monitor-section--${variant}`}
      aria-label={title}
    >
      <h3 className="task-monitor-section-title">
        {icon ? <span className="task-monitor-section-icon">{icon}</span> : null}
        <span>{title}</span>
      </h3>
      {children}
    </section>
  );
}

function MonitorRow({ icon, value, detail, onClick }: {
  readonly icon: React.ReactNode;
  readonly value: string;
  readonly detail?: string;
  readonly onClick?: () => void;
}) {
  const content = (
    <>
      <span className="task-monitor-row-icon">{icon}</span>
      <span className="task-monitor-row-value" title={detail || value}>{value}</span>
    </>
  );
  if (!onClick) {
    return <div className="task-monitor-row">{content}</div>;
  }
  return (
    <button type="button" className="task-monitor-row task-monitor-row--action" onClick={onClick}>
      {content}
    </button>
  );
}

export function TaskMonitorRailView({
  isZh,
  workspacePath,
  branch,
  workspaceIsGit,
  conversationId,
  active,
  onClose,
}: {
  readonly isZh: boolean;
  readonly workspacePath: string | null;
  readonly branch: string | null;
  readonly workspaceIsGit: boolean | null;
  readonly conversationId: string | null;
  /**
   * 本视图是否在当前 ChatSurface 内真正可见。
   *
   * 收起时仍保留组件状态，但必须显式门控 taskOverview，避免未打开监控栏时多挂一路
   * 轮询与广播订阅——那正是 useTaskOverview.performance.test.ts 在守的调用点成本。
   */
  readonly active: boolean;
  readonly onClose: () => void;
}) {
  const workbench = useWorkbenchOptional();
  // 复用 Provider 的单一轮询 reader，避免第二套 poller 重复打主进程。
  const runsReader = useBackgroundRunsContext();
  const environment = useMemo(
    () => projectTaskMonitorEnvironment(workspacePath, branch, workspaceIsGit, isZh),
    [branch, isZh, workspaceIsGit, workspacePath],
  );

  // 后台任务详情内联展开：本栏内的选中态（与 ChatHeader 弹层的选中态各自独立）。
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // 停止确认的本地态：与 BackgroundRuntimePanel 相同的两段式
  //（onConfirm 进入 confirm → onStop 校验后走 stops.stop）。
  const [confirmation, setConfirmation] = useState<StopRequest | null>(null);

  // 进度与产出共用本会话同一条任务总览投影（按可见性门控轮询）。
  const items = useTaskOverview({
    enabled: active && !!conversationId,
    ...(conversationId ? { conversationId } : {}),
  });
  const overviewItem = useMemo(
    () => (conversationId ? selectConversationTaskOverviewItem(items, conversationId) : null),
    [conversationId, items],
  );
  const artifactProjection = useMemo<TaskArtifactProjection>(() => {
    const empty: TaskArtifactProjection = {
      groups: [], summary: '', total: 0, visibleTotal: 0, hiddenTotal: 0,
    };
    if (!overviewItem) return empty;
    try {
      // 投影函数自身已做治理 ref 过滤与上限截断；此处只兜异常。
      return projectTaskOverviewArtifacts(overviewItem);
    } catch {
      return empty;
    }
  }, [overviewItem]);

  const runs = useMemo(
    () => projectTaskMonitorRuns(runsReader?.snapshot ?? null, conversationId, isZh),
    [runsReader?.snapshot, conversationId, isZh],
  );

  const selectedRun: ManagedShellTask | null = useMemo(() => {
    if (!selectedRunId || !runsReader?.snapshot) return null;
    return runsReader.snapshot.find((task) => task.taskId === selectedRunId) ?? null;
  }, [selectedRunId, runsReader?.snapshot]);

  // 与 BackgroundRuntimePanel 相同的调停：运行消失/终态时收掉过期确认态。
  useEffect(() => {
    if (!selectedRun) return;
    setConfirmation((current) => reconcileStopRequest(current, [selectedRun]));
  }, [selectedRun]);

  const stops = runsReader?.stops ?? null;
  // 两段式合并：本地确认态优先，其次 stops 链路自身的请求态。
  const runRequest: StopRequest | null = confirmation
    ?? (selectedRun ? stops?.requests[selectedRun.taskId] ?? null : null);
  const stopSelectedRun = () => {
    if (!selectedRun || selectedRun.status !== 'running' || confirmation?.taskId !== selectedRun.taskId) return;
    setConfirmation(null);
    void stops?.stop(selectedRun.taskId);
  };

  return (
    <aside className="task-monitor-rail" aria-label={isZh ? '任务监控卡片' : 'Task monitor card'}>
      <header className="task-monitor-header">
        <span>{isZh ? '任务监控' : 'Task monitor'}</span>
        <span className="task-monitor-updated" aria-live="off">{isZh ? '实时' : 'Live'}</span>
        <button
          type="button"
          className="task-monitor-close"
          aria-label={isZh ? '收起任务监控卡片' : 'Close task monitor'}
          onClick={onClose}
        >
          <svg {...ICON_PROPS}><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </header>
      <div className="task-monitor-scroll">
      {/* 环境信息：tile 小卡矩阵（控制中心式），分支/工作区/运行位置各自成卡。 */}
      <div className="task-monitor-tiles">
        {environment.map((row) => (
          <MonitorSection
            key={row.id}
            title={row.label}
            variant="tile"
            icon={row.icon === 'branch' ? <BranchIcon /> : row.icon === 'folder' ? <FolderIcon /> : <DeviceIcon />}
          >
            <div className="task-monitor-tile-value" title={row.detail ?? row.value}>
              {row.value}
            </div>
          </MonitorSection>
        ))}
      </div>

      {overviewItem?.planProgress ? (
        <MonitorSection title={isZh ? '任务进度' : 'Progress'}>
          <div className="task-monitor-progress-row">
            <span>{overviewItem.statusLabel}</span>
            <strong>{overviewItem.planProgress.completed} / {overviewItem.planProgress.total}</strong>
          </div>
          <div
            className="task-monitor-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={overviewItem.planProgress.total}
            aria-valuenow={overviewItem.planProgress.completed}
          >
            <span style={{ width: `${overviewItem.planProgress.total > 0 ? Math.min(100, Math.max(0, (overviewItem.planProgress.completed / overviewItem.planProgress.total) * 100)) : 0}%` }} />
          </div>
        </MonitorSection>
      ) : null}

      {runs.length > 0 ? (
        <MonitorSection title={isZh ? '后台任务' : 'Background tasks'}>
          {runs.map((row) => (
            <MonitorRow
              key={row.taskId}
              icon={<TerminalIcon />}
              value={row.cwdLabel ? `${row.command} · ${row.cwdLabel}` : row.command}
              detail={row.command}
              onClick={() => {
                // 行内展开/收起详情（监控语义：点行看状态，不离开本栏）。
                setSelectedRunId((current) => (current === row.taskId ? null : row.taskId));
              }}
            />
          ))}
          {/* 内联详情：复用既有的 BackgroundRunDetails（含两段式停止确认）。 */}
          {selectedRun ? (
            <div className="task-monitor-run-details">
              <BackgroundRunDetails
                key={selectedRun.taskId}
                task={selectedRun}
                sources={runsReader?.sources ?? null}
                isZh={isZh}
                request={runRequest}
                onConfirm={() => setConfirmation({ taskId: selectedRun.taskId, phase: 'confirm' })}
                onCancel={() => setConfirmation(null)}
                onStop={stopSelectedRun}
              />
            </div>
          ) : null}
        </MonitorSection>
      ) : null}

      {artifactProjection.total > 0 ? (
        <MonitorSection title={isZh ? '产出' : 'Outputs'}>
          {artifactProjection.groups.map((group) => (
            group.artifacts.map((artifact) => (
              <MonitorRow
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
            <p className="task-monitor-more">
              {isZh
                ? `另有 ${artifactProjection.hiddenTotal} 项`
                : `${artifactProjection.hiddenTotal} more`}
            </p>
          ) : null}
        </MonitorSection>
      ) : null}
      </div>
    </aside>
  );
}

// 保留投影函数的命名导出引用（测试与潜在复用方直接从 taskMonitorRail.ts 导入）。
export { projectTaskMonitorArtifacts };
