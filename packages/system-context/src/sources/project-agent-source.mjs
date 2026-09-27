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
        content: `${RULES}\n${INTERRUPT_RULES}`,
        source: {
          id: 'project-agent',
          kind: 'project-agent-rules',
        },
        trust: 'runtime',
      }];
    },
  };
}
