const MODE_COPY = {
  chat: [
    'Mode: chat.',
    'Answer the user directly, and use tools only through structured tool calls when local evidence or local changes are needed.',
  ],
  compact: [
    'Mode: compact.',
    'Create or preserve continuity summaries only. Do not execute tools from compaction context.',
  ],
};

function normalizeMode(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'chat';
}

function normalizeEffort(value) {
  return ['low', 'default', 'high'].includes(value) ? value : 'default';
}

export function createModePromptSource() {
  return {
    id: 'runtime.mode',
    layer: 'L6_MODE_REMINDER',
    priority: 0,
    trust: 'runtime',
    observe(input = {}) {
      return {
        mode: normalizeMode(input.mode),
        effort: normalizeEffort(input.effort),
        provider: typeof input.provider === 'string' ? input.provider : null,
        model: typeof input.model === 'string' ? input.model : null,
      };
    },
    render(observation) {
      const includeMode = observation.mode !== 'chat';
      const includeEffort = observation.effort !== 'default';
      if (!includeMode && !includeEffort) return [];

      const lines = [
        ...(MODE_COPY[observation.mode] ?? [`Mode: ${observation.mode}.`]),
      ];
      if (includeEffort) {
        lines.push(`Reasoning effort: ${observation.effort}.`);
      }
      if (observation.provider || observation.model) {
        lines.push(`Provider target: ${[observation.provider, observation.model].filter(Boolean).join(' / ')}.`);
      }

      return [{
        id: 'runtime.mode',
        layer: 'L6_MODE_REMINDER',
        priority: 0,
        title: 'Mode reminder',
        content: lines.join('\n'),
        source: {
          id: 'runtime.mode',
          kind: 'runtime-mode',
          mode: observation.mode,
          effort: observation.effort,
          provider: observation.provider,
          model: observation.model,
        },
        trust: 'runtime',
      }];
    },
  };
}
