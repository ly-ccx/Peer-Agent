import { MODE_COPY } from './mode-copy.mjs';

// Shared mode and runtime reminder Source.
const ALLOWED_REMINDER_LAYERS = new Set([
  'L2_RUNTIME',
  'L5_TOOL_RULES',
  'L6_MODE_REMINDER',
  'L7_CONTINUITY',
]);

function sanitizeId(value) {
  return String(value || 'reminder')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-');
}

function normalizeMode(value) {
  const mode = typeof value === 'string' && value.trim() ? value.trim() : 'chat';
  // wire 值迁移后 'goal' 是独立的自驱目标模式,拥有自己的 MODE_COPY.goal 文案,不再归一为 'plan'。
  // 存量历史 'goal'（旧 plan 语义）已由 conversation-store 一次性迁移改写为 'plan',不会到达此处。
  return mode;
}

function normalizeEffort(value) {
  return ['low', 'default', 'high', 'xhigh', 'max'].includes(value) ? value : 'default';
}

function normalizeLayer(value, fallback = 'L6_MODE_REMINDER') {
  return ALLOWED_REMINDER_LAYERS.has(value) ? value : fallback;
}

function fromRuntimeMode(input = {}) {
  const mode = normalizeMode(input.mode);
  const effort = normalizeEffort(input.effort);
  const includeMode = mode !== 'chat';
  const includeEffort = effort !== 'default';
  if (!includeMode && !includeEffort) return null;

  const lines = [
    ...(MODE_COPY[mode] ?? [`Mode: ${mode}.`]),
  ];
  if (includeEffort) {
    lines.push(`Reasoning effort: ${effort}.`);
  }
  if (input.provider || input.model) {
    lines.push(`Provider target: ${[input.provider, input.model].filter(Boolean).join(' / ')}.`);
  }

  return {
    id: 'mode',
    title: 'Mode reminder',
    content: lines.join('\n'),
    kind: 'mode',
    scope: 'turn',
    layer: 'L6_MODE_REMINDER',
    priority: 0,
    sourceKind: 'runtime',
    trust: 'runtime',
    mode,
    effort,
    provider: typeof input.provider === 'string' ? input.provider : null,
    model: typeof input.model === 'string' ? input.model : null,
    legacySectionId: 'runtime.mode',
  };
}

function normalizeReminder(item, index) {
  if (!item || typeof item !== 'object' || !item.id || !item.content) return null;
  const id = sanitizeId(item.id);
  return {
    id,
    title: typeof item.title === 'string' && item.title ? item.title : id,
    content: String(item.content).trim(),
    kind: typeof item.kind === 'string' && item.kind ? item.kind : 'runtime',
    scope: typeof item.scope === 'string' && item.scope ? item.scope : 'turn',
    layer: normalizeLayer(item.layer),
    priority: Number.isFinite(item.priority) ? item.priority : index + 10,
    sourceKind: typeof item.sourceKind === 'string' && item.sourceKind ? item.sourceKind : 'runtime',
    trust: typeof item.trust === 'string' && item.trust ? item.trust : 'runtime',
  };
}

export function createRuntimeReminderPromptSource() {
  return {
    id: 'runtime.reminders',
    layer: 'L6_MODE_REMINDER',
    priority: 0,
    trust: 'runtime',
    observe(input = {}) {
      const explicit = Array.isArray(input.runtimeReminders)
        ? input.runtimeReminders.map(normalizeReminder).filter(Boolean)
        : [];
      const modeReminder = fromRuntimeMode(input);
      return {
        reminders: [
          ...(modeReminder ? [modeReminder] : []),
          ...explicit,
        ],
      };
    },
    render(observation) {
      return observation.reminders.map((reminder) => {
        const sectionId = reminder.legacySectionId ?? `runtime.reminders.${reminder.id}`;
        return {
          id: sectionId,
          layer: reminder.layer,
          priority: reminder.priority,
          title: reminder.title,
          content: [
            `Runtime reminder (${reminder.kind}, scope=${reminder.scope}).`,
            'This reminder is system context for the current runtime state. It does not replace Tool Result or Evidence.',
            '',
            reminder.content,
          ].join('\n'),
          source: {
            id: 'runtime.reminders',
            kind: reminder.kind,
            reminderId: reminder.id,
            scope: reminder.scope,
            sourceKind: reminder.sourceKind,
            mode: reminder.mode,
            effort: reminder.effort,
            provider: reminder.provider,
            model: reminder.model,
          },
          trust: reminder.trust,
        };
      });
    },
  };
}
