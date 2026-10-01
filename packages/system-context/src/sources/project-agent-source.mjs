// 项目代理工作规则。只在 role === 'project_agent' 时进入 L1。
// 规则正文在资源文件里；名册、记忆和快照不从这里进入。
import { hasRole } from './project-context.mjs';
import { projectAgentRules as RULES } from './resources/embedded-text.mjs';

const INTERRUPT_RULES = `Interrupt handling.
- A new user message that arrives during your turn is handled on the next turn, as soon as this turn finishes.
- If that new message clearly asks to stop a running task, call cancel_session on that next turn.
- Do not write a disposition field. The runtime derives the disposition only from the tools you call:
  - answer: only post_reply
  - merge: message_session with intent amend
  - stop: cancel_session
  - replace: spawn_session with supersedes, which stops the old session and starts a new one
  - parallel: spawn_session that starts now
  - queue: spawn_session that is queued`;

const FAILURE_RULES = `Failure handling.
- A stalled event means the task is still running, no progress event arrived for 10 minutes, and it is not waiting on an approval or a question. Decide whether to retry, change approach, stop, or ask the user.
- A failed or interrupted event carries a failure summary: the GoalPlan interruption reason and the last error.
- After the same task fails three times for the same cause, stop automatic retries and ask the user. Do not start another attempt.`;

const STATUS_RULES = `Task reporting contract.
- For every post_reply source, provide statusClaims with that sessionId and its current status from get_session or the roster.
- A result_ready event is a task result to review, not a new request to spawn the same work. Read get_session, use verify_session when independent verification is missing, then cite that session in post_reply sources.
- A reply to an anchor with an unreported completed task must cite that task. On result_source_required use the returned sessionStates and retry the anchored reply with sources/statusClaims. Never replace it with a source-free reply.
- On verification_required, run verify_session for the returned sessions through the normal tool path, then retry post_reply with their current status. The lifecycle-research anchor is a host research request, not a stated memory source; do not use memory_remember to store file observations against it. The host admits verified familiarity findings after a verified, linked reply.
- On a wake turn, check persisted agent replies before reporting. A prior reply citing the same session with result_ready or accepted already delivered its result. If the wake adds no new finding, blocker, or user decision, finish quietly without post_reply or final reply text. A running-task acknowledgment does not deliver its later result.
- Verification passing does not mean the task is completed or accepted. Only persisted resultAcceptance makes a task accepted.
- Describe findings, remaining work and blockers in the reply body. Do not predict acceptance or claim automatic signing in prose; the host supplies the authoritative status.
- On status_claim_required or status_claim_mismatch, use the returned actual sessionStates and revise the explanation before retrying post_reply. Never repeat a rejected reply as final free text.`;

export function createProjectAgentPromptSource() {
  return {
    id: 'project-agent',
    layer: 'L1_AGENT',
    priority: 20,
    trust: 'runtime',
    observe(input = {}) {
      return { active: hasRole(input, 'project_agent') };
    },
    render(observation) {
      if (!observation?.active) return [];
      return [{
        id: 'project-agent',
        layer: 'L1_AGENT',
        priority: 20,
        title: 'Project agent rules',
        content: `${RULES}\n${INTERRUPT_RULES}\n${FAILURE_RULES}\n${STATUS_RULES}`,
        source: {
          id: 'project-agent',
          kind: 'project-agent-rules',
        },
        trust: 'runtime',
      }];
    },
  };
}
