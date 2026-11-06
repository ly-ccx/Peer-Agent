import { createInterface } from 'node:readline/promises';
import { stdin as input, stderr as errorOutput } from 'node:process';
import { join } from 'node:path';
import { CLI_EXIT } from './cli-exit.ts';
import { resolvePeerDataHome } from './cli-data-home.ts';

export type CliSessionsAction =
  | { readonly action: 'list' }
  | { readonly action: 'resume'; readonly id: string }
  | { readonly action: 'delete'; readonly id: string; readonly yes: boolean };

export interface CliSessionRecord {
  readonly id: string;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly role?: string;
}

export interface CliSessionStore {
  listConversations(params?: {
    readonly includeMessageCount?: boolean;
    readonly roles?: readonly string[];
  }): readonly CliSessionRecord[] | { readonly items?: readonly CliSessionRecord[] };
  readSessionMeta?(id: string): CliSessionRecord | null;
  getConversation(id: string): { readonly id: string } | null;
  deleteConversation(id: string): unknown;
}

export interface CliGoalPlanCleaner {
  deletePlanByConversation(conversationId: string): unknown;
}

const SESSION_ROLES = ['default', 'project_agent', 'work_session'] as const;

export function formatSessionList(records: readonly CliSessionRecord[]): string {
  return records.map((record) => {
    const updated = record.updatedAt?.trim() || '-';
    const title = (record.title?.trim() || 'Untitled session').replace(/[\t\r\n]+/g, ' ');
    const role = record.role === 'project_agent' || record.role === 'work_session' ? `\t${record.role}` : '';
    return `${updated}\t${record.id}\t${title}${role}`;
  }).join('\n');
}

function asRecords(value: readonly CliSessionRecord[] | { readonly items?: readonly CliSessionRecord[] }): readonly CliSessionRecord[] {
  if (Array.isArray(value)) return value;
  return (value as { readonly items?: readonly CliSessionRecord[] }).items ?? [];
}

export function findSession(store: CliSessionStore, id: string): CliSessionRecord | null {
  if (store.readSessionMeta) return store.readSessionMeta(id);
  const stored = store.getConversation(id);
  return stored ? { id: stored.id } : null;
}

export async function runPeerSessions(
  action: CliSessionsAction,
  hooks: {
    readonly env?: NodeJS.ProcessEnv;
    readonly store?: CliSessionStore;
    readonly plans?: CliGoalPlanCleaner;
    readonly stdinIsTTY?: boolean;
    readonly confirm?: (id: string) => Promise<boolean> | boolean;
    readonly stdout?: (line: string) => void;
    readonly stderr?: (line: string) => void;
  } = {},
): Promise<number> {
  const writeOut = hooks.stdout ?? ((line: string) => console.log(line));
  const writeErr = hooks.stderr ?? ((line: string) => console.error(line));
  const store = hooks.store ?? await openSessionStore(hooks.env);
  if (action.action === 'list') {
    const records = asRecords(store.listConversations({
      includeMessageCount: false,
      roles: SESSION_ROLES,
    }));
    if (records.length === 0) {
      writeErr('No sessions.');
      return CLI_EXIT.ok;
    }
    writeOut(formatSessionList(records));
    return CLI_EXIT.ok;
  }

  const existing = findSession(store, action.id);
  if (!existing) {
    writeErr(`peer sessions: session not found: ${action.id}`);
    return CLI_EXIT.runtime;
  }
  if (action.action === 'resume') return CLI_EXIT.ok;

  const tty = hooks.stdinIsTTY ?? Boolean(input.isTTY);
  if (!action.yes && !tty) {
    writeErr('peer sessions delete needs a TTY or --yes.');
    return CLI_EXIT.usage;
  }
  if (!action.yes) {
    const confirmed = hooks.confirm
      ? await hooks.confirm(action.id)
      : await confirmOnTerminal(action.id);
    if (!confirmed) {
      writeErr('Delete cancelled.');
      return CLI_EXIT.ok;
    }
  }
  store.deleteConversation(action.id);
  try {
    const plans = hooks.plans ?? await openPlanCleaner(hooks.env);
    plans.deletePlanByConversation(action.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeOut(`Deleted session ${action.id}.`);
    writeErr(`peer sessions: goal plan cleanup failed: ${message}`);
    return CLI_EXIT.runtime;
  }
  writeOut(`Deleted session ${action.id}.`);
  return CLI_EXIT.ok;
}

async function confirmOnTerminal(id: string): Promise<boolean> {
  const rl = createInterface({ input, output: errorOutput });
  try {
    const answer = (await rl.question(`Delete session ${id}? [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function sessionIsStored(
  id: string,
  hooks: { readonly env?: NodeJS.ProcessEnv; readonly store?: CliSessionStore } = {},
): Promise<boolean> {
  const store = hooks.store ?? await openSessionStore(hooks.env);
  return Boolean(findSession(store, id));
}

async function openSessionStore(env: NodeJS.ProcessEnv = process.env): Promise<CliSessionStore> {
  const { createConversationStore } = await import('@peer-agent/conversation-store');
  return createConversationStore({
    storeDir: join(resolvePeerDataHome(env), 'conversations'),
  }) as unknown as CliSessionStore;
}

async function openPlanCleaner(env: NodeJS.ProcessEnv = process.env): Promise<CliGoalPlanCleaner> {
  const { createGoalPlanStore } = await import('@peer-agent/runtime-node');
  return createGoalPlanStore({
    storeDir: join(resolvePeerDataHome(env), 'goal-plans'),
  }) as CliGoalPlanCleaner;
}
