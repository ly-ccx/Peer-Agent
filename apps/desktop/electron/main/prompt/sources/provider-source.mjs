const PROVIDER_RULES = {
  openai: [
    'Provider family: OpenAI-compatible chat.',
    'Use native function tool calls when a tool is needed. Do not write textual [Tool call] or [Tool result] claims.',
  ],
  anthropic: [
    'Provider family: Anthropic-compatible messages.',
    'Use native tool_use blocks when a tool is needed. Do not write textual [Tool call] or [Tool result] claims.',
  ],
  qoder: [
    'Provider family: Qoder private API.',
    'Use native function tool calls when a tool is needed. Do not print tool-call markup or provider wire-format details as text.',
    'Do not write textual [Tool call] or [Tool result] claims.',
  ],
};

function normalizeProvider(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeModel(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createProviderPromptSource() {
  return {
    id: 'runtime.provider',
    layer: 'L2_RUNTIME',
    priority: 10,
    trust: 'runtime',
    observe(input = {}) {
      return {
        provider: normalizeProvider(input.provider),
        model: normalizeModel(input.model),
      };
    },
    render(observation) {
      if (!observation.provider && !observation.model) return [];

      const rules = PROVIDER_RULES[observation.provider] ?? [
        `Provider family: ${observation.provider || 'unknown'}.`,
        'Use only structured tool calls exposed by the runtime. Do not write textual [Tool call] or [Tool result] claims.',
      ];
      const lines = [
        `Provider target: ${[observation.provider, observation.model].filter(Boolean).join(' / ')}.`,
        ...rules,
        'Provider-specific request formatting is handled by the runtime encoder; do not describe provider wire-format details in the answer.',
      ];

      return [{
        id: 'runtime.provider',
        layer: 'L2_RUNTIME',
        priority: 10,
        title: 'Provider target',
        content: lines.join('\n'),
        source: {
          id: 'runtime.provider',
          kind: 'provider-selection',
          provider: observation.provider,
          model: observation.model,
        },
        trust: 'runtime',
      }];
    },
  };
}
