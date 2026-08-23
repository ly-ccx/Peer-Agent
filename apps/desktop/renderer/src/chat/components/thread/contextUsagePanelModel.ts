import type { ContextUsageBreakdown, ContextUsageCategoryId } from '@peer-agent/protocol';
import { formatTokenCount } from '../../state/format.ts';

export const CONTEXT_USAGE_CATEGORY_COLORS: Record<ContextUsageCategoryId, string> = {
  system_prompt: '#8b919a',
  tool_definitions: '#8b6cc7',
  rules: '#3d8a5a',
  skills: '#c4893a',
  mcp_tools: '#b44d8a',
  subagents: '#3d7ad6',
  summarized_conversation: '#c45a6a',
  conversation: '#e24b4b',
};

export interface ContextUsagePanelRow {
  readonly id: string;
  readonly label: string;
  readonly tokens: number;
  readonly color: string;
}

export interface ContextUsagePanelModel {
  readonly title: string;
  readonly statusLabel: string;
  readonly tokenLabel: string;
  readonly rows: readonly ContextUsagePanelRow[];
  readonly unusedRatio: number;
}

export function contextUsageCategoryLabel(id: ContextUsageCategoryId, isZh: boolean): string {
  switch (id) {
    case 'system_prompt':
      return isZh ? '系统提示' : 'System prompt';
    case 'tool_definitions':
      return isZh ? '工具定义' : 'Tool definitions';
    case 'rules':
      return isZh ? '项目规则' : 'Rules';
    case 'skills':
      return 'Skills';
    case 'mcp_tools':
      return isZh ? 'MCP 与动态工具' : 'MCP & dynamic tools';
    case 'subagents':
      return isZh ? '子代理定义' : 'Subagent definitions';
    case 'summarized_conversation':
      return isZh ? '对话摘要' : 'Summarized conversation';
    case 'conversation':
      return isZh ? '对话' : 'Conversation';
    default:
      return id;
  }
}

export function resolveContextUsagePanelModel(input: Readonly<{
  readonly percent: number | null;
  readonly usedTokens: number | null;
  readonly contextWindow: number | null | undefined;
  readonly breakdown: ContextUsageBreakdown | null | undefined;
  readonly isZh: boolean;
}>): ContextUsagePanelModel {
  const { percent, usedTokens, contextWindow, breakdown, isZh } = input;
  const rows: ContextUsagePanelRow[] = breakdown?.categories.length
    ? breakdown.categories.map((row) => ({
        id: row.id,
        label: contextUsageCategoryLabel(row.id, isZh),
        tokens: row.tokens,
        color: CONTEXT_USAGE_CATEGORY_COLORS[row.id],
      }))
    : usedTokens != null && usedTokens > 0
      ? [{
          id: 'used',
          label: isZh ? '已用上下文' : 'Used',
          tokens: usedTokens,
          color: 'var(--azure-seal)',
        }]
      : [];

  const used = usedTokens ?? breakdown?.estimatedTokens ?? 0;
  const window = typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : null;
  const unusedRatio = window == null || used <= 0
    ? (used > 0 ? 0 : 1)
    : Math.max(0, Math.min(1, (window - used) / window));

  const tokenLabel = window != null && usedTokens != null
    ? `~${formatTokenCount(usedTokens)} / ${formatTokenCount(window)}`
    : usedTokens != null
      ? `~${formatTokenCount(usedTokens)}`
      : (isZh ? '待计量' : 'Pending');

  return {
    title: isZh ? '上下文用量' : 'Context Usage',
    statusLabel: percent == null
      ? (isZh ? '待计量' : 'Pending')
      : (isZh ? `已用 ${Math.round(percent)}%` : `${Math.round(percent)}% Full`),
    tokenLabel: window != null && usedTokens != null && !isZh
      ? `${tokenLabel} Tokens`
      : tokenLabel,
    rows,
    unusedRatio,
  };
}
