// 项目代理工作规则。只在 role === 'project_agent' 时进入 L1。
// 规则正文在资源文件里；名册、记忆和快照不从这里进入。
import { hasRole, readResource } from './project-context.mjs';

const RULES = readResource(new URL('./resources/project-agent-rules.md', import.meta.url));

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
        content: RULES,
        source: {
          id: 'project-agent',
          kind: 'project-agent-rules',
        },
        trust: 'runtime',
      }];
    },
  };
}
