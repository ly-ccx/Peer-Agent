import type { InteractiveContent, InteractiveStateValues } from '@peer-agent/protocol';
import { projectStateText } from '@peer-agent/interactive-content/state';

/** Copyable human input, without storage keys or an execution-shaped payload. */
export function interactiveRecoveryText(content: InteractiveContent, state: { readonly values: InteractiveStateValues; readonly inputDrafts: Readonly<Record<string, string>> }, isZh: boolean) {
  return projectStateText(content, state, { isZh });
}
