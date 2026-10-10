import type { BotToolRound } from '../state/botConversationState';
import { toolActivityPreview, toolActivitySummary, type ProjectAgentToolPreview, type ProjectAgentEvidenceReadResult } from '@peer-agent/protocol';
import type { TranslationKey } from '@peer-agent/i18n';
import type { PeerIconName } from '../../ui/icons';

export interface AgentProcessEntry {
  readonly name: string;
  readonly input: string;
  readonly result: string;
  readonly inputPreview: ProjectAgentToolPreview;
  readonly resultPreview: ProjectAgentToolPreview;
  readonly labelKey: TranslationKey;
  readonly icon: PeerIconName;
  readonly status: 'done' | 'failed' | 'cancelled' | 'suppressed' | 'unknown';
  readonly summary: string;
  readonly count?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface BotEvidenceInspect extends ProjectAgentEvidenceReadResult {
  readonly ok: boolean;
  readonly evidenceRef: string;
  readonly kind: NonNullable<ProjectAgentEvidenceReadResult['kind']>;
  readonly summary: string;
  readonly truncated: boolean;
  readonly code: string;
}

/** 档案里打开的证据摘要，或某条回复对应的只读过程。 */
export interface BotInspect {
  readonly replyId?: string;
  readonly evidence: BotEvidenceInspect | null;
  readonly rounds: readonly BotToolRound[] | null;
}

/** 把一轮代理回合收成只读条目。没有执行入口。 */
export function agentProcessEntries(rounds: readonly BotToolRound[]): AgentProcessEntry[] {
  const entries: AgentProcessEntry[] = [];
  let previewChars = 0;
  const preview = (value: unknown, limit: number) => {
    const projected = toolActivityPreview(value, Math.max(0, Math.min(limit, 32000 - previewChars)));
    previewChars += projected.text.length;
    return projected;
  };
  for (const round of rounds) {
    for (const call of round.toolCalls) {
      if (entries.length >= 100) return entries;
      const inputPreview = preview(call.input ?? null, 2000);
      const resultPreview = preview(call.result ?? null, 4000);
      entries.push({
        name: call.name,
        ...toolPresentation(call.name),
        status: resultStatus(call.result),
        summary: call.name === 'post_reply' ? '' : toolActivitySummary(call.input),
        ...countOf(call.name, call.result),
        input: inputPreview.text, result: resultPreview.text, inputPreview, resultPreview,
        ...(call.startedAtMs !== undefined ? { startedAt: new Date(call.startedAtMs).toISOString() } : {}),
        ...(call.endedAtMs !== undefined ? { finishedAt: new Date(call.endedAtMs).toISOString() } : {}),
      });
    }
  }
  return entries;
}

const LABELS = {
  post_reply: ['reply', 'send'], list_sessions: ['sessions', 'fileText'], get_session: ['session', 'fileText'],
  spawn_session: ['start', 'plus'], resume_session: ['resume', 'arrowUpRight'], cancel_session: ['cancel', 'stop'],
  message_session: ['update', 'send'], reprioritize_session: ['update', 'arrowUpRight'], set_proactivity: ['update', 'info'],
  get_verification_detail: ['verification', 'fileText'], verify_session: ['verification', 'fileText'],
  memory_search: ['memory', 'fileText'], memory_remember: ['memory', 'fileText'], memory_forget: ['memory', 'fileText'],
  create_objective: ['objective', 'plus'], update_objective: ['objective', 'fileText'], pause_objective: ['objective', 'stop'],
  resume_objective: ['objective', 'arrowUpRight'], list_objectives: ['objective', 'fileText'], get_objective: ['objective', 'fileText'], close_objective: ['objective', 'fileText'],
} as const;

/** One vocabulary for live activity and the historical process drawer. */
export function toolPresentation(name: string): { labelKey: TranslationKey; icon: PeerIconName } {
  if (Object.hasOwn(LABELS, name)) {
    const [label, icon] = LABELS[name as keyof typeof LABELS];
    return { labelKey: `projectAgent.process.${label}`, icon };
  }
  if (/^(read_file|read_files|list_directory)$/.test(name)) return { labelKey: 'projectAgent.chat.toolLabel.read', icon: 'fileText' };
  if (/^(search_files|search_text|search|rg)$/.test(name)) return { labelKey: 'projectAgent.chat.toolLabel.search', icon: 'fileText' };
  if (/^(write_file|edit_file|apply_patch)$/.test(name)) return { labelKey: 'projectAgent.chat.toolLabel.edit', icon: 'fileText' };
  if (/^(bash|run_command|exec_command|shell)$/.test(name)) return { labelKey: 'projectAgent.chat.toolLabel.command', icon: 'terminal' };
  return { labelKey: 'projectAgent.process.tool', icon: 'terminal' };
}

function piles(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6) return [];
  if (typeof value === 'string') { try { return piles(JSON.parse(value), depth + 1); } catch { return []; } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const row = value as Record<string, unknown>;
  const preview = row.outputPreview as Record<string, unknown> | undefined;
  return [row, ...piles(row.output ?? preview?.legacyResult ?? row.legacyResult, depth + 1)];
}

function resultStatus(result: unknown): AgentProcessEntry['status'] {
  const rows = piles(result);
  if (rows.some(row => row.ok === false || row.success === false || row.error || ['failed', 'denied'].includes(String(row.status)))) return 'failed';
  if (rows.some(row => ['cancelled', 'aborted'].includes(String(row.status)))) return 'cancelled';
  if (rows.some(row => row.suppressed === true || ['silent', 'digest'].includes(String(row.surfacing ?? (row.meta as Record<string, unknown> | undefined)?.surfacing)))) return 'suppressed';
  return rows.some(row => row.ok === true || row.success === true) ? 'done' : 'unknown';
}

const STEP_LABELS = ['preparing', 'running', 'done', 'failed', 'cancelled', 'suppressed', 'unknown', 'stopped'] as const;
export type ToolStepLabel = (typeof STEP_LABELS)[number];

function stepLabel(status: string): ToolStepLabel {
  return (STEP_LABELS as readonly string[]).includes(status) ? status as ToolStepLabel : 'unknown';
}

/** Step label for a tool card. A missing result is not a failed payload. */
export function toolStepStatus(
  status: string,
  result: { readonly text?: string; readonly truncated?: boolean } | null | undefined,
  outcome?: 'stopped' | 'error',
): ToolStepLabel {
  const absent = !result?.text && result?.truncated !== true;
  // Task cancel aborts the turn as a failure before tool-result. That is not a failed read.
  if (absent && (status === 'error' || (status === 'unknown' && outcome === 'error'))) return 'cancelled';
  if (status === 'error') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'unknown' && outcome) return outcome === 'stopped' ? 'stopped' : 'failed';
  return stepLabel(status);
}

/** Empty non-truncated previews are missing results, not "content over the limit" and not the word null. */
export function toolPreviewText(
  preview: { readonly text?: string; readonly truncated?: boolean } | null | undefined,
  labels: { readonly empty: string; readonly limit: string },
): string | null {
  if (!preview) return null;
  if (preview.text) return preview.text;
  return preview.truncated ? labels.limit : labels.empty;
}

function countOf(name: string, result: unknown): { count?: number } {
  if (name !== 'list_sessions') return {};
  for (const row of piles(result)) {
    const items = row.sessions ?? row.items;
    if (Array.isArray(items)) return { count: items.length };
  }
  return {};
}
