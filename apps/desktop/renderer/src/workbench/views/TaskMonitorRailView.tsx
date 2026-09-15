import { useEffect, useMemo, useState } from 'react';
import {
  projectTaskMonitorArtifacts,
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
import { useWorkbench } from '../WorkbenchContext';
import { reconcileStopRequest, type StopRequest } from '../backgroundRuntimeState.ts';
import type { ManagedShellTask } from '@peer-agent/protocol';

/**
 * 任务监控栏（Task Monitor Rail）—— Qoder 式右侧信息区的 Peer 版本。
 *
 * 设计来源：peer-knowledge/design/product/task-context-rail.md（按 2026-09-15
 * 用户修正更新）：本栏是**任务监控栏**，只含 后台任务 + 产出 两个分区。
 * 环境信息（分支/本地/提交推送）归中间对话面板的 composer 环境胶囊，不在此重复。
 *
 * 治理边界：
 * - 后台任务区复用 Provider 的单一轮询 reader（useBackgroundRunsContext），
 *   停止等写操作复用同一 stops 链路 —— 不新建第二个 poller，也不是第二个全局管理面；
 * - 本栏的会话作用域合并视图与 ChatHeader 全局入口并存（那里跨会话、这里按会话）；
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
function MonitorSection({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="task-monitor-section" aria-label={title}>
      <h3 className="task-monitor-section-title">{title}</h3>
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

export function TaskMonitorRailView({ isZh, workspacePath, conversationId, active }: {
  readonly isZh: boolean;
  readonly workspacePath: string | null;
  readonly conversationId: string | null;
  /**
   * 本视图是否真正可见（Workbench 展开且停在「监控」tab）。
   *
   * Workbench 的视图槽是常挂载的（只靠 data-active 显隐，见 WorkbenchPanel），
   * 所以这里必须显式门控，否则用户从没打开过本 tab 也会多挂一路 taskOverview
   * 轮询与广播订阅——那正是 useTaskOverview.performance.test.ts 在守的调用点成本。
   */
  readonly active: boolean;
}) {
  const workbench = useWorkbench();
  // 复用 Provider 的单一轮询 reader，避免第二套 poller 重复打主进程。
  const runsReader = useBackgroundRunsContext();

  // 后台任务详情内联展开：本栏内的选中态（与 ChatHeader 弹层的选中态各自独立）。
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // 停止确认的本地态：与 BackgroundRuntimePanel 相同的两段式
  //（onConfirm 进入 confirm → onStop 校验后走 stops.stop）。
  const [confirmation, setConfirmation] = useState<StopRequest | null>(null);

  // 产出只取本会话那一条任务总览投影（按 tab 可见性门控轮询）。
  const items = useTaskOverview({
    enabled: active && !!conversationId,
    ...(conversationId ? { conversationId } : {}),
  });
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
    <div className="task-monitor-rail">
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
  );
}

// 保留投影函数的命名导出引用（测试与潜在复用方直接从 taskMonitorRail.ts 导入）。
export { projectTaskMonitorArtifacts };
