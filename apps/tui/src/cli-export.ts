import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLI_EXIT } from './cli-exit.ts';
import { resolvePeerDataHome } from './cli-data-home.ts';

export interface CliExportSession {
  readonly id: string;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly messages?: readonly Record<string, unknown>[];
}

const SECRET = /(?:\bsk-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+/-]+=*|\bya29\.[A-Za-z0-9._-]+)/gi;

export function redactExportedText(value: string): string {
  return value.replace(SECRET, '[redacted]');
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      if (record.type && record.type !== 'text') return '';
      return typeof record.text === 'string' ? record.text : typeof record.content === 'string' ? record.content : '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  return '';
}

export function visibleSessionText(message: Record<string, unknown>): string | null {
  const role = message.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const text = textFromContent(message.content).trim();
  if (!text) return null;
  return redactExportedText(text);
}

export function formatSessionMarkdown(session: CliExportSession): string {
  const title = session.title?.trim() || 'Untitled session';
  const lines = [`# ${title.replace(/\r?\n/g, ' ')}`, '', `session: ${session.id}`];
  if (session.updatedAt) lines.push(`updated: ${session.updatedAt}`);
  lines.push('');
  for (const message of session.messages ?? []) {
    const text = visibleSessionText(message);
    if (!text) continue;
    lines.push(`## ${message.role}`, '', text, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function runPeerExport(
  options: { readonly sessionId: string; readonly outputPath?: string; readonly force: boolean },
  hooks: {
    readonly env?: NodeJS.ProcessEnv;
    readonly readSession?: (id: string) => CliExportSession | null;
    readonly stdout?: (line: string) => void;
    readonly stderr?: (line: string) => void;
  } = {},
): Promise<number> {
  const writeErr = hooks.stderr ?? ((line: string) => console.error(line));
  const session = hooks.readSession
    ? hooks.readSession(options.sessionId)
    : await readStoredSession(options.sessionId, hooks.env);
  if (!session) {
    writeErr(`peer export: session not found: ${options.sessionId}`);
    return CLI_EXIT.runtime;
  }
  const markdown = formatSessionMarkdown(session);
  if (!options.outputPath) {
    (hooks.stdout ?? ((line: string) => console.log(line)))(markdown.replace(/\n$/, ''));
    return CLI_EXIT.ok;
  }
  try {
    mkdirSync(dirname(options.outputPath), { recursive: true });
    writeFileSync(options.outputPath, markdown, { encoding: 'utf8', flag: options.force ? 'w' : 'wx' });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'EEXIST') {
      writeErr(`peer export: ${options.outputPath} already exists. Pass --force to overwrite.`);
      return CLI_EXIT.usage;
    }
    const message = error instanceof Error ? error.message : String(error);
    writeErr(`peer export: ${message}`);
    return CLI_EXIT.runtime;
  }
  (hooks.stdout ?? ((line: string) => console.log(line)))(`Exported ${session.id} to ${options.outputPath}`);
  return CLI_EXIT.ok;
}

async function readStoredSession(id: string, env: NodeJS.ProcessEnv = process.env): Promise<CliExportSession | null> {
  const { createConversationStore } = await import('@peer-agent/conversation-store');
  const store = createConversationStore({ storeDir: join(resolvePeerDataHome(env), 'conversations') });
  const stored = store.getConversation(id);
  if (!stored) return null;
  return {
    id: stored.id,
    title: typeof stored.title === 'string' ? stored.title : undefined,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : undefined,
    messages: Array.isArray(stored.messages) ? stored.messages as Record<string, unknown>[] : [],
  };
}
