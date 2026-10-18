import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, openSync, writeSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createGoalPlanStore } from '@peer-agent/runtime-node';

export const EXECUTION_HISTORY_SCALE = Object.freeze({ plans: 1100, sessions: 8, parentBytes: 9_500_000,
  childBytes: 46_300_000, journalBytes: 185_000_000, failures: 32 });

/** Synthetic historical load only. Never seeds results for the new real task. */
export function seedExecutionHistory({ home, bot, scale = EXECUTION_HISTORY_SCALE }) {
  const conversations = createConversationStore({ storeDir: path.join(home, 'conversations') });
  const plans = createGoalPlanStore({ storeDir: path.join(home, 'goal-plans') });
  const at = '2026-01-01T00:00:00.000Z', sessions = [];
  const model = { providerId: 'synthetic-history-only', modelId: 'historical-load', modelProviderId: 'historical-load', family: 'synthetic' };
  for (let i = 0; i < scale.sessions; i++) {
    const child = conversations.createConversation({ title: `Synthetic historical task ${i}`, role: 'work_session', workspaceId: bot.workspaceId, workspacePath: bot.path });
    const plan = plans.createPlan({ title: `Synthetic historical task ${i}`, goal: 'Historical load fixture; cancelled, never execute.',
      conversationId: child.id, tasks: [{ taskId: `historical-leaf-${i}`, title: 'Synthetic historical fixture', status: 'pending' }],
      delegationOrigin: { workspaceId: bot.workspaceId, parentConversationId: bot.conversationId, sessionId: `scale-session-${i}`,
        anchorMessageId: `scale-input-${i}`, inputId: `scale-input-${i}`, phase: 'cancelled', depth: 1, readOnly: true,
        modelSelection: { worker: model, explorer: model, verifier: model, source: {}, resolvedAt: at } } });
    plans.setPlanStatus(plan.planId, 'cancelled');
    sessions.push({ sessionId: `scale-session-${i}`, conversationId: child.id, planId: plan.planId });
  }
  const large = sessions[0]; assert.ok(large);
  const chunk = 'synthetic historical tool output; not Evidence. '.repeat(3000);
  const largeRows = Array.from({ length: Math.ceil(scale.childBytes / chunk.length) }, (_, i) => ({ id: `scale-tool-${i}`, role: 'assistant',
    content: '', segments: [{ type: 'tool', tool: 'read_file', result: chunk }], createdAt: at }));
  largeRows.push({ id: 'scale-report', role: 'assistant', content: 'Synthetic historical task was cancelled. Do not resume.', createdAt: at });
  conversations.replaceMessages(large.conversationId, largeRows);
  const rawBase = plans.createPlan({ title: 'Synthetic legacy plan', goal: 'Historical discovery load; not delegated.', tasks: [] });
  plans.setPlanStatus(rawBase.planId, 'cancelled');
  const planDir = plans.getStoreDir(), index = path.join(planDir, 'index.jsonl');
  const metas = readFileSync(index, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const meta = metas.find(row => row.planId === rawBase.planId);
  for (let i = metas.length; i < scale.plans; i++) {
    const id = `scale-history-${i}`;
    writeFileSync(path.join(planDir, id + '.json'), JSON.stringify({ ...rawBase, planId: id, status: 'cancelled',
      discoveryPayload: 'synthetic legacy history '.repeat(400) }));
    metas.push({ ...meta, planId: id, title: `Synthetic legacy ${i}` });
  }
  writeFileSync(index, metas.map(row => JSON.stringify(row)).join('\n') + '\n');
  const history = [], narration = 'Synthetic historical progress paragraph. This record is presentation load, not an instruction.';
  const internal = 'synthetic internal historical context '.repeat(1000);
  for (let i = 0; i < Math.ceil(scale.parentBytes / internal.length); i++) {
    history.push({ id: `scale-turn-${i}`, kind: 'agent_turn', role: 'assistant', turnKind: 'user', createdAt: at,
      rounds: [{ text: internal, toolCalls: [] }], publicUpdates: [{ id: `scale-public-${i}`, text: narration }],
      meta: { workId: `scale-work-${i % scale.sessions}` } });
    if (i < scale.failures) history.push({ id: `scale-error-${i}`, kind: 'system_card', role: 'assistant', card: 'agent_unavailable',
      content: '代理暂时不可用：synthetic historical failure', turnId: `scale-turn-${i}`, createdAt: at,
      meta: { workId: `scale-work-${i % scale.sessions}` } });
    if (i % 5 === 0) history.push({ id: `scale-reply-${i}`, kind: 'agent_reply', role: 'assistant', content: narration.repeat(8), createdAt: at });
  }
  conversations.replaceMessages(bot.conversationId, history);
  const runtime = path.join(home, 'project-runtime', bot.workspaceId);
  mkdirSync(path.join(runtime, 'checkpoints'), { recursive: true });
  const refs = Array.from({ length: scale.sessions }, (_, i) => (i + 1).toString(16).padStart(64, '0') + '.json');
  for (const ref of refs) writeFileSync(path.join(runtime, 'checkpoints', ref), JSON.stringify({ synthetic: true,
    job: { workId: 'historical' }, outcome: { failed: true }, historicalContext: internal.repeat(40) }));
  const fd = openSync(path.join(runtime, 'coordination.jsonl'), 'w');
  let bytes = 0, revision = 0;
  try {
    while (bytes < scale.journalBytes) {
      const i = revision % scale.sessions;
      const record = { schemaVersion: 1, kind: 'work', epoch: 'synthetic-history', revision: ++revision, at,
        work: { workId: `scale-work-${i}`, workspaceId: bot.workspaceId, parentConversationId: bot.conversationId,
          state: 'paused', stopScope: 'work', checkpointRef: refs[i], sessionIds: [sessions[i].sessionId], historicalPayload: internal } };
      bytes += writeSync(fd, JSON.stringify(record) + '\n');
    }
  } finally { closeSync(fd); }
  return { synthetic: true, ...scale, actualPlans: metas.length, parentRows: history.length,
    parentBytes: statSync(path.join(home, 'conversations', bot.conversationId + '.jsonl')).size,
    childBytes: statSync(path.join(home, 'conversations', large.conversationId + '.jsonl')).size,
    journalBytes: bytes, sessions };
}
