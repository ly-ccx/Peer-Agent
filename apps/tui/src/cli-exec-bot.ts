import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseInteractiveArtifactRef, type InteractiveOwner } from '@peer-agent/protocol';
import { createInteractiveTextReader } from '@peer-agent/runtime-node/interactive-results';
import { inputMessageId } from '@peer-agent/runtime-node/project-agent';
import { CLI_EXIT, type CliExitCode } from './cli-exit.ts';
import { encodeExecJson, type ExecInteractiveResult, type ExecJsonResult } from './cli-output.ts';
import type { PersistedConversationHistory } from '@peer-agent/conversation-store';
import type { RunPeerExecIo } from './cli-exec.ts';
import { terminalText } from './project-agent/commands.ts';
import { createTuiProjectHost } from './project-agent/tui-project-host.ts';

export async function runPeerBotExec(options: {
  dataHome: string; workspaceRoot: string; prompt: string; inputId?: string; waitMs: number;
  outputFormat: 'json' | 'text'; startedAt: number;
}, io: RunPeerExecIo): Promise<CliExitCode> {
  const host = createTuiProjectHost({ dataHome: options.dataHome, workspacePath: options.workspaceRoot, autoStart: false });
  const workspaceId = host.workspaceId(), initial = host.profiles.read(workspaceId);
  const inputId = options.inputId ?? randomUUID(), messageId = inputMessageId(inputId);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  let receipt: ExecJsonResult['botInput'];
  let result: string | null = null, error: string | null = null;
  let interactiveResults: ExecInteractiveResult[] = [], code: CliExitCode = CLI_EXIT.runtime;
  const current = () => {
    const profile = host.profiles.read(workspaceId);
    return profile?.status === 'active' && profile.agentConversationId === initial?.agentConversationId;
  };
  try {
    if (!initial || !current()) { error = 'bot_not_bound'; code = CLI_EXIT.usage; }
    else {
      receipt = { inputId, status: 'unknown' };
      const saved = host.inputs.submitInput({ workspaceId, surface: 'tui', text: options.prompt, inputId });
      if (saved.workspaceId !== workspaceId || saved.inputId !== inputId || saved.surface !== 'tui' || saved.text !== options.prompt)
        throw Error('bot_input_conflict');
      receipt = { inputId, status: 'received' };
      const readResult = createInteractiveTextReader({ resultStore: host.interactive.resultStore,
        assertOwner: (owner: InteractiveOwner) => current() && owner.workspaceId === workspaceId && owner.conversationId === initial.agentConversationId });
      const selectReply = (history: PersistedConversationHistory) => history.messages.find(message =>
        message.role === 'assistant' && message.kind === 'agent_reply' && Array.isArray(message.replyTo) && message.replyTo.includes(messageId)) ?? null;
      const projectReply = host.conversations.createHistoryProjection?.(selectReply);
      const deadline = performance.now() + options.waitMs;
      while (current() && !controller.signal.aborted) {
        const reply = projectReply?.(initial.agentConversationId);
        if (reply && typeof reply.id === 'string') {
          if (!current()) break;
          receipt = { inputId, status: 'replied', replyId: reply.id };
          result = terminalText(reply.content) || null;
          const refs = (reply.meta as { evidenceRefs?: unknown } | undefined)?.evidenceRefs;
          if (Array.isArray(refs)) for (const ref of [...new Set(refs)].slice(0, 20)) {
            const reference = parseInteractiveArtifactRef(ref);
            if (!reference) continue;
            try {
              const summary = readResult(reference);
              interactiveResults.push({ ...summary, title: terminalText(summary.title), textFallback: terminalText(summary.textFallback) });
            } catch { /* An unavailable fixed result cannot be reconstructed from the reply. */ }
          }
          code = CLI_EXIT.ok;
          break;
        }
        if (performance.now() >= deadline) break;
        void host.tick().catch(() => {});
        await delay(Math.min(250, Math.max(1, deadline - performance.now())), undefined, { signal: controller.signal })
          .catch(error => { if (error?.name !== 'AbortError') throw error; });
      }
      if (!current()) { result = null; interactiveResults = []; error = 'bot_owner_changed'; code = CLI_EXIT.auth; }
      else if (code !== CLI_EXIT.ok) {
        error = controller.signal.aborted ? 'bot_wait_cancelled' : 'bot_reply_pending';
        code = controller.signal.aborted ? CLI_EXIT.cancelled : CLI_EXIT.botReplyPending;
      }
    }
  } catch (failure) {
    error = failure instanceof Error && failure.message === 'bot_input_conflict' ? failure.message : 'bot_exec_unavailable';
  } finally {
    process.removeListener('SIGINT', interrupt);
    await host.close().catch(() => {});
  }
  if (receipt?.status === 'replied' && !current()) {
    result = null; interactiveResults = []; error = 'bot_owner_changed'; code = CLI_EXIT.auth;
  }
  if (options.outputFormat === 'json') {
    io.stdout.write(encodeExecJson({ sessionId: initial?.agentConversationId ?? '', ok: code === CLI_EXIT.ok,
      result, error, turns: 0, durationMs: Date.now() - options.startedAt, botInput: receipt, interactiveResults }) + '\n');
  } else {
    if (result) io.stdout.write(result + '\n');
    for (const item of interactiveResults) {
      io.stdout.write(`\n${item.title}\n${item.ref}\nAvailability: ${item.availability}\nSaved model summary, unverified${item.truncated ? ' (truncated)' : ''}\n${item.textFallback}\n`);
    }
    if (error) io.stderr.write(`peer exec: ${error}${receipt ? ` (input ${receipt.inputId}, ${receipt.status})` : ''}\n`);
  }
  return code;
}
