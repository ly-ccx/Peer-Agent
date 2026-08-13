function normalizeLinkedFolders(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const folders = [];
  for (const item of value) {
    const path = typeof item === 'string' ? item : item?.path;
    if (typeof path !== 'string' || !path.trim() || seen.has(path)) continue;
    seen.add(path);
    folders.push(path);
  }
  return folders;
}

// Shared workspace runtime Source.
export function renderRuntimeContext(workspacePath, options = {}) {
  const lines = [];
  if (workspacePath) {
    lines.push(`Current workspace: ${workspacePath}`);
    lines.push('Prefer workspace-relative paths in user-facing answers when the path is inside this workspace.');
  }
  const linkedFolders = normalizeLinkedFolders(options.linkedFolders)
    .filter((path) => path !== workspacePath);
  if (linkedFolders.length > 0) {
    lines.push('Project additional source folders (readable):');
    for (const folder of linkedFolders) {
      lines.push(`- ${folder}`);
    }
    lines.push('Write, edit, and default command cwd stay in the current workspace unless a Goal target or an explicit path says otherwise.');
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
        linkedFolders: normalizeLinkedFolders(input.linkedFolders),
      };
    },
    render(observation) {
      const content = renderRuntimeContext(observation.workspacePath, {
        linkedFolders: observation.linkedFolders,
      });
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
