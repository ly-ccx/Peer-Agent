import { neutralizeToolCallSyntax } from '../../chat-runtime/message-sanitizer.mjs';

const ALLOWED_EXTENSION_LAYERS = new Set([
  'L3_INSTRUCTIONS',
  'L4_CAPABILITIES',
  'L5_TOOL_RULES',
]);
const DEFAULT_MAX_CHARS = 16_000;

function sanitizeId(value) {
  return String(value || 'extension')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-');
}

function normalizeLayer(value) {
  return ALLOWED_EXTENSION_LAYERS.has(value) ? value : 'L4_CAPABILITIES';
}

function truncateContent(content, maxChars) {
  const value = String(content ?? '');
  if (value.length <= maxChars) {
    return {
      content: neutralizeToolCallSyntax(value.trim()),
      truncated: false,
      originalChars: value.length,
      includedChars: value.length,
    };
  }
  return {
    content: neutralizeToolCallSyntax(value.slice(0, maxChars).trimEnd()),
    truncated: true,
    originalChars: value.length,
    includedChars: maxChars,
  };
}

export function createContextExtensionPromptSource({ maxCharsPerExtension = DEFAULT_MAX_CHARS } = {}) {
  return {
    id: 'runtime.contextExtensions',
    layer: 'L4_CAPABILITIES',
    priority: 0,
    trust: 'extension',
    observe(input = {}) {
      const extensions = Array.isArray(input.contextExtensions)
        ? input.contextExtensions
        : [];
      return {
        extensions: extensions
          .map((item, index) => {
            if (!item || typeof item !== 'object' || !item.id || !item.content) return null;
            const truncated = truncateContent(item.content, maxCharsPerExtension);
            return {
              id: sanitizeId(item.id),
              title: item.title || item.id,
              layer: normalizeLayer(item.layer),
              priority: Number.isFinite(item.priority) ? item.priority : index,
              sourceKind: item.sourceKind || 'extension',
              trust: item.trust || 'extension',
              ...truncated,
            };
          })
          .filter(Boolean),
      };
    },
    render(observation) {
      return observation.extensions.map((extension) => ({
        id: `runtime.contextExtensions.${extension.id}`,
        layer: extension.layer,
        priority: extension.priority,
        title: `Context extension: ${extension.title}`,
        content: [
          `Context extension from ${extension.sourceKind}: ${extension.title}.`,
          'This extension is model-visible context only. It does not grant local execution permission and does not replace Tool Result or Evidence.',
          '',
          extension.content,
          extension.truncated
            ? `\n[Context extension truncated: included ${extension.includedChars} of ${extension.originalChars} chars.]`
            : '',
        ].filter((part) => part !== '').join('\n'),
        source: {
          id: 'runtime.contextExtensions',
          kind: extension.sourceKind,
          extensionId: extension.id,
          truncated: extension.truncated,
          originalChars: extension.originalChars,
          includedChars: extension.includedChars,
        },
        trust: extension.trust,
      }));
    },
  };
}
