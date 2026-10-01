import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { createTuiProjectHost } from './tui-project-host.ts';

type ProjectHost = ReturnType<typeof createTuiProjectHost>;

/** Read durable projections, submit to the shared queue; never execute a client turn. */
export function createTuiProjectClient(options: {
  dataHome: string;
  host: ProjectHost;
  onChanged?: (snapshot: ProjectSnapshot) => void;
  autoStart?: boolean;
}) {
  const { host, dataHome } = options;
  let stamp = '', snapshot: ProjectSnapshot | null = null;
  function fingerprint() {
    const parts = [host.workspaceId(), String(host.holdsLease(host.workspaceId()))];
    const inspect = (file: string, depth: number) => {
      try {
        const info = statSync(file);
        parts.push(`${file}:${info.mtimeMs}:${info.size}`);
        if (info.isDirectory() && depth > 0) {
          for (const name of readdirSync(file).sort()) inspect(path.join(file, name), depth - 1);
        }
      } catch { parts.push(`${file}:missing`); }
    };
    // Stat only. Secret and artifact bodies never enter a surface projection.
    for (const name of ['projects', 'conversations', 'project-runtime', 'memory', 'goal-plans']) {
      inspect(path.join(dataHome, name), name === 'projects' || name === 'project-runtime' ? 2 : 1);
    }
    return parts.join('|');
  }
  function poll(force = false) {
    const next = fingerprint();
    if (!force && next === stamp && snapshot) return snapshot;
    stamp = next;
    const workspaceId = host.workspaceId();
    const conversation = workspaceId ? host.directory.readConversation(workspaceId, { limit: 50 }) : null;
    snapshot = {
      workspaceId, isHost: host.holdsLease(workspaceId), bots: host.directory.list(),
      messages: conversation?.ok && 'messages' in conversation ? conversation.messages : [],
      nextCursor: conversation?.ok && 'nextCursor' in conversation ? conversation.nextCursor : null,
      sessions: workspaceId ? host.directory.listSessions(workspaceId) : [],
      approvals: workspaceId ? host.approvals.list({ workspaceId }).filter(row => ['open', 'stale'].includes(row.state)) : [],
    };
    options.onChanged?.(snapshot);
    return snapshot;
  }
  const timer = options.autoStart === false ? null : setInterval(() => poll(), 1000);
  timer?.unref();
  return {
    poll,
    submit(text: string, input: { inputId?: string; answerTo?: string } = {}) {
      const workspaceId = host.workspaceId();
      if (!workspaceId || !text.trim()) throw new Error('project_input_required');
      const receipt = host.inputs.submitInput({ workspaceId, inputId: input.inputId ?? randomUUID(), text,
        surface: 'tui', ...(input.answerTo ? { answerTo: input.answerTo } : {}) });
      void host.tick().catch(() => {});
      poll(true);
      return receipt;
    },
    async decide(approvalId: string, decision: 'approve' | 'deny') {
      if (!host.holdsLease(host.workspaceId())) return { ok: false, error: 'desktop_approval_required' };
      const result = await host.decideApproval(approvalId, decision);
      poll(true);
      return result;
    },
    close() { if (timer) clearInterval(timer); },
  };
}

export interface ProjectSnapshot {
  workspaceId: string;
  isHost: boolean;
  bots: any[];
  messages: any[];
  nextCursor: string | null;
  sessions: any[];
  approvals: any[];
}
