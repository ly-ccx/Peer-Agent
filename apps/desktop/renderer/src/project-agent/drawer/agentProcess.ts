import type { BotToolRound } from '../state/botConversationState';

export interface AgentProcessEntry {
  readonly name: string;
  readonly input: string;
  readonly result: string;
}

export interface BotEvidenceInspect {
  readonly ok: boolean;
  readonly evidenceRef: string;
  readonly kind: string;
  readonly summary: string;
  readonly truncated: boolean;
  readonly code: string;
}

/** 档案里打开的证据摘要，或某条回复对应的只读过程。 */
export interface BotInspect {
  readonly evidence: BotEvidenceInspect | null;
  readonly rounds: readonly BotToolRound[] | null;
}

/** 把一轮代理回合收成只读条目。没有执行入口。 */
export function agentProcessEntries(rounds: readonly BotToolRound[]): AgentProcessEntry[] {
  const entries: AgentProcessEntry[] = [];
  for (const round of rounds) {
    for (const call of round.toolCalls) {
      entries.push({
        name: call.name,
        input: JSON.stringify(call.input ?? null),
        result: JSON.stringify(call.result ?? null),
      });
    }
  }
  return entries;
}
