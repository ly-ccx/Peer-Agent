import type { TaskOverviewItem } from '@peer-agent/protocol';
import type { AcceptancePhase } from '../state/acceptanceTransition';
import { formatDuration } from '../../chat/state/format';
import { PeerIcon } from '../../ui/icons';

/**
 * 目标线（Goal Thread）共享分组模块 —— 供区级 TaskOverviewPage 与
 * 总工作台 GlobalWorkbenchPage 共用（2026-08-16 从 TaskOverviewPage 提取）。
 *
 * 逻辑与提取前逐行等价，见 TaskOverviewPage.goalThread.test.ts 的回归约束。
 */

export type ThreadTreeNode = {
  readonly item: TaskOverviewItem;
  readonly depth: number;
  readonly isChild: boolean;
  readonly isCurrent: boolean;
  readonly isContext: boolean;
};

export type GoalThreadEntry = {
  readonly item: TaskOverviewItem;
  readonly phase?: AcceptancePhase | null;
};

export type GoalThreadGroup =
  | {
      kind: 'thread';
      rootPlanId: string;
      rootPlanTitle?: string;
      items: { item: TaskOverviewItem; phase: AcceptancePhase | null }[];
      latest: { item: TaskOverviewItem; phase: AcceptancePhase | null };
      nodes: ThreadTreeNode[];
      pendingCount: number;
    }
  | {
      kind: 'single';
      item: TaskOverviewItem;
      phase: AcceptancePhase | null;
    };

function compareThreadItems(a: TaskOverviewItem, b: TaskOverviewItem): number {
  const ar = a.round ?? Number.POSITIVE_INFINITY;
  const br = b.round ?? Number.POSITIVE_INFINITY;
  if (ar !== br) return ar - br;
  return String(a.taskId).localeCompare(String(b.taskId));
}

function compareThreadEntries(
  a: { item: TaskOverviewItem },
  b: { item: TaskOverviewItem },
): number {
  return compareThreadItems(a.item, b.item);
}

function pickLatestPending(
  items: readonly { item: TaskOverviewItem; phase: AcceptancePhase | null }[],
): { item: TaskOverviewItem; phase: AcceptancePhase | null } | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].item.actionRight === 'result_ready') return items[index];
  }
  return undefined;
}

/**
 * 目标线（Goal Thread）分组 —— 结果待验收区的归组规则：
 * - 同 rootPlanId 的卡片归为一条线（≥2 张才成组；单张线归属卡与普通卡无异，
 *   避免给独立目标套一层空壳分组）。
 * - 组内按 round 升序（round 缺省排最后），线头标题用 rootPlanTitle。
 * - 无 rootPlanId 的旧数据按单卡平铺，渲染路径与现状完全一致（向后兼容）。
 * 输入顺序即投影层排序，组间顺序保持稳定。
 */
export function groupResultCardsByGoalThread(
  entries: readonly GoalThreadEntry[],
  contextItems: readonly TaskOverviewItem[] = [],
): GoalThreadGroup[] {
  const threads = new Map<
    string,
    {
      rootPlanId: string;
      rootPlanTitle?: string;
      items: { item: TaskOverviewItem; phase: AcceptancePhase | null }[];
    }
  >();
  for (const entry of entries) {
    const phase = entry.phase ?? null;
    const rootPlanId = entry.item.rootPlanId;
    // 无关系字段的旧数据不进 threads 收集；single 平铺在下方 emit 循环处理
    // （2026-08-14 回归：旧实现把 singles 收集后从未 emit，卡片全部消失）。
    if (!rootPlanId) continue;
    const existing = threads.get(rootPlanId);
    if (existing) {
      existing.items.push({ item: entry.item, phase });
    } else {
      threads.set(rootPlanId, {
        rootPlanId,
        rootPlanTitle: entry.item.rootPlanTitle,
        items: [{ item: entry.item, phase }],
      });
    }
  }
  const result: GoalThreadGroup[] = [];
  const emitted = new Set<string>();
  for (const entry of entries) {
    const phase = entry.phase ?? null;
    const rootPlanId = entry.item.rootPlanId;
    if (!rootPlanId) {
      result.push({ kind: 'single', item: entry.item, phase });
      continue;
    }
    if (emitted.has(rootPlanId)) continue;
    emitted.add(rootPlanId);
    const thread = threads.get(rootPlanId);
    if (!thread) continue;
    thread.items.sort(compareThreadEntries);
    const latest = pickLatestPending(thread.items) ?? thread.items[thread.items.length - 1];
    const nodes = buildThreadTreeNodes(thread.rootPlanId, thread.items, contextItems);
    if (thread.items.length < 2 && nodes.length < 2) {
      // 单张线归属卡：没有同线上下文时不套树，直接平铺。
      const solo = thread.items[0];
      result.push({ kind: 'single', item: solo.item, phase: solo.phase });
      continue;
    }
    const pendingCount = thread.items.filter((entry) => entry.item.actionRight === 'result_ready').length;
    result.push({
      kind: 'thread',
      ...thread,
      latest,
      nodes,
      pendingCount,
    });
  }
  return result;
}

export function buildThreadTreeNodes(
  rootPlanId: string,
  pendingEntries: readonly { item: TaskOverviewItem; phase: AcceptancePhase | null }[],
  contextItems: readonly TaskOverviewItem[],
): ThreadTreeNode[] {
  const pendingIds = new Set(pendingEntries.map((entry) => entry.item.taskId));
  const latestPending = pickLatestPending(pendingEntries)?.item.taskId;
  const byId = new Map<string, TaskOverviewItem>();
  for (const item of contextItems) {
    if (item.rootPlanId === rootPlanId || item.taskId === rootPlanId) {
      byId.set(item.taskId, item);
    }
  }
  for (const entry of pendingEntries) {
    byId.set(entry.item.taskId, entry.item);
  }

  const children = new Map<string, TaskOverviewItem[]>();
  for (const item of byId.values()) {
    const parentId = item.parentPlanId && byId.has(item.parentPlanId)
      ? item.parentPlanId
      : item.taskId === rootPlanId
        ? null
        : rootPlanId;
    if (!parentId || parentId === item.taskId) continue;
    const bucket = children.get(parentId) ?? [];
    bucket.push(item);
    children.set(parentId, bucket);
  }
  for (const bucket of children.values()) {
    bucket.sort(compareThreadItems);
  }

  const nodes: ThreadTreeNode[] = [];
  const walk = (item: TaskOverviewItem, depth: number) => {
    nodes.push({
      item,
      depth,
      isChild: depth > 0,
      isCurrent: item.taskId === latestPending,
      isContext: !pendingIds.has(item.taskId),
    });
    for (const child of children.get(item.taskId) ?? []) {
      walk(child, depth + 1);
    }
  };

  const root = byId.get(rootPlanId)
    ?? pendingEntries.find((entry) => !entry.item.parentPlanId)?.item
    ?? pendingEntries[0]?.item;
  if (!root) return nodes;
  walk(root, 0);
  for (const item of [...byId.values()].sort(compareThreadItems)) {
    if (nodes.some((node) => node.item.taskId === item.taskId)) continue;
    walk(item, item.parentPlanId && byId.has(item.parentPlanId) ? 1 : 0);
  }
  return nodes;
}

export function threadRowStatus(item: TaskOverviewItem, isContext: boolean): string {
  if (item.actionRight === 'result_ready') return '等待验收';
  if (item.actionRight === 'peer_advancing') return item.statusLabel || '推进中';
  if (item.actionRight === 'needs_you') return item.statusLabel || '需要你';
  if (item.actionRight === 'paused') return item.statusLabel || '已暂停';
  if (isContext) return item.statusLabel || '已完成';
  return item.statusLabel || '已完成';
}

export function threadRowFraction(item: TaskOverviewItem): string | null {
  if (!item.planProgress || !item.planProgress.total) return null;
  return `${item.planProgress.completed}/${item.planProgress.total}`;
}

export function ThreadTree({
  nodes,
  currentId,
  onOpenItem,
}: {
  readonly nodes: readonly ThreadTreeNode[];
  readonly currentId?: string;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
}) {
  return (
    <div className="thread-tree" role="tree" aria-label="目标线">
      {nodes.map((node) => {
        const fraction = threadRowFraction(node.item);
        const duration = typeof node.item.durationMs === 'number'
          ? formatDuration(node.item.durationMs)
          : null;
        const current = node.isCurrent || node.item.taskId === currentId;
        return (
          <button
            key={node.item.taskId}
            type="button"
            role="treeitem"
            className={`thread-tree-row${node.isChild ? ' is-child' : ''}${current ? ' is-current' : ''}${node.isContext ? ' is-context' : ''}`}
            aria-current={current ? 'true' : undefined}
            onClick={() => onOpenItem?.(node.item)}
          >
            <span className={`thread-tree-pill${node.item.actionRight === 'result_ready' ? ' is-wait' : ''}`}>
              {threadRowStatus(node.item, node.isContext)}
            </span>
            <span className="thread-tree-title">{node.item.title}</span>
            {node.isContext && node.item.actionRight !== 'result_ready' ? (
              <span className="thread-tree-note">未进队列</span>
            ) : duration ? (
              <span className="thread-tree-meta">用时 {duration}</span>
            ) : (
              <span className="thread-tree-meta" />
            )}
            {fraction ? <span className="thread-tree-frac">{fraction}</span> : <span className="thread-tree-frac" />}
            <span className="thread-tree-chevron" aria-hidden="true"><PeerIcon name="chevronRight" size={12} /></span>
          </button>
        );
      })}
    </div>
  );
}
