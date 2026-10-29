export interface QuickChatBotChoice {
  readonly workspaceId: string;
  readonly name: string;
  readonly lastActiveAt: string;
}

export function quickChatShell(settings: { projectAgent?: { shell?: string } } | null | undefined): 'classic' | 'bots' {
  return settings?.projectAgent?.shell === 'classic' ? 'classic' : 'bots';
}

export function pickQuickChatBot<T extends { workspaceId: string; lastActiveAt?: string }>(bots: readonly T[]): T | null {
  const list = bots.filter((bot) => typeof bot?.workspaceId === 'string' && bot.workspaceId);
  return [...list].sort((left, right) => String(right.lastActiveAt || '').localeCompare(String(left.lastActiveAt || '')))[0] ?? null;
}

export function quickChatSubmission(input: {
  shell: 'classic';
  workspaceId: string;
  text: string;
}): { mode: 'classic'; text: string };
export function quickChatSubmission(input: {
  shell: 'bots';
  workspaceId: string;
  text: string;
}): { mode: 'bots'; ok: false; code: 'INVALID_INPUT' } | {
  mode: 'bots';
  ok: true;
  workspaceId: string;
  text: string;
  surface: 'quick_chat';
};
export function quickChatSubmission(input: {
  shell: 'classic' | 'bots';
  workspaceId: string;
  text: string;
}): { mode: 'classic'; text: string } | { mode: 'bots'; ok: false; code: 'INVALID_INPUT' } | {
  mode: 'bots';
  ok: true;
  workspaceId: string;
  text: string;
  surface: 'quick_chat';
} {
  const body = input.text.trim();
  if (input.shell === 'classic') return { mode: 'classic', text: body };
  if (!input.workspaceId || !body) return { mode: 'bots', ok: false, code: 'INVALID_INPUT' };
  return { mode: 'bots', ok: true, workspaceId: input.workspaceId, text: body, surface: 'quick_chat' };
}
