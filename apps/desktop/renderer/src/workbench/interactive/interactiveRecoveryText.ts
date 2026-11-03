import { INTERACTIVE_RESULT_LIMITS as limits, type InteractiveContent, type InteractiveStateValues } from '@peer-agent/protocol';

/** Copyable human input, without storage keys or an execution-shaped payload. */
export function interactiveRecoveryText(content: InteractiveContent, state: { readonly values: InteractiveStateValues; readonly inputDrafts: Readonly<Record<string, string>> }, isZh: boolean) {
  const labels = new Map<string, string>(); let nodes = 0;
  function visit(raw: unknown, depth = 0) {
    if (!raw || typeof raw !== 'object' || ++nodes > limits.expandedNodes || depth > limits.expandedDepth) return;
    const node = raw as Record<string, unknown>, props = node.props as Record<string, unknown> | undefined;
    if (node.type !== 'element' || !props) return;
    if (typeof node.stateTarget === 'string' && typeof props.label === 'string' && props.label.length <= 160 && !labels.has(node.stateTarget)) labels.set(node.stateTarget, props.label);
    if (['Col', 'Row', 'Card'].includes(String(node.typeName)) && Array.isArray(props.children)) for (const child of props.children.slice(0, limits.expandedNodes)) visit(child, depth + 1);
  }
  visit(content.tree);
  return Object.keys(content.stateSchema).slice(0, limits.stateFields).map((key, index) => {
    const label = labels.get(key) ?? `${isZh ? '条件' : 'Condition'} ${index + 1}`;
    const raw = state.inputDrafts[key] ?? state.values[key];
    const value = typeof raw === 'boolean' ? raw ? (isZh ? '是' : 'Yes') : (isZh ? '否' : 'No') : String(raw);
    return `${label}: ${value}`;
  }).join('\n');
}
