import { createProjectInputRecovery, type ProjectInputRecovery } from '@peer-agent/runtime-core';
import { createProjectInputDraftStore } from '@peer-agent/runtime-node';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { createTuiProjectHost } from './tui-project-host.ts';
import { projectConversationCards } from './conversation-cards.ts';

type ProjectHost = ReturnType<typeof createTuiProjectHost>;
const emptySnapshot = (): ProjectSnapshot => ({ workspaceId: '', isHost: false, bots: [], messages: [], nextCursor: null,
  familiarizeOffer: null, sessions: [], approvals: [], messageState: 'loading', cardsUnavailable: false });

/** Read public projections, submit to the shared queue; never execute a client turn. */
export function createTuiProjectClient(options: {
  dataHome: string;
  host: ProjectHost;
  onChanged?: (snapshot: ProjectSnapshot) => void;
  autoStart?: boolean;
}) {
  const { host, dataHome } = options;
  const drafts = createProjectInputDraftStore({ rootDir: path.join(dataHome, 'project-runtime') });
  const recoverySessions = new Map<string, ProjectInputRecovery>();
  function recovery(workspaceId = host.workspaceId()) {
    let session = recoverySessions.get(workspaceId);
    if (!session) {
      session = createProjectInputRecovery({ workspaceId, surface: 'tui', createId: randomUUID, port: {
        read: async request => host.directory.get(request.workspaceId)?.ok ? drafts.read(request) : { ok: false, code: 'NOT_FOUND' },
        write: async request => host.directory.get(request.workspaceId)?.ok ? drafts.write(request) : { ok: false, code: 'NOT_FOUND' },
        submit: async request => {
          if (!host.directory.get(request.workspaceId)?.ok) return { ok: false, code: 'NOT_FOUND' };
          const input = host.inputs.submitInput(request);
          void host.tick().catch(() => {}); void poll(true).catch(() => {});
          return { ok: true, input };
        },
      } });
      recoverySessions.set(workspaceId, session);
    }
    return session;
  }
  let stamp = '', snapshot: ProjectSnapshot = emptySnapshot(), closed = false, generation = 0;
  let pageBefore: string | null = null;
  let pageSourceVersion: string | undefined;
  let flight: { key: string; source: string; promise: Promise<ProjectSnapshot> } | null = null;
  function conversationVersion(workspaceId: string) {
    try { const id = host.directory.conversationId(workspaceId), s = statSync(path.join(dataHome, 'conversations', id + '.jsonl'), { bigint: true });
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch { return 'missing'; }
  }
  function fingerprint() {
    const parts = [host.workspaceId(), String(host.holdsLease(host.workspaceId())), pageBefore ?? ''];
    const inspect = (file: string, depth: number) => {
      try {
        const info = statSync(file);
        parts.push(`${file}:${info.mtimeMs}:${info.size}`);
        if (info.isDirectory() && depth > 0) for (const name of readdirSync(file).sort()) inspect(path.join(file, name), depth - 1);
      } catch { parts.push(`${file}:missing`); }
    };
    for (const name of ['projects', 'conversations', 'project-runtime', 'memory', 'goal-plans'])
      inspect(path.join(dataHome, name), name === 'projects' || name === 'project-runtime' ? 2 : 1);
    return parts.join('|');
  }
  async function poll(force = false): Promise<ProjectSnapshot> {
    const next = fingerprint(), workspaceId = host.workspaceId(), before = pageBefore;
    if (!force && next === stamp && (!pageSourceVersion || pageSourceVersion === conversationVersion(workspaceId))) return snapshot;
    const key = `${workspaceId}:${before ?? ''}`;
    if (flight?.key === key) {
      const active = flight, changed = next !== active.source;
      return active.promise.then(result => {
        if (!force || !changed) return result;
        if (flight === active) flight = null;
        return poll(true);
      });
    }
    const ticket = ++generation;
    const promise = (async () => {
      let conversation: any, unavailable = false, cardsUnavailable = false;
      try { conversation = workspaceId ? await host.directory.readInteractions(workspaceId, { limit: 50, before } as never) : null; }
      catch { unavailable = true; }
      if (conversation && !conversation.ok) unavailable = true;
      let messages = conversation?.ok ? conversation.messages : snapshot.workspaceId === workspaceId ? snapshot.messages : [];
      if (workspaceId) {
        try {
          const cards = host.directory.readConversation(workspaceId, { view: 'cards' } as never) as any;
          if (cards.ok) {
            messages = projectConversationCards(messages, cards.cards ?? []);
          } else cardsUnavailable = true;
        } catch { cardsUnavailable = true; }
      }
      const optional = <T,>(read: () => T, fallback: T): T => { try { return read(); } catch { cardsUnavailable = true; return fallback; } };
      const bots = optional(() => host.directory.list(), snapshot.bots);
      const sessions = workspaceId ? optional(() => host.directory.listSessions(workspaceId), snapshot.workspaceId === workspaceId ? snapshot.sessions : []) : [];
      const approvals = workspaceId ? optional(() => host.approvals.list({ workspaceId }).filter(row => ['open', 'stale'].includes(row.state)), []) : [];
      const result: ProjectSnapshot = {
        workspaceId, isHost: host.holdsLease(workspaceId), bots, messages,
        nextCursor: conversation?.ok ? conversation.nextCursor : snapshot.workspaceId === workspaceId ? snapshot.nextCursor : null,
        familiarizeOffer: conversation?.ok ? conversation.familiarizeOffer ?? null : null,
        sessions, approvals,
        messageState: unavailable ? 'unavailable' : 'ready', cardsUnavailable,
      };
      if (closed || ticket !== generation) return snapshot;
      recoverySessions.get(workspaceId)?.observeReceived(messages.filter((row: any) => row.kind === 'user_input').flatMap((row: any) => typeof row.inputId === 'string' ? [row.inputId] : row.id?.startsWith('input-') ? [row.id.slice(6)] : []));
      pageSourceVersion = conversation?.ok ? conversation.sourceVersion : undefined;
      stamp = fingerprint();
      if (JSON.stringify(snapshot) === JSON.stringify(result)) return snapshot;
      snapshot = result;
      options.onChanged?.(snapshot); return snapshot;
    })();
    flight = { key, source: next, promise };
    try { return await promise; } finally { if (flight?.promise === promise) flight = null; }
  }
  const timer = options.autoStart === false ? null : setInterval(() => { void poll().catch(() => {}); }, 1000);
  timer?.unref();
  return {
    poll, recovery, current: () => snapshot,
    latest() { pageBefore = null; return poll(true); },
    earlier() { if (snapshot.nextCursor) pageBefore = snapshot.nextCursor; return poll(true); },
    async select(workspaceId: string) { pageBefore = null; await host.selectWorkspace(workspaceId); return poll(true); },
    submit(text: string, input: { inputId?: string; answerTo?: string } = {}) {
      const workspaceId = host.workspaceId();
      if (!workspaceId || !text.trim()) throw new Error('project_input_required');
      const receipt = host.inputs.submitInput({ workspaceId, inputId: input.inputId ?? randomUUID(), text,
        surface: 'tui', ...(input.answerTo ? { answerTo: input.answerTo } : {}) });
      void host.tick().catch(() => {}); void poll(true).catch(() => {}); return receipt;
    },
    async decide(approvalId: string, decision: 'approve' | 'deny' | 'cancel', duration: 'once'|'task' = 'once') {
      if (!host.holdsLease(host.workspaceId())) return { ok: false, error: 'desktop_approval_required' };
      const result = await host.decideApproval(approvalId, decision, duration); await poll(true); return result;
    },
    close() { for (const session of recoverySessions.values()) void session.flush(); closed = true; generation++; if (timer) clearInterval(timer); },
  };
}

export interface ProjectSnapshot {
  workspaceId: string;
  isHost: boolean;
  bots: any[];
  messages: any[];
  nextCursor: string | null;
  familiarizeOffer: { text: string } | null;
  sessions: any[];
  approvals: any[];
  messageState: 'loading' | 'ready' | 'unavailable';
  cardsUnavailable: boolean;
}
