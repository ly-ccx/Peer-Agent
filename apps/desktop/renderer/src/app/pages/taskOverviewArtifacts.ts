import type {
  TaskOverviewArtifact,
  TaskOverviewArtifactKind,
  TaskOverviewItem,
} from '@peer-agent/protocol';

const ALLOWED_KINDS = new Set<TaskOverviewArtifactKind>(['code', 'file', 'image']);
const BLOCKED_REF_PREFIXES = [
  'local-shell-artifact://',
  'tool-result://',
  'goal-plan://',
];
const BLOCKED_LABELS = new Set(['执行证据', '命令执行结果']);

export const MAX_VISIBLE_ARTIFACTS_PER_KIND = 2;

const KIND_META = {
  code: {
    label: '代码变更',
    actionLabel: '查看变更',
    countLabel: (count: number) => `${count} 处代码变更`,
  },
  file: {
    label: '文件',
    actionLabel: '打开文件',
    countLabel: (count: number) => `${count} 个文件`,
  },
  image: {
    label: '截图',
    actionLabel: '预览截图',
    countLabel: (count: number) => `${count} 张截图`,
  },
} as const;

export interface TaskArtifactGroup {
  readonly kind: TaskOverviewArtifactKind;
  readonly label: string;
  readonly artifacts: readonly TaskOverviewArtifact[];
  readonly total: number;
}

export interface TaskArtifactProjection {
  readonly groups: readonly TaskArtifactGroup[];
  readonly summary: string;
  readonly total: number;
  readonly visibleTotal: number;
  readonly hiddenTotal: number;
}

type ActionableUserArtifact = TaskOverviewArtifact & { readonly openPath: string };

function isActionableUserArtifact(value: unknown): value is ActionableUserArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Partial<TaskOverviewArtifact>;
  const ref = typeof artifact.ref === 'string' ? artifact.ref.trim() : '';
  const openPath = typeof artifact.openPath === 'string' ? artifact.openPath.trim() : '';
  const label = typeof artifact.label === 'string' ? artifact.label.trim() : '';
  if (!ALLOWED_KINDS.has(artifact.kind as TaskOverviewArtifactKind)) return false;
  if (!ref || BLOCKED_REF_PREFIXES.some((prefix) => ref.startsWith(prefix))) return false;
  if (!openPath || !label || BLOCKED_LABELS.has(label)) return false;
  return true;
}

export function projectTaskOverviewArtifacts(item: TaskOverviewItem): TaskArtifactProjection {
  const unique = new Map<string, ActionableUserArtifact>();
  for (const step of item.planSteps ?? []) {
    for (const candidate of step.artifacts ?? []) {
      if (!isActionableUserArtifact(candidate)) continue;
      const key = `${candidate.kind}:${candidate.ref}`;
      if (unique.has(key)) continue;
      const meta = KIND_META[candidate.kind];
      unique.set(key, {
        ...candidate,
        label: candidate.label.trim(),
        actionLabel: candidate.actionLabel?.trim() || meta.actionLabel,
        openPath: candidate.openPath.trim(),
      });
    }
  }

  const groups: TaskArtifactGroup[] = [];
  const summaryParts: string[] = [];
  let visibleTotal = 0;
  for (const kind of ['code', 'file', 'image'] as const) {
    const artifacts = [...unique.values()].filter((artifact) => artifact.kind === kind);
    if (artifacts.length === 0) continue;
    const visible = artifacts.slice(0, MAX_VISIBLE_ARTIFACTS_PER_KIND);
    visibleTotal += visible.length;
    summaryParts.push(KIND_META[kind].countLabel(artifacts.length));
    groups.push({
      kind,
      label: KIND_META[kind].label,
      artifacts: visible,
      total: artifacts.length,
    });
  }

  return {
    groups,
    summary: summaryParts.join(' · '),
    total: unique.size,
    visibleTotal,
    hiddenTotal: unique.size - visibleTotal,
  };
}
