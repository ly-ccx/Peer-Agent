// Shared workspace runtime Source.
export function renderRuntimeContext(workspacePath) {
  const lines = [];
  if (workspacePath) {
    lines.push(`Current workspace: ${workspacePath}`);
    lines.push('Prefer workspace-relative paths in user-facing answers when the path is inside this workspace.');
  }
  return lines.join('\n');
}

export function createRuntimePromptSource() {
  return {
    id: 'runtime.workspace',
    layer: 'L2_RUNTIME',
    priority: 0,
    trust: 'runtime',
    observe(input = {}) {
      return {
        workspacePath: input.workspacePath || null,
      };
    },
    render(observation) {
      const content = renderRuntimeContext(observation.workspacePath);
      if (!content) return [];
      return [{
        id: 'runtime.workspace',
        layer: 'L2_RUNTIME',
        priority: 0,
        title: 'Runtime workspace',
        content,
        source: { id: 'runtime.workspace', kind: 'runtime' },
        trust: 'runtime',
      }];
    },
  };
}
