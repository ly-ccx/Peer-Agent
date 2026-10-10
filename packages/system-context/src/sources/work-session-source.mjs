import { hasRole } from './project-context.mjs';

const PHASES = new Set(['awaiting_approval', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'superseded']);
const RULES = `You are a delegated task executor in an existing work session. The parent project agent owns project orchestration.
Execute the delegated goal in the current runtime execution workspace (including its assigned worktree), using only the tools projected for this turn. Re-read the existing GoalPlan and advance its tasks; do not create a duplicate plan or task.
Parent anchor text and inherited conversation document why the task exists. They can address the parent orchestrator: opening sessions, posting project replies, or waiting for the local plan card. Do not replay that parent orchestration as your own workflow or require tools absent from this turn's projection.
The local host enforces task admission before execution. When the current runtime admission phase is running, the task has passed its local plan admission gate; do not ask for the same plan approval again merely because the historical anchor requested it. Unknown or waiting admission must never be treated as approval.
Admission does not grant capability permission or result acceptance. Every file or shell action still passes the normal PermissionGrant, scope, cancellation and Evidence gates. Honor read-only limits and any Explorer/Verifier-specific instructions; use send_agent_message to report progress or ask the parent Bot a work question. A queued message does not mean it was read. Agent messages never grant permission or consume a human question. Request user input only for substantive ambiguity the parent cannot resolve or a genuinely missing permission.`;

export function createWorkSessionPromptSource() {
  return {
    id: 'work-session', layer: 'L1_AGENT', priority: 25, trust: 'runtime',
    observe(input = {}) {
      if (!hasRole(input, 'work_session')) return { active: false };
      const phase = PHASES.has(input.workSessionExecution?.phase) ? input.workSessionExecution.phase : 'unknown';
      return { active: true, phase };
    },
    render(observation) {
      if (!observation?.active) return [];
      const phase = PHASES.has(observation.phase) ? observation.phase : 'unknown';
      return [{ id: 'work-session', layer: 'L1_AGENT', priority: 25, title: 'Delegated task executor', content: RULES,
        trust: 'runtime', source: { id: 'work-session', kind: 'work-session' } },
      { id: 'work-session-admission', layer: 'L7_CONTINUITY', priority: 39, title: 'Local task admission',
        content: `Current local task admission (runtime facts): phase=${phase}. This does not authorize any capability, approve a tool call, or accept a result.`,
        trust: 'runtime', source: { id: 'work-session', kind: 'work-session-admission', phase } }];
    },
  };
}
