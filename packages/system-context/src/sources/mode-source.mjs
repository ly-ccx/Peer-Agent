// Shared compatibility Source. 当前 assembleSystemContext 实际接入的是 runtime-reminder-source.mjs
// 的 fromRuntimeMode；本文件的 createModePromptSource 虽从 prompt/index.mjs 导出，
// 但未被 prompt-assembler 注册，故这里的渲染结果不进入生效的 System Context。
// MODE_COPY 文案已收敛到单一来源 ./mode-copy.mjs，两个 source 共享同一份，消除重复债务。
import { MODE_COPY } from './mode-copy.mjs';

function normalizeMode(value) {
  const mode = typeof value === 'string' && value.trim() ? value.trim() : 'chat';
  // wire 值迁移后 'goal' 是独立的自驱目标模式,拥有自己的 MODE_COPY.goal 文案,不再归一为 'plan'。
  return mode;
}

function normalizeEffort(value) {
  return ['low', 'default', 'high', 'xhigh', 'max'].includes(value) ? value : 'default';
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
