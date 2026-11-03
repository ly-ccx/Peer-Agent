export { validateState } from './index.js';
import type { InteractiveContent, InteractiveStateSchema, InteractiveStateValues } from '@peer-agent/protocol';
export function validateValues(values: InteractiveStateValues, schema: InteractiveStateSchema): InteractiveStateValues;
/** Shape/budget validation for unsaved memory only. Does not admit persistence or computation. */
export function validateEditingState(values: InteractiveStateValues, schema: InteractiveStateSchema, drafts?: Readonly<Record<string, string>>): { values: InteractiveStateValues; inputDrafts: Readonly<Record<string, string>> };
export function projectStateText(content: InteractiveContent, state: { readonly values: InteractiveStateValues; readonly inputDrafts?: Readonly<Record<string, string>> }, options?: { readonly fields?: readonly string[]; readonly isZh?: boolean }): string;
